/**
 * PostgreSQL access. Kept apart from the mail transport and the business rules
 * so each can be reasoned about — and replaced — on its own.
 *
 * Two conventions worth knowing before editing:
 *
 *   Every camelCase column alias is double-quoted. Postgres folds unquoted
 *   identifiers to lower case, so `AS openTickets` silently arrives as
 *   `opentickets` and the property reads undefined.
 *
 *   Every COUNT is cast with `::int`. Postgres types count() as bigint and the
 *   driver returns bigint as a *string* to avoid losing precision, so an
 *   uncast count arrives as "3" and quietly fails every numeric comparison.
 */
import type { Pool } from "pg";
import { type Db, withTransaction } from "./db/pool.ts";
import type { StaffWorkload } from "./assignment.ts";

export interface Checkpoint {
  uidValidity: string;
  lastUid: number;
}

export async function readCheckpoint(db: Db): Promise<Checkpoint | null> {
  const { rows } = await db.query<{ uid_validity: string; last_uid: number }>(
    "SELECT uid_validity, last_uid FROM mailbox_state WHERE id = 1",
  );
  const row = rows[0];
  if (row === undefined) return null;
  return { uidValidity: row.uid_validity, lastUid: row.last_uid };
}

export async function writeCheckpoint(db: Db, checkpoint: Checkpoint): Promise<void> {
  await db.query(
    `INSERT INTO mailbox_state (id, uid_validity, last_uid, updated_at)
     VALUES (1, $1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET
       uid_validity = excluded.uid_validity,
       last_uid     = excluded.last_uid,
       updated_at   = excluded.updated_at`,
    [checkpoint.uidValidity, checkpoint.lastUid, new Date().toISOString()],
  );
}

/** True when this UID has already been dealt with, on any earlier run. */
export async function alreadyIngested(db: Db, uid: number): Promise<boolean> {
  const { rowCount } = await db.query("SELECT 1 FROM ingest_log WHERE uid = $1", [uid]);
  return rowCount !== 0;
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
  /** Path of the stored raw message, relative to STORAGE_DIR. */
  rawPath?: string | null;
}

/**
 * Create a ticket and its first message, and record the UID as handled.
 *
 * One transaction so the statements commit together: a ticket without its
 * message, or a ticket the log does not know about, would both cause duplicates
 * on the next run.
 */
export async function createTicket(
  pool: Pool,
  input: NewTicket,
  intentFor?: (ticketId: number) => NewIntent,
): Promise<number> {
  const now = new Date().toISOString();
  return withTransaction(pool, async (db) => {
    const ticket = await db.query<{ id: number }>(
      `INSERT INTO tickets (subject, requester, status, priority, owner, response_due, created_at, updated_at)
       VALUES ($1, $2, 'New', 'Normal', $3, $4, $5, $6) RETURNING id`,
      [input.subject, input.requester, input.owner, input.responseDue, now, now],
    );
    const created = ticket.rows[0];
    if (created === undefined) throw new Error("Ticket insert returned no id.");

    await db.query(
      `INSERT INTO messages (ticket_id, direction, author, body, message_id, created_at)
       VALUES ($1, 'inbound', $2, $3, $4, $5)`,
      [created.id, input.requester, input.body, input.messageId, now],
    );
    await db.query(
      `INSERT INTO ingest_log (uid, outcome, ticket_id, raw_path, at)
       VALUES ($1, 'ticket', $2, $3, $4)`,
      [input.uid, created.id, input.rawPath ?? null, now],
    );

    // The acknowledgement is queued in the SAME transaction as the log entry.
    // If it were enqueued afterwards, a crash in between would leave a ticket
    // ingest_log calls done and that nothing will ever acknowledge - the
    // employee would hear nothing and no retry would notice.
    if (intentFor !== undefined) {
      await insertIntent(db, intentFor(created.id), now);
    }
    return created.id;
  });
}

/** Record a UID we deliberately did not turn into a ticket. */
export async function recordSkip(
  db: Db,
  uid: number,
  outcome:
    | "rejected_sender"
    | "auto_reply"
    | "bounce"
    | "error"
    | "notification_reply"
    | "not_a_participant",
  detail: string,
): Promise<void> {
  await db.query(
    `INSERT INTO ingest_log (uid, outcome, detail, at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (uid) DO NOTHING`,
    [uid, outcome, detail.slice(0, 500), new Date().toISOString()],
  );
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
 * ON CONFLICT DO NOTHING against the unique message_id makes enqueueing safe to
 * repeat: a retried ingestion run re-enqueues nothing, so the employee cannot
 * receive two acknowledgements for one email.
 */
async function insertIntent(db: Db, input: NewIntent, now: string): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO outbox
       (ticket_id, intent, recipient, message_id, payload, state,
        attempts, next_attempt_at, pending_status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', 0, $6, $7, $8, $9)
     ON CONFLICT (message_id) DO NOTHING`,
    [
      input.ticketId,
      input.intent,
      input.recipient,
      input.messageId,
      input.payload,
      now,
      input.pendingStatus ?? null,
      now,
      now,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Returns false when this Message-ID was already queued. */
export async function enqueueIntent(db: Db, input: NewIntent): Promise<boolean> {
  return insertIntent(db, input, new Date().toISOString());
}

/**
 * Claim one due intent for sending.
 *
 * `FOR UPDATE SKIP LOCKED` is the real lock D1 never had: the row is selected
 * and locked in one statement, and a concurrent claimer skips it rather than
 * blocking or racing. The compare-and-swap this replaced worked, but only
 * because there was exactly one poller; this is correct with any number.
 *
 * Returns null when nothing is due.
 */
export async function claimNextIntent(pool: Pool, now: Date): Promise<DueIntent | null> {
  const iso = now.toISOString();
  return withTransaction(pool, async (db) => {
    const { rows } = await db.query<{
      id: number;
      ticket_id: number;
      intent: OutboxIntent;
      recipient: string;
      message_id: string;
      payload: string;
      attempts: number;
      pending_status: string | null;
    }>(
      `SELECT id, ticket_id, intent, recipient, message_id, payload, attempts, pending_status
         FROM outbox
        WHERE state = 'pending' AND next_attempt_at <= $1
        ORDER BY next_attempt_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [iso],
    );
    const candidate = rows[0];
    if (candidate === undefined) return null;

    await db.query(
      `UPDATE outbox
          SET state = 'sending', sending_since = $1, attempts = attempts + 1, updated_at = $2
        WHERE id = $3`,
      [iso, iso, candidate.id],
    );

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
  });
}

