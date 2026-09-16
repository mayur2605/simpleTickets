/**
 * D1 access. Kept apart from the mail transport and the business rules so each
 * can be reasoned about — and replaced — on its own.
 */

export interface Checkpoint {
  uidValidity: string;
  lastUid: number;
}

export async function readCheckpoint(db: D1Database): Promise<Checkpoint | null> {
  const row = await db
    .prepare("SELECT uid_validity, last_uid FROM mailbox_state WHERE id = 1")
    .first<{ uid_validity: string; last_uid: number }>();
  if (row === null) return null;
  return { uidValidity: row.uid_validity, lastUid: row.last_uid };
}

export async function writeCheckpoint(db: D1Database, checkpoint: Checkpoint): Promise<void> {
  await db
    .prepare(
      `INSERT INTO mailbox_state (id, uid_validity, last_uid, updated_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         uid_validity = excluded.uid_validity,
         last_uid     = excluded.last_uid,
         updated_at   = excluded.updated_at`,
    )
    .bind(checkpoint.uidValidity, checkpoint.lastUid, new Date().toISOString())
    .run();
}

/** True when this UID has already been dealt with, on any earlier run. */
export async function alreadyIngested(db: D1Database, uid: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS present FROM ingest_log WHERE uid = ?")
    .bind(uid)
    .first<{ present: number }>();
  return row !== null;
}

export interface NewTicket {
  uid: number;
  subject: string;
  requester: string;
  body: string;
  messageId: string | null;
}

/**
 * Create a ticket and its first message, and record the UID as handled.
 *
 * Written as one batch so the three statements commit together: a ticket
 * without its message, or a ticket the log does not know about, would both
 * cause duplicates on the next run. D1 batches are transactional.
 */
export async function createTicket(
  db: D1Database,
  input: NewTicket,
  intentFor?: (ticketId: number) => NewIntent,
): Promise<number> {
  const now = new Date().toISOString();
  const ticket = await db
    .prepare(
      `INSERT INTO tickets (subject, requester, status, priority, created_at, updated_at)
       VALUES (?, ?, 'New', 'Normal', ?, ?) RETURNING id`,
    )
    .bind(input.subject, input.requester, now, now)
    .first<{ id: number }>();
  if (ticket === null) throw new Error("Ticket insert returned no id.");

  const statements = [
    db
      .prepare(
        `INSERT INTO messages (ticket_id, direction, author, body, message_id, created_at)
         VALUES (?, 'inbound', ?, ?, ?, ?)`,
      )
      .bind(ticket.id, input.requester, input.body, input.messageId, now),
    db
      .prepare(`INSERT INTO ingest_log (uid, outcome, ticket_id, at) VALUES (?, 'ticket', ?, ?)`)
      .bind(input.uid, ticket.id, now),
  ];

  // The acknowledgement is queued in the SAME batch as the log entry. If it
  // were enqueued afterwards, a crash in between would leave a ticket that
  // ingest_log calls done and that nothing will ever acknowledge - the employee
  // would hear nothing and no retry would notice.
  if (intentFor !== undefined) {
    const intent = intentFor(ticket.id);
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO outbox
             (ticket_id, intent, recipient, message_id, payload, state,
              attempts, next_attempt_at, pending_status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
        )
        .bind(
          intent.ticketId,
          intent.intent,
          intent.recipient,
          intent.messageId,
          intent.payload,
          now,
          intent.pendingStatus ?? null,
          now,
          now,
        ),
    );
  }

  await db.batch(statements);
  return ticket.id;
}

/** Record a UID we deliberately did not turn into a ticket. */
export async function recordSkip(
  db: D1Database,
  uid: number,
  outcome: "rejected_sender" | "auto_reply" | "bounce" | "error",
  detail: string,
): Promise<void> {
  await db
    .prepare(`INSERT OR IGNORE INTO ingest_log (uid, outcome, detail, at) VALUES (?, ?, ?, ?)`)
    .bind(uid, outcome, detail.slice(0, 500), new Date().toISOString())
    .run();
}

/* ------------------------------------------------------------------ outbox */

export type OutboxIntent = "acknowledgement" | "reply" | "resolution" | "closure" | "notification";

export interface NewIntent {
  ticketId: number;
  intent: OutboxIntent;
  recipient: string;
  /** Our Message-ID. Unique in the table, and the idempotency key. */
  messageId: string;
  /** Serialised OutgoingMessage. */
  payload: string;
  /** R28: status to apply when, and only when, the server accepts this. */
  pendingStatus?: string;
}

