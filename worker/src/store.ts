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
  /** Chosen assignee, or null when nobody is available (R07). */
  owner: string | null;
  /** ISO timestamp for the first-response deadline (R03). */
  responseDue: string;
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
      `INSERT INTO tickets (subject, requester, status, priority, owner, response_due, created_at, updated_at)
       VALUES (?, ?, 'New', 'Normal', ?, ?, ?, ?) RETURNING id`,
    )
    .bind(input.subject, input.requester, input.owner, input.responseDue, now, now)
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
    // Always bump updated_at: the queue is ordered by it, so a ticket with a
    // new employee reply must rise to the top. Bumping only on reopen made the
    // tickets most needing attention sink below untouched ones.
    db.prepare(`UPDATE tickets SET updated_at = ? WHERE id = ?`).bind(now, input.ticketId),
    // Reopening is separate, and only applies to a ticket that was closed out.
    db
      .prepare(
        `UPDATE tickets SET status = 'In Progress'
          WHERE id = ? AND status IN ('Resolved', 'Closed')`,
      )
      .bind(input.ticketId),
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

/* ------------------------------------------------------------- dashboard */

export interface TicketRow {
  id: number;
  subject: string;
  requester: string;
  status: string;
  priority: string;
  owner: string | null;
  response_due: string | null;
  /**
   * Earliest outbound message. The automatic acknowledgement is never written
   * to `messages`, so this can only be a real reply from IT - which is what
   * R28 requires to satisfy a response deadline.
   */
  first_response_at: string | null;
  created_at: string;
  updated_at: string;
  messages: number;
}

/** Newest first, which is the order IT works in. */
export async function listTickets(db: D1Database, limit = 100): Promise<TicketRow[]> {
  const rows = await db
    .prepare(
      `SELECT t.id, t.subject, t.requester, t.status, t.priority, t.owner,
              t.response_due, t.created_at, t.updated_at,
              (SELECT MIN(m.created_at) FROM messages m
                WHERE m.ticket_id = t.id AND m.direction = 'outbound') AS first_response_at,
              (SELECT COUNT(*) FROM messages m WHERE m.ticket_id = t.id) AS messages
         FROM tickets t
        ORDER BY t.updated_at DESC, t.id DESC
        LIMIT ?`,
    )
    .bind(limit)
    .all<TicketRow>();
  return rows.results;
}

export interface TicketDetail {
  ticket: TicketRow;
  messages: {
    id: number;
    direction: string;
    author: string;
    body: string;
    message_id: string | null;
    created_at: string;
  }[];
}

export async function getTicket(db: D1Database, id: number): Promise<TicketDetail | null> {
  const ticket = await db
    .prepare(
      `SELECT t.id, t.subject, t.requester, t.status, t.priority, t.owner,
              t.response_due, t.created_at, t.updated_at,
              (SELECT MIN(m.created_at) FROM messages m
                WHERE m.ticket_id = t.id AND m.direction = 'outbound') AS first_response_at,
              (SELECT COUNT(*) FROM messages m WHERE m.ticket_id = t.id) AS messages
         FROM tickets t WHERE t.id = ?`,
    )
    .bind(id)
    .first<TicketRow>();
  if (ticket === null) return null;

  const messages = await db
    .prepare(
      `SELECT id, direction, author, body, message_id, created_at
         FROM messages WHERE ticket_id = ? ORDER BY id`,
    )
    .bind(id)
    .all<TicketDetail["messages"][number]>();

  return { ticket, messages: messages.results };
}

/**
 * Message-IDs on a ticket's thread, oldest first, so a reply can be threaded
 * into the employee's existing conversation. Includes what we have sent as well
 * as what we received - the employee's client may be replying to either.
 */
export async function threadIds(db: D1Database, ticketId: number): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT message_id AS id, created_at FROM messages
         WHERE ticket_id = ? AND message_id IS NOT NULL AND direction != 'note'
        UNION ALL
       SELECT message_id AS id, created_at FROM outbox WHERE ticket_id = ?
        ORDER BY created_at`,
    )
    .bind(ticketId, ticketId)
    .all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

/**
 * Record a public reply and queue it for delivery, in one batch.
 *
 * The visible message and the outgoing intent commit together: a reply shown in
 * the dashboard that was never queued would have IT believing they answered.
 */
export async function addReply(
  db: D1Database,
  input: {
    ticketId: number;
    author: string;
    body: string;
    messageId: string;
    recipient: string;
    payload: string;
    intent?: OutboxIntent;
    /** R28: applied only when the server accepts this message. */
    pendingStatus?: string;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO messages (ticket_id, direction, author, body, message_id, created_at)
         VALUES (?, 'outbound', ?, ?, ?, ?)`,
      )
      .bind(input.ticketId, input.author, input.body, input.messageId, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO outbox
           (ticket_id, intent, recipient, message_id, payload, state,
            attempts, next_attempt_at, pending_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
      )
      .bind(
        input.ticketId,
        input.intent ?? "reply",
        input.recipient,
        input.messageId,
        input.payload,
        now,
        input.pendingStatus ?? null,
        now,
        now,
      ),
    db.prepare(`UPDATE tickets SET updated_at = ? WHERE id = ?`).bind(now, input.ticketId),
  ]);
}