/**
 * Record that the server accepted the message, applying any status transition
 * that was waiting on it in the same transaction (R28). The transition and the
 * acceptance record commit together or not at all — a ticket must never show a
 * status whose required email was not accepted.
 */
export async function recordAcceptance(
  pool: Pool,
  id: number,
  ticketId: number,
  acceptedAt: string,
  reply: string,
  pendingStatus: string | null,
): Promise<void> {
  await withTransaction(pool, async (db) => {
    await db.query(
      `UPDATE outbox
          SET state = 'accepted', accepted_at = $1, smtp_reply = $2,
              sending_since = NULL, updated_at = $3
        WHERE id = $4`,
      [acceptedAt, reply.slice(0, 500), acceptedAt, id],
    );
    if (pendingStatus !== null) {
      await db.query(`UPDATE tickets SET status = $1, updated_at = $2 WHERE id = $3`, [
        pendingStatus,
        acceptedAt,
        ticketId,
      ]);
    }
  });
}

/**
 * Record a failed attempt. A permanent rejection stops immediately; a transient
 * one waits out the backoff and tries again until attempts are exhausted, at
 * which point it becomes visible to IT rather than disappearing.
 */
export async function recordSendFailure(
  db: Db,
  id: number,
  nextState: "pending" | "failed",
  nextAttempt: string,
  detail: string,
): Promise<void> {
  await db.query(
    `UPDATE outbox
        SET state = $1, next_attempt_at = $2, last_error = $3,
            sending_since = NULL, updated_at = $4
      WHERE id = $5`,
    [nextState, nextAttempt, detail.slice(0, 500), new Date().toISOString(), id],
  );
}

/**
 * Park a row whose outcome we genuinely do not know: the message was written
 * and the server's answer never arrived. Never resolved automatically — IT
 * decides, because resending risks a duplicate to a real person and dropping it
 * risks silence (PRD open point 4).
 */
export async function markAmbiguous(db: Db, id: number): Promise<void> {
  await db.query(
    `UPDATE outbox SET state = 'ambiguous', updated_at = $1 WHERE id = $2 AND state = 'sending'`,
    [new Date().toISOString(), id],
  );
}

/**
 * Park every send that has been in flight longer than the timeout. Returns how
 * many were parked.
 */
export async function sweepStaleSending(db: Db, now: Date, timeoutMs: number): Promise<number> {
  const cutoff = new Date(now.getTime() - timeoutMs).toISOString();
  const result = await db.query(
    `UPDATE outbox SET state = 'ambiguous', updated_at = $1
      WHERE state = 'sending' AND sending_since IS NOT NULL AND sending_since <= $2`,
    [now.toISOString(), cutoff],
  );
  return result.rowCount ?? 0;
}

/* --------------------------------------------------------------- threading */

/** True when these Message-IDs belong to a staff notification we sent. */
export async function isNotificationThread(db: Db, candidates: string[]): Promise<boolean> {
  if (candidates.length === 0) return false;
  const { rowCount } = await db.query(
    `SELECT 1 FROM outbox WHERE intent = 'notification' AND message_id = ANY($1::text[]) LIMIT 1`,
    [candidates],
  );
  return rowCount !== 0;
}

/**
 * Find the ticket an inbound reply belongs to, by Message-ID.
 *
 * Candidates are tried in order, so the closest relative wins — which is why
 * this is a loop rather than one `= ANY($1)` query. Both sides of the
 * conversation are searched: `messages` holds what employees sent us, and
 * `outbox` holds what we sent them.
 *
 * Notifications are excluded, and that exclusion is load-bearing. They go to IT
 * staff, who are on the approved sender domain, so an IT member replying to
 * one would otherwise have their reply threaded onto the ticket as though the
 * employee had sent it — restarting the response clock and reopening a resolved
 * ticket. R15 requires that a reply to a notification neither reaches the
 * ticket nor satisfies a deadline; this is where that is true.
 */
export async function findTicketByMessageIds(db: Db, candidates: string[]): Promise<number | null> {
  for (const candidate of candidates) {
    const { rows } = await db.query<{ ticket_id: number }>(
      `SELECT ticket_id FROM messages WHERE message_id = $1
        UNION ALL
       SELECT ticket_id FROM outbox
        WHERE message_id = $1 AND intent <> 'notification'
       LIMIT 1`,
      [candidate],
    );
    const hit = rows[0];
    if (hit !== undefined) return hit.ticket_id;
  }
  return null;
}