export interface DueIntent {
  id: number;
  ticketId: number;
  intent: OutboxIntent;
  recipient: string;
  messageId: string;
  payload: string;
  attempts: number;
  pendingStatus: string | null;
}

/**
 * Enqueue an intent. INSERT OR IGNORE against the unique message_id makes this
 * safe to call repeatedly: a retried ingestion run re-enqueues nothing, so the
 * employee cannot receive two acknowledgements for one email.
 */
export async function enqueueIntent(db: D1Database, input: NewIntent): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT OR IGNORE INTO outbox
         (ticket_id, intent, recipient, message_id, payload, state,
          attempts, next_attempt_at, pending_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
    )
    .bind(
      input.ticketId,
      input.intent,
      input.recipient,
      input.messageId,
      input.payload,
      now,
      input.pendingStatus ?? null,
      now,
      now,
    )
    .run();
}

/**
 * Claim one due intent for sending.
 *
 * The UPDATE is a compare-and-swap: it only matches a row still in 'pending',
 * and `meta.changes` says whether we won. Without that, two overlapping runs
 * could both read the same pending row and both put it on the wire. D1 has no
 * SELECT ... FOR UPDATE, so the conditional write is the lock.
 *
 * Returns null when nothing is due or another run claimed it first.
 */
export async function claimNextIntent(db: D1Database, now: Date): Promise<DueIntent | null> {
  const iso = now.toISOString();
  const candidate = await db
    .prepare(
      `SELECT id, ticket_id, intent, recipient, message_id, payload, attempts, pending_status
         FROM outbox
        WHERE state = 'pending' AND next_attempt_at <= ?
        ORDER BY next_attempt_at
        LIMIT 1`,
    )
    .bind(iso)
    .first<{
      id: number;
      ticket_id: number;
      intent: OutboxIntent;
      recipient: string;
      message_id: string;
      payload: string;
      attempts: number;
      pending_status: string | null;
    }>();
  if (candidate === null) return null;

  const claim = await db
    .prepare(
      `UPDATE outbox
          SET state = 'sending', sending_since = ?, attempts = attempts + 1, updated_at = ?
        WHERE id = ? AND state = 'pending'`,
    )
    .bind(iso, iso, candidate.id)
    .run();
  if (claim.meta.changes === 0) return null;

  return {
    id: candidate.id,
    ticketId: candidate.ticket_id,
    intent: candidate.intent,
    recipient: candidate.recipient,
    messageId: candidate.message_id,
    payload: candidate.payload,
    attempts: candidate.attempts + 1,
    pendingStatus: candidate.pending_status,
  };
}

/**
 * Record that the server accepted the message, applying any status transition
 * that was waiting on it in the same batch (R28). The transition and the
 * acceptance record commit together or not at all - a ticket must never show a
 * status whose required email was not accepted.
 */
export async function recordAcceptance(
  db: D1Database,
  id: number,
  ticketId: number,
  acceptedAt: string,
  reply: string,
  pendingStatus: string | null,
): Promise<void> {
  const statements = [
    db
      .prepare(
        `UPDATE outbox
            SET state = 'accepted', accepted_at = ?, smtp_reply = ?,
                sending_since = NULL, updated_at = ?
          WHERE id = ?`,
      )
      .bind(acceptedAt, reply.slice(0, 500), acceptedAt, id),
  ];
  if (pendingStatus !== null) {
    statements.push(
      db
        .prepare(`UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?`)
        .bind(pendingStatus, acceptedAt, ticketId),
    );
  }
  await db.batch(statements);
}

/**
 * Record a failed attempt. A permanent rejection stops immediately; a transient
 * one waits out the backoff and tries again until attempts are exhausted, at
 * which point it becomes visible to IT rather than disappearing.
 */
export async function recordSendFailure(
  db: D1Database,
  id: number,
  nextState: "pending" | "failed",
  nextAttempt: string,
  detail: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE outbox
          SET state = ?, next_attempt_at = ?, last_error = ?,
              sending_since = NULL, updated_at = ?
        WHERE id = ?`,
    )
    .bind(nextState, nextAttempt, detail.slice(0, 500), now, id)
    .run();
}

/**
 * Park a row whose outcome we genuinely do not know: the message was written
 * and the server's answer never arrived. Never resolved automatically - IT
 * decides, because resending risks a duplicate to a real person and dropping it
 * risks silence (PRD open point 4).
 */
export async function markAmbiguous(db: D1Database, id: number): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE outbox SET state = 'ambiguous', updated_at = ? WHERE id = ? AND state = 'sending'`,
    )
    .bind(now, id)
    .run();
}