/**
 * Record an internal note.
 *
 * Writes to `messages` only. There is deliberately NO outbox statement here and
 * no code path from a note to an OutgoingMessage: the constitution forbids an
 * internal note reaching employee email, and the safest guarantee is that the
 * sending machinery can never be handed one.
 */
export async function addNote(
  db: D1Database,
  ticketId: number,
  author: string,
  body: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO messages (ticket_id, direction, author, body, message_id, created_at)
         VALUES (?, 'note', ?, ?, NULL, ?)`,
      )
      .bind(ticketId, author, body, now),
    db.prepare(`UPDATE tickets SET updated_at = ? WHERE id = ?`).bind(now, ticketId),
  ]);
}

/* ----------------------------------------------------------------- staff */

export interface StaffRow {
  name: string;
  email: string | null;
  available: number;
  openTickets: number;
}

/**
 * Staff with their current open-ticket counts.
 *
 * "Open" is New, In Progress and Waiting for Employee. Resolved and Closed are
 * excluded: counting finished work would permanently penalise whoever has been
 * here longest and starve them of new tickets.
 */
export async function staffWorkloads(db: D1Database): Promise<StaffRow[]> {
  const rows = await db
    .prepare(
      `SELECT s.name, s.email, s.available,
              (SELECT COUNT(*) FROM tickets t
                WHERE t.owner = s.name
                  AND t.status IN ('New', 'In Progress', 'Waiting for Employee')
              ) AS openTickets
         FROM staff s ORDER BY s.name`,
    )
    .all<StaffRow>();
  return rows.results;
}

/** Who received the most recent assignment, for round-robin rotation. */
export async function lastAssignee(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare(`SELECT owner FROM tickets WHERE owner IS NOT NULL ORDER BY id DESC LIMIT 1`)
    .first<{ owner: string }>();
  return row?.owner ?? null;
}

export async function addStaff(db: D1Database, name: string, email: string | null): Promise<void> {
  await db
    .prepare(`INSERT OR IGNORE INTO staff (name, email, available, created_at) VALUES (?, ?, 1, ?)`)
    .bind(name, email, new Date().toISOString())
    .run();
}

export async function setAvailability(
  db: D1Database,
  name: string,
  available: boolean,
): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE staff SET available = ? WHERE name = ?`)
    .bind(available ? 1 : 0, name)
    .run();
  return result.meta.changes > 0;
}

/** Apply a status that needs no email (R09). */
export async function setStatus(db: D1Database, id: number, status: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(`UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?`)
    .bind(status, now, id)
    .run();
}

/* ------------------------------------------------------------------ auth */

export interface StaffAccount {
  name: string;
  password_hash: string | null;
  is_admin: number;
  available: number;
}

export async function findStaff(db: D1Database, name: string): Promise<StaffAccount | null> {
  return db
    .prepare(`SELECT name, password_hash, is_admin, available FROM staff WHERE name = ?`)
    .bind(name)
    .first<StaffAccount>();
}

export async function setPasswordHash(
  db: D1Database,
  name: string,
  hash: string,
): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE staff SET password_hash = ? WHERE name = ?`)
    .bind(hash, name)
    .run();
  return result.meta.changes > 0;
}

/**
 * Start a session and, in the same batch, clear this account's failure count
 * and sweep expired rows. A successful sign-in should not leave an old failure
 * streak that locks the account out a minute later.
 */
export async function createSession(
  db: D1Database,
  tokenHash: string,
  staffName: string,
  expiresAt: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO sessions (token_hash, staff_name, created_at, expires_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(tokenHash, staffName, now, expiresAt),
    db.prepare(`DELETE FROM login_failures WHERE staff_name = ?`).bind(staffName),
    db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).bind(now),
  ]);
}

export interface SessionRow {
  staff_name: string;
  expires_at: string;
  is_admin: number;
}

export async function findSession(db: D1Database, tokenHash: string): Promise<SessionRow | null> {
  return db
    .prepare(
      `SELECT s.staff_name, s.expires_at, st.is_admin
         FROM sessions s JOIN staff st ON st.name = s.staff_name
        WHERE s.token_hash = ?`,
    )
    .bind(tokenHash)
    .first<SessionRow>();
}

export async function deleteSession(db: D1Database, tokenHash: string): Promise<void> {
  await db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(tokenHash).run();
}

export async function recordLoginFailure(db: D1Database, name: string): Promise<void> {
  await db
    .prepare(`INSERT INTO login_failures (staff_name, at) VALUES (?, ?)`)
    .bind(name, new Date().toISOString())
    .run();
}

/** Failed attempts for this account since `since`. */
export async function recentFailures(db: D1Database, name: string, since: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS failures FROM login_failures WHERE staff_name = ? AND at > ?`)
    .bind(name, since)
    .first<{ failures: number }>();
  return row?.failures ?? 0;
}