/**
 * Append an inbound reply to an existing ticket.
 *
 * A reply reopens a Resolved or Closed ticket (T011). Deadlines are deliberately
 * left alone — the specification is explicit that a reply must not postpone an
 * existing pending deadline.
 */
export async function appendReply(
  pool: Pool,
  input: {
    ticketId: number;
    uid: number;
    author: string;
    body: string;
    messageId: string | null;
    rawPath?: string | null;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await withTransaction(pool, async (db) => {
    await db.query(
      `INSERT INTO messages (ticket_id, direction, author, body, message_id, created_at)
       VALUES ($1, 'inbound', $2, $3, $4, $5)`,
      [input.ticketId, input.author, input.body, input.messageId, now],
    );
    await db.query(
      `INSERT INTO ingest_log (uid, outcome, ticket_id, raw_path, at)
       VALUES ($1, 'ticket', $2, $3, $4)`,
      [input.uid, input.ticketId, input.rawPath ?? null, now],
    );
    // Always bump updated_at: the queue is ordered by it, so a ticket with a
    // new employee reply must rise to the top. Bumping only on reopen made the
    // tickets most needing attention sink below untouched ones.
    await db.query(`UPDATE tickets SET updated_at = $1 WHERE id = $2`, [now, input.ticketId]);
    // Reopening is separate, and only applies to a ticket that was closed out.
    await db.query(
      `UPDATE tickets SET status = 'In Progress'
        WHERE id = $1 AND status IN ('Resolved', 'Closed')`,
      [input.ticketId],
    );
  });
}

/**
 * Record that a delivered message bounced (R15).
 *
 * The row is marked 'bounced' rather than 'failed': it WAS accepted by the
 * server, and the distinction matters because R28 anchors the auto-close clock
 * to that acceptance and requires a later bounce to pause it.
 */
export async function recordBounce(db: Db, candidates: string[]): Promise<number | null> {
  for (const candidate of candidates) {
    const { rows } = await db.query<{ id: number; ticket_id: number }>(
      `SELECT id, ticket_id FROM outbox WHERE message_id = $1 LIMIT 1`,
      [candidate],
    );
    const hit = rows[0];
    if (hit === undefined) continue;
    await db.query(`UPDATE outbox SET state = 'bounced', updated_at = $1 WHERE id = $2`, [
      new Date().toISOString(),
      hit.id,
    ]);
    return hit.ticket_id;
  }
  return null;
}

/**
 * Outbox counts by state. States with no rows are reported as zero rather than
 * omitted, so a disappearing key cannot be mistaken for a healthy queue.
 */
export async function outboxSummary(db: Db): Promise<Record<string, number>> {
  const { rows } = await db.query<{ state: string; count: number }>(
    `SELECT state, COUNT(*)::int AS count FROM outbox GROUP BY state`,
  );
  const summary: Record<string, number> = {
    pending: 0,
    sending: 0,
    accepted: 0,
    failed: 0,
    ambiguous: 0,
    bounced: 0,
  };
  for (const row of rows) summary[row.state] = row.count;
  return summary;
}

/** Outbox rows needing a human decision (T013): failed, ambiguous or bounced. */
export interface StuckIntent {
  id: number;
  ticket_id: number;
  intent: string;
  recipient: string;
  state: string;
  attempts: number;
  last_error: string | null;
  updated_at: string;
}

export async function stuckIntents(db: Db): Promise<StuckIntent[]> {
  const { rows } = await db.query<StuckIntent>(
    `SELECT id, ticket_id, intent, recipient, state, attempts, last_error, updated_at
       FROM outbox
      WHERE state IN ('failed', 'ambiguous', 'bounced')
      ORDER BY updated_at DESC`,
  );
  return rows;
}

/* --------------------------------------------------------------- dashboard */

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
   * to `messages`, so this can only be a real reply from IT — which is what
   * R28 requires to satisfy a response deadline.
   */
  first_response_at: string | null;
  created_at: string;
  updated_at: string;
  messages: number;
}

const TICKET_COLUMNS = `t.id, t.subject, t.requester, t.status, t.priority, t.owner,
       t.response_due, t.created_at, t.updated_at,
       (SELECT MIN(m.created_at) FROM messages m
         WHERE m.ticket_id = t.id AND m.direction = 'outbound') AS first_response_at,
       (SELECT COUNT(*)::int FROM messages m WHERE m.ticket_id = t.id) AS messages`;