/**
 * Park every send that has been in flight longer than the timeout. Their
 * outcome is genuinely unknown - the message was written and the reply never
 * arrived - so they become visible to IT rather than being resent or dropped.
 * Returns how many were parked.
 */
export async function sweepStaleSending(
  db: D1Database,
  now: Date,
  timeoutMs: number,
): Promise<number> {
  const cutoff = new Date(now.getTime() - timeoutMs).toISOString();
  const result = await db
    .prepare(
      `UPDATE outbox SET state = 'ambiguous', updated_at = ?
        WHERE state = 'sending' AND sending_since IS NOT NULL AND sending_since <= ?`,
    )
    .bind(now.toISOString(), cutoff)
    .run();
  return result.meta.changes;
}

/* --------------------------------------------------------------- threading */

/**
 * Find the ticket an inbound reply belongs to, by Message-ID.
 *
 * Candidates are tried in order, so the closest relative wins. Both sides of
 * the conversation are searched: `messages` holds what employees sent us, and
 * `outbox` holds what we sent them - a reply to our own acknowledgement quotes
 * the acknowledgement's Message-ID, which appears nowhere else.
 *
 * Returns null when nothing matches, which means this email starts a ticket.
 */
export async function findTicketByMessageIds(
  db: D1Database,
  candidates: string[],
): Promise<number | null> {
  for (const candidate of candidates) {
    const hit = await db
      .prepare(
        `SELECT ticket_id FROM messages WHERE message_id = ?
          UNION ALL
         SELECT ticket_id FROM outbox   WHERE message_id = ?
          LIMIT 1`,
      )
      .bind(candidate, candidate)
      .first<{ ticket_id: number }>();
    if (hit !== null) return hit.ticket_id;
  }
  return null;
}

/**
 * Append an inbound reply to an existing ticket.
 *
 * Message and log entry go in one batch, for the same reason ticket creation
 * does: a message the log does not know about would be ingested again.
 *
 * A reply reopens a Resolved or Closed ticket (T011). Deadlines are deliberately
 * left alone - the specification is explicit that a reply must not postpone an
 * existing pending deadline.
 */
export async function appendReply(
  db: D1Database,
  input: { ticketId: number; uid: number; author: string; body: string; messageId: string | null },
): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO messages (ticket_id, direction, author, body, message_id, created_at)
         VALUES (?, 'inbound', ?, ?, ?, ?)`,
      )
      .bind(input.ticketId, input.author, input.body, input.messageId, now),
    db
      .prepare(`INSERT INTO ingest_log (uid, outcome, ticket_id, at) VALUES (?, 'ticket', ?, ?)`)
      .bind(input.uid, input.ticketId, now),
    db
      .prepare(
        `UPDATE tickets SET status = 'In Progress', updated_at = ?
          WHERE id = ? AND status IN ('Resolved', 'Closed')`,
      )
      .bind(now, input.ticketId),
  ]);
}

/**
 * Record that a delivered message bounced (R15).
 *
 * Matched back to the outbox row by the Message-IDs the delivery report quotes.
 * The row is marked 'bounced' rather than 'failed': it WAS accepted by the
 * server, and the distinction matters because R28 anchors the auto-close clock
 * to that acceptance and requires a later bounce to pause it.
 *
 * Returns the ticket the bounce belongs to, or null if it matched nothing.
 */
export async function recordBounce(db: D1Database, candidates: string[]): Promise<number | null> {
  for (const candidate of candidates) {
    const hit = await db
      .prepare(`SELECT id, ticket_id FROM outbox WHERE message_id = ? LIMIT 1`)
      .bind(candidate)
      .first<{ id: number; ticket_id: number }>();
    if (hit === null) continue;
    await db
      .prepare(`UPDATE outbox SET state = 'bounced', updated_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), hit.id)
      .run();
    return hit.ticket_id;
  }
  return null;
}

/**
 * Outbox counts by state, for the operator view (T013: pending and
 * bounce-paused states must be visible to IT). States with no rows are
 * reported as zero rather than omitted, so a disappearing key cannot be
 * mistaken for a healthy queue.
 */
export async function outboxSummary(db: D1Database): Promise<Record<string, number>> {
  const rows = await db
    .prepare(`SELECT state, COUNT(*) AS count FROM outbox GROUP BY state`)
    .all<{ state: string; count: number }>();
  const summary: Record<string, number> = {
    pending: 0,
    sending: 0,
    accepted: 0,
    failed: 0,
    ambiguous: 0,
    bounced: 0,
  };
  for (const row of rows.results) {
    summary[row.state] = row.count;
  }
  return summary;
}