/** Newest first, which is the order IT works in. */
export async function listTickets(db: Db, limit = 100): Promise<TicketRow[]> {
  const { rows } = await db.query<TicketRow>(
    `SELECT ${TICKET_COLUMNS}
       FROM tickets t
      ORDER BY t.updated_at DESC, t.id DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

export interface TicketMessage {
  id: number;
  direction: string;
  author: string;
  body: string;
  message_id: string | null;
  created_at: string;
}

export interface TicketDetail {
  ticket: TicketRow;
  messages: TicketMessage[];
  attachments: AttachmentRow[];
  /** Everyone copied on this ticket, removed ones included (R25). */
  participants: ParticipantRow[];
  /** Who did what to it (R08). Separate from `messages`, which is what was said. */
  audit: AuditRow[];
  /** Outgoing mail still on the way, so a pending transition is visible (T016). */
  pending: PendingIntent[];
}

/** An outbox row a ticket is still waiting on, for the dashboard indicator. */
export interface PendingIntent {
  id: number;
  intent: OutboxIntent;
  state: string;
  pending_status: string | null;
  last_error: string | null;
}

export async function getTicket(db: Db, id: number): Promise<TicketDetail | null> {
  const found = await db.query<TicketRow>(
    `SELECT ${TICKET_COLUMNS} FROM tickets t WHERE t.id = $1`,
    [id],
  );
  const ticket = found.rows[0];
  if (ticket === undefined) return null;

  const messages = await db.query<TicketMessage>(
    `SELECT id, direction, author, body, message_id, created_at
       FROM messages WHERE ticket_id = $1 ORDER BY id`,
    [id],
  );
  // Anything not yet accepted, plus anything that failed. R28 holds a status
  // change against its message, so "Resolved once this sends" has to be
  // visible - otherwise IT presses Resolve, sees New, and presses it again.
  const pending = await db.query<PendingIntent>(
    `SELECT id, intent, state, pending_status, last_error
       FROM outbox
      WHERE ticket_id = $1 AND state <> 'accepted'
      ORDER BY id`,
    [id],
  );
  return {
    ticket,
    messages: messages.rows,
    attachments: await listAttachments(db, id),
    participants: await participantHistory(db, id),
    audit: await ticketAudit(db, id),
    pending: pending.rows,
  };
}

/**
 * Message-IDs on a ticket's thread, oldest first, so a reply can be threaded
 * into the employee's existing conversation. Includes what we have sent as well
 * as what we received — the employee's client may be replying to either.
 */
export async function threadIds(db: Db, ticketId: number): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT message_id AS id, created_at FROM messages
       WHERE ticket_id = $1 AND message_id IS NOT NULL AND direction != 'note'
      UNION ALL
     SELECT message_id AS id, created_at FROM outbox WHERE ticket_id = $1
      ORDER BY created_at`,
    [ticketId],
  );
  return rows.map((row) => row.id);
}

/**
 * Record a public reply and queue it for delivery, in one transaction.
 *
 * The visible message and the outgoing intent commit together: a reply shown in
 * the dashboard that was never queued would have IT believing they answered.
 */
export async function addReply(
  pool: Pool,
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
  await withTransaction(pool, async (db) => {
    await db.query(
      `INSERT INTO messages (ticket_id, direction, author, body, message_id, created_at)
       VALUES ($1, 'outbound', $2, $3, $4, $5)`,
      [input.ticketId, input.author, input.body, input.messageId, now],
    );
    await insertIntent(
      db,
      {
        ticketId: input.ticketId,
        intent: input.intent ?? "reply",
        recipient: input.recipient,
        messageId: input.messageId,
        payload: input.payload,
        ...(input.pendingStatus === undefined ? {} : { pendingStatus: input.pendingStatus }),
      },
      now,
    );
    await db.query(`UPDATE tickets SET updated_at = $1 WHERE id = $2`, [now, input.ticketId]);
  });
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
  pool: Pool,
  ticketId: number,
  author: string,
  body: string,
): Promise<void> {
  const now = new Date().toISOString();
  await withTransaction(pool, async (db) => {
    await db.query(
      `INSERT INTO messages (ticket_id, direction, author, body, message_id, created_at)
       VALUES ($1, 'note', $2, $3, NULL, $4)`,
      [ticketId, author, body, now],
    );
    await db.query(`UPDATE tickets SET updated_at = $1 WHERE id = $2`, [now, ticketId]);
  });
}

/* ------------------------------------------------------------------- staff */

export interface StaffRow {
  name: string;
  email: string | null;
  available: boolean;
  /** Account access (R24). Distinct from `available`; see setEnabled. */
  enabled: boolean;
  is_admin: boolean;
  has_password: boolean;
  openTickets: number;
}

/**
 * Turn staff rows into assignment candidates (R07, R24).
 *
 * `available` and `enabled` are separate columns and are ANDed exactly here,
 * once, rather than at each caller — a caller that forgot the second half
 * would hand tickets to someone who no longer has an account, and nothing
 * about the result would look wrong.
 */
export function assignable(staff: readonly StaffRow[]): StaffWorkload[] {
  return staff.map((member) => ({
    name: member.name,
    openTickets: member.openTickets,
    available: member.available && member.enabled,
  }));
}

/**
 * Staff with their current open-ticket counts.
 *
 * "Open" is New, In Progress and Waiting for Employee. Resolved and Closed are
 * excluded: counting finished work would permanently penalise whoever has been
 * here longest and starve them of new tickets.
 *
 * password_hash is reduced to a boolean here. The API serialises this row
 * straight to the dashboard, and a hash that never leaves the database cannot
 * be leaked by a future endpoint that forgets to strip it.
 */
export async function staffWorkloads(db: Db): Promise<StaffRow[]> {
  const { rows } = await db.query<StaffRow>(
    `SELECT s.name, s.email, s.available, s.enabled, s.is_admin,
            (s.password_hash IS NOT NULL) AS has_password,
            (SELECT COUNT(*)::int FROM tickets t
              WHERE t.owner = s.name
                AND t.status IN ('New', 'In Progress', 'Waiting for Employee')
            ) AS "openTickets"
       FROM staff s ORDER BY s.name`,
  );
  return rows;
}

/** Who received the most recent assignment, for round-robin rotation. */
export async function lastAssignee(db: Db): Promise<string | null> {
  const { rows } = await db.query<{ owner: string }>(
    `SELECT owner FROM tickets WHERE owner IS NOT NULL ORDER BY id DESC LIMIT 1`,
  );
  return rows[0]?.owner ?? null;
}

export async function addStaff(
  db: Db,
  name: string,
  email: string | null,
  isAdmin = false,
): Promise<void> {
  await db.query(
    `INSERT INTO staff (name, email, available, is_admin, created_at)
     VALUES ($1, $2, TRUE, $3, $4)
     ON CONFLICT (name) DO NOTHING`,
    [name, email, isAdmin, new Date().toISOString()],
  );
}

export async function setAvailability(
  db: Db,
  name: string,
  available: boolean,
  actor = "system",
): Promise<boolean> {
  const result = await db.query(`UPDATE staff SET available = $1 WHERE name = $2`, [
    available,
    name,
  ]);
  if ((result.rowCount ?? 0) === 0) return false;
  await recordAudit(db, {
    actor,
    action: available ? "made_available" : "made_unavailable",
    detail: name,
  });
  return true;
}

/**
 * Assign or unassign a ticket (R07, R24).
 *
 * The move is audited in the same statement batch. Assignment changes left no
 * trace at all before this: the message history records what was said, never
 * who the ticket passed through, which is the question actually asked when a
 * ticket has been sitting untouched for a week.
 */
export async function setOwner(
  db: Db,
  id: number,
  owner: string | null,
  actor = "system",
): Promise<boolean> {
  const result = await db.query(
    `UPDATE tickets SET owner = $1, updated_at = $2 WHERE id = $3 AND owner IS DISTINCT FROM $1`,
    [owner, new Date().toISOString(), id],
  );
  if ((result.rowCount ?? 0) === 0) return false;
  await recordAudit(db, {
    ticketId: id,
    actor,
    action: owner === null ? "unassigned" : "assigned",
    detail: owner,
  });
  return true;
}

/** Apply a status that needs no email (R09). */
export async function setStatus(
  db: Db,
  id: number,
  status: string,
  actor = "system",
): Promise<void> {
  await db.query(`UPDATE tickets SET status = $1, updated_at = $2 WHERE id = $3`, [
    status,
    new Date().toISOString(),
    id,
  ]);
  await recordAudit(db, { ticketId: id, actor, action: "status", detail: status });
}

/**
 * Open tickets owned by someone, oldest first. Used when redistributing work
 * from a staff member who has become unavailable (R24).
 */
export async function openTicketsOwnedBy(db: Db, name: string): Promise<number[]> {
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM tickets
      WHERE owner = $1 AND status IN ('New', 'In Progress', 'Waiting for Employee')
      ORDER BY id`,
    [name],
  );
  return rows.map((row) => row.id);
}

/**
 * Open tickets nobody owns, oldest first (R24).
 *
 * Oldest first because they have been waiting longest and their response
 * deadlines are closest.
 */
export async function unassignedOpenTickets(db: Db): Promise<number[]> {
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM tickets
      WHERE owner IS NULL AND status IN ('New', 'In Progress', 'Waiting for Employee')
      ORDER BY id`,
  );
  return rows.map((row) => row.id);
}

/* ------------------------------------------------------------- auto-close */

export interface CloseCandidate {
  id: number;
  subject: string;
  requester: string;
  owner: string | null;
  accepted_at: string;
}

/**
 * Resolved tickets whose resolution email was accepted long enough ago to close
 * (R19, R28).
 *
 * Three conditions, and each one is a requirement rather than a nicety:
 *
 *   The clock runs from `accepted_at` on the resolution row, not from when the
 *   status changed and not from when it was queued. R28 anchors it to the
 *   moment the mail server took the message, because before that the employee
 *   has not been told anything.
 *
 *   A bounced resolution suspends it. R28: a delivery failure reported after
 *   acceptance pauses automatic closure until delivery is fixed. Closing a
 *   ticket whose "we have fixed it" email never arrived is how a problem gets
 *   marked solved while the person who reported it hears nothing.
 *
 *   A closure already queued excludes the ticket, or every tick would queue
 *   another one.
 */
export async function ticketsReadyToClose(db: Db, before: string): Promise<CloseCandidate[]> {
  const { rows } = await db.query<CloseCandidate>(
    `SELECT t.id, t.subject, t.requester, t.owner, resolution.accepted_at
       FROM tickets t
       JOIN LATERAL (
         SELECT o.accepted_at
           FROM outbox o
          WHERE o.ticket_id = t.id
            AND o.intent = 'resolution'
            AND o.state = 'accepted'
            AND o.accepted_at IS NOT NULL
          ORDER BY o.accepted_at DESC
          LIMIT 1
       ) resolution ON TRUE
      WHERE t.status = 'Resolved'
        AND resolution.accepted_at <= $1
        AND NOT EXISTS (
          SELECT 1 FROM outbox b
           WHERE b.ticket_id = t.id AND b.intent = 'resolution' AND b.state = 'bounced'
        )
        AND NOT EXISTS (
          SELECT 1 FROM outbox c
           WHERE c.ticket_id = t.id AND c.intent = 'closure'
             AND c.state IN ('pending', 'sending', 'accepted')
        )
      ORDER BY resolution.accepted_at`,
    [before],
  );
  return rows;
}

/* ----------------------------------------------------------- notifications */

export interface ReminderCandidate {
  id: number;
  subject: string;
  requester: string;
  owner: string | null;
  response_due: string;
  last_reminder_at: string | null;
}

/**
 * Tickets whose first response is overdue and still unanswered (R18).
 *
 * The "every four working hours" part is deliberately NOT in this query. That
 * interval is business time - Mon-Sat, 09:00-18:00 Asia/Kolkata - and the one
 * implementation of the work calendar lives in the domain module. Expressing it
 * a second time in SQL would be a second implementation, and the two would
 * disagree the first time a holiday or a Sunday was involved.
 *
 * "Waiting for Employee" is excluded because R18 says no reminders while the
 * ball is in the employee's court; Resolved and Closed because there is
 * nothing left to respond to.
 */
export async function ticketsNeedingReminder(db: Db, now: Date): Promise<ReminderCandidate[]> {
  const { rows } = await db.query<ReminderCandidate>(
    `SELECT t.id, t.subject, t.requester, t.owner, t.response_due, t.last_reminder_at
       FROM tickets t
      WHERE t.response_due IS NOT NULL
        AND t.response_due <= $1
        AND t.status IN ('New', 'In Progress')
        AND NOT EXISTS (
          SELECT 1 FROM messages m
           WHERE m.ticket_id = t.id AND m.direction = 'outbound'
        )
      ORDER BY t.response_due`,
    [now.toISOString()],
  );
  return rows;
}

export async function recordReminder(db: Db, ticketId: number, at: string): Promise<void> {
  await db.query(`UPDATE tickets SET last_reminder_at = $1 WHERE id = $2`, [at, ticketId]);
}

/** Where to send a staff member's notifications, or null if unknown. */
export async function staffEmail(db: Db, name: string): Promise<string | null> {
  const { rows } = await db.query<{ email: string | null }>(
    `SELECT email FROM staff WHERE name = $1`,
    [name],
  );
  return rows[0]?.email ?? null;
}

/** Admin addresses. R18 copies them on every overdue reminder. */
export async function adminEmails(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ email: string }>(
    `SELECT email FROM staff WHERE is_admin AND email IS NOT NULL ORDER BY name`,
  );
  return rows.map((row) => row.email);
}

/* -------------------------------------------------------------- attachments */

export interface AttachmentRow {
  id: number;
  ticket_id: number;
  message_id: number | null;
  filename: string;
  content_type: string;
  bytes: number;
  path: string;
  created_at: string;
}

export async function addAttachment(
  db: Db,
  input: {
    ticketId: number;
    messageId: number | null;
    filename: string;
    contentType: string;
    bytes: number;
    path: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO attachments (ticket_id, message_id, filename, content_type, bytes, path, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.ticketId,
      input.messageId,
      input.filename,
      input.contentType,
      input.bytes,
      input.path,
      new Date().toISOString(),
    ],
  );
}

export async function listAttachments(db: Db, ticketId: number): Promise<AttachmentRow[]> {
  const { rows } = await db.query<AttachmentRow>(
    `SELECT id, ticket_id, message_id, filename, content_type, bytes, path, created_at
       FROM attachments WHERE ticket_id = $1 ORDER BY id`,
    [ticketId],
  );
  return rows;
}

export async function getAttachment(db: Db, id: number): Promise<AttachmentRow | null> {
  const { rows } = await db.query<AttachmentRow>(
    `SELECT id, ticket_id, message_id, filename, content_type, bytes, path, created_at
       FROM attachments WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/* -------------------------------------------------------------------- auth */

export interface StaffAccount {
  name: string;
  password_hash: string | null;
  is_admin: boolean;
  available: boolean;
  enabled: boolean;
}

export async function findStaff(db: Db, name: string): Promise<StaffAccount | null> {
  const { rows } = await db.query<StaffAccount>(
    `SELECT name, password_hash, is_admin, available, enabled FROM staff WHERE name = $1`,
    [name],
  );
  return rows[0] ?? null;
}

export async function setPasswordHash(db: Db, name: string, hash: string): Promise<boolean> {
  const result = await db.query(`UPDATE staff SET password_hash = $1 WHERE name = $2`, [
    hash,
    name,
  ]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Start a session and, in the same transaction, clear this account's failure
 * count and sweep expired rows. A successful sign-in should not leave an old
 * failure streak that locks the account out a minute later.
 */
export async function createSession(
  pool: Pool,
  tokenHash: string,
  staffName: string,
  expiresAt: string,
): Promise<void> {
  const now = new Date().toISOString();
  await withTransaction(pool, async (db) => {
    await db.query(
      `INSERT INTO sessions (token_hash, staff_name, created_at, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [tokenHash, staffName, now, expiresAt],
    );
    await db.query(`DELETE FROM login_failures WHERE staff_name = $1`, [staffName]);
    await db.query(`DELETE FROM sessions WHERE expires_at <= $1`, [now]);
  });
}

export interface SessionRow {
  staff_name: string;
  expires_at: string;
  is_admin: boolean;
  /**
   * Read on every request, not only at sign-in. Disabling an account deletes
   * its sessions, so this is belt and braces — but the belt is a DELETE racing
   * an in-flight request, and the cost of checking is a column on a join that
   * already happens.
   */
  enabled: boolean;
}

export async function findSession(db: Db, tokenHash: string): Promise<SessionRow | null> {
  const { rows } = await db.query<SessionRow>(
    `SELECT s.staff_name, s.expires_at, st.is_admin, st.enabled
       FROM sessions s JOIN staff st ON st.name = s.staff_name
      WHERE s.token_hash = $1`,
    [tokenHash],
  );
  return rows[0] ?? null;
}

export async function deleteSession(db: Db, tokenHash: string): Promise<void> {
  await db.query(`DELETE FROM sessions WHERE token_hash = $1`, [tokenHash]);
}

export async function recordLoginFailure(db: Db, name: string): Promise<void> {
  await db.query(`INSERT INTO login_failures (staff_name, at) VALUES ($1, $2)`, [
    name,
    new Date().toISOString(),
  ]);
}

/** Failed attempts for this account since `since`. */
export async function recentFailures(db: Db, name: string, since: string): Promise<number> {
  const { rows } = await db.query<{ failures: number }>(
    `SELECT COUNT(*)::int AS failures FROM login_failures WHERE staff_name = $1 AND at > $2`,
    [name, since],
  );
  return rows[0]?.failures ?? 0;
}

/* -------------------------------------------------------------- audit trail */

/**
 * Who did what (R08, R24, R25).
 *
 * Written alongside the change it describes, inside the caller's transaction
 * wherever one exists — an audit entry that commits separately can survive a
 * change that rolled back, which is worse than no entry at all.
 */
export interface AuditEntry {
  ticketId?: number | null;
  actor: string;
  action: string;
  detail?: string | null;
}

export async function recordAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_events (ticket_id, actor, action, detail, at) VALUES ($1, $2, $3, $4, $5)`,
    [
      entry.ticketId ?? null,
      entry.actor,
      entry.action,
      entry.detail ?? null,
      new Date().toISOString(),
    ],
  );
}

export interface AuditRow {
  id: number;
  ticket_id: number | null;
  actor: string;
  action: string;
  detail: string | null;
  at: string;
}

export async function ticketAudit(db: Db, ticketId: number): Promise<AuditRow[]> {
  const { rows } = await db.query<AuditRow>(
    `SELECT id, ticket_id, actor, action, detail, at
       FROM audit_events WHERE ticket_id = $1 ORDER BY id`,
    [ticketId],
  );
  return rows;
}

/** The whole trail, newest first. For the admin activity view. */
export async function recentAudit(db: Db, limit = 200): Promise<AuditRow[]> {
  const { rows } = await db.query<AuditRow>(
    `SELECT id, ticket_id, actor, action, detail, at
       FROM audit_events ORDER BY id DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

/* ----------------------------------------------------------- account access */

/**
 * Enable or disable an account (R24).
 *
 * Disabling revokes access in the same transaction as it sets the flag: the
 * session rows are deleted rather than left to expire, because an account that
 * is disabled but still has a live cookie is not disabled. Availability is a
 * separate column and is deliberately untouched here — someone on leave keeps
 * their login, and a leaver does not keep one.
 *
 * Returns null when there is no such account, so the caller can answer 404
 * rather than reporting a change that did not happen.
 */
export async function setEnabled(
  pool: Pool,
  name: string,
  enabled: boolean,
  actor: string,
): Promise<{ sessionsRevoked: number } | null> {
  return withTransaction(pool, async (db) => {
    const updated = await db.query(`UPDATE staff SET enabled = $1 WHERE name = $2`, [
      enabled,
      name,
    ]);
    if ((updated.rowCount ?? 0) === 0) return null;

    let sessionsRevoked = 0;
    if (!enabled) {
      const removed = await db.query(`DELETE FROM sessions WHERE staff_name = $1`, [name]);
      sessionsRevoked = removed.rowCount ?? 0;
    }
    await recordAudit(db, {
      actor,
      action: enabled ? "account_enabled" : "account_disabled",
      detail: name,
    });
    return { sessionsRevoked };
  });
}

/* ------------------------------------------------------- CC participants */

export interface ParticipantRow {
  address: string;
  added_by: string;
  added_at: string;
  removed_at: string | null;
}

/** Everyone currently on the ticket, lower-cased, oldest first (R25). */
export async function listParticipants(db: Db, ticketId: number): Promise<string[]> {
  const { rows } = await db.query<{ address: string }>(
    `SELECT address FROM ticket_participants
      WHERE ticket_id = $1 AND removed_at IS NULL ORDER BY added_at, address`,
    [ticketId],
  );
  return rows.map((row) => row.address);
}

/** Including the removed, for the dashboard and the audit view. */
export async function participantHistory(db: Db, ticketId: number): Promise<ParticipantRow[]> {
  const { rows } = await db.query<ParticipantRow>(
    `SELECT address, added_by, added_at, removed_at FROM ticket_participants
      WHERE ticket_id = $1 ORDER BY added_at, address`,
    [ticketId],
  );
  return rows;
}

/**
 * Add participants, audited, skipping anyone already there.
 *
 * Returns only those actually added. A caller that notified everyone it passed
 * in would email people who have been on the ticket for a week every time the
 * requester leaves them on a Cc line — which R25 forbids in as many words.
 *
 * Re-adding somebody previously removed clears `removed_at`: IT removing a
 * person and later putting them back is a deliberate act both times, and each
 * is recorded.
 */
export async function addParticipants(
  pool: Pool,
  ticketId: number,
  addresses: readonly string[],
  addedBy: string,
): Promise<string[]> {
  if (addresses.length === 0) return [];
  const now = new Date().toISOString();
  return withTransaction(pool, async (db) => {
    const added: string[] = [];
    for (const raw of addresses) {
      const address = raw.toLowerCase();
      const { rowCount } = await db.query(
        `INSERT INTO ticket_participants (ticket_id, address, added_by, added_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (ticket_id, address) DO UPDATE
            SET removed_at = NULL, added_by = excluded.added_by, added_at = excluded.added_at
          WHERE ticket_participants.removed_at IS NOT NULL`,
        [ticketId, address, addedBy, now],
      );
      if ((rowCount ?? 0) === 0) continue;
      added.push(address);
      await recordAudit(db, {
        ticketId,
        actor: addedBy,
        action: "participant_added",
        detail: address,
      });
    }
    return added;
  });
}

/**
 * Remove a participant (R25): only ever explicitly, never because an address
 * stopped appearing in a Cc header.
 */
export async function removeParticipant(
  pool: Pool,
  ticketId: number,
  address: string,
  actor: string,
): Promise<boolean> {
  return withTransaction(pool, async (db) => {
    const { rowCount } = await db.query(
      `UPDATE ticket_participants SET removed_at = $1
        WHERE ticket_id = $2 AND address = $3 AND removed_at IS NULL`,
      [new Date().toISOString(), ticketId, address.toLowerCase()],
    );
    if ((rowCount ?? 0) === 0) return false;
    await recordAudit(db, {
      ticketId,
      actor,
      action: "participant_removed",
      detail: address.toLowerCase(),
    });
    return true;
  });
}

/**
 * May this address write into this ticket (R25)?
 *
 * True for the requester and for any current participant. Being on the approved
 * domain is NOT enough: that authorises opening a ticket of your own, not
 * joining a colleague's, and a company-wide domain check would let anybody read
 * and answer anybody else's IT correspondence by guessing a Message-ID.
 */
export async function isTicketParticipant(
  db: Db,
  ticketId: number,
  address: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM tickets WHERE id = $1 AND LOWER(requester) = $2
      UNION ALL
     SELECT 1 FROM ticket_participants
      WHERE ticket_id = $1 AND address = $2 AND removed_at IS NULL
      LIMIT 1`,
    [ticketId, address.toLowerCase()],
  );
  return (rowCount ?? 0) > 0;
}

/* --------------------------------------------------------- reply templates */

export interface TemplateRow {
  id: number;
  name: string;
  body: string;
  /** The status sending this template requests, or null for no change. */
  maps_to: string | null;
}

export async function listTemplates(db: Db): Promise<TemplateRow[]> {
  const { rows } = await db.query<TemplateRow>(
    `SELECT id, name, body, maps_to FROM reply_templates ORDER BY id`,
  );
  return rows;
}

export async function getTemplate(db: Db, id: number): Promise<TemplateRow | null> {
  const { rows } = await db.query<TemplateRow>(
    `SELECT id, name, body, maps_to FROM reply_templates WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Create or rename-in-place a template (R24, admin only — enforced at the API).
 *
 * Editing a template deliberately does not touch anything already sent: the
 * outgoing text is copied into `messages` and into the outbox payload at send
 * time, so a later edit cannot rewrite what an employee has already received.
 */
export async function upsertTemplate(
  db: Db,
  input: { id?: number; name: string; body: string; mapsTo: string | null },
): Promise<TemplateRow | null> {
  const now = new Date().toISOString();
  if (input.id === undefined) {
    const { rows } = await db.query<TemplateRow>(
      `INSERT INTO reply_templates (name, body, maps_to, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT (name) DO UPDATE
          SET body = excluded.body, maps_to = excluded.maps_to, updated_at = excluded.updated_at
       RETURNING id, name, body, maps_to`,
      [input.name, input.body, input.mapsTo, now],
    );
    return rows[0] ?? null;
  }
  const { rows } = await db.query<TemplateRow>(
    `UPDATE reply_templates SET name = $1, body = $2, maps_to = $3, updated_at = $4
      WHERE id = $5 RETURNING id, name, body, maps_to`,
    [input.name, input.body, input.mapsTo, now, input.id],
  );
  return rows[0] ?? null;
}

export async function deleteTemplate(db: Db, id: number): Promise<boolean> {
  const { rowCount } = await db.query(`DELETE FROM reply_templates WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

/* ------------------------------------------------------ oversized attachments */

/**
 * Remember that the employee has been told their attachments did not fit (R12),
 * and report whether this call is the one that should send the notice.
 *
 * A single flag per ticket rather than per message: the point is to explain the
 * limit once, and a ticket where every reply carries a 20 MB file should not
 * generate a lecture each time.
 */
export async function claimOversizedNotice(db: Db, ticketId: number): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE tickets SET oversized_notified_at = $1
      WHERE id = $2 AND oversized_notified_at IS NULL`,
    [new Date().toISOString(), ticketId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Put a bounced or permanently failed intent back in the queue (R28).
 *
 * `accepted_at` is cleared with it, which is the point: the auto-close clock is
 * anchored to that column, so a resolution that bounced and is resent starts
 * its 72 hours from the NEW acceptance rather than from the delivery that never
 * arrived. The pending status rides along untouched, so a transition still
 * waiting on this message is still waiting on it.
 */
export async function requeueIntent(db: Db, id: number): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE outbox
        SET state = 'pending', attempts = 0, next_attempt_at = $1, accepted_at = NULL,
            sending_since = NULL, last_error = NULL, updated_at = $1
      WHERE id = $2 AND state IN ('bounced', 'failed', 'ambiguous')`,
    [new Date().toISOString(), id],
  );
  return (rowCount ?? 0) > 0;
}
