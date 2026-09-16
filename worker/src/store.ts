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

export async function writeCheckpoint(
  db: D1Database,
  checkpoint: Checkpoint,
): Promise<void> {
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
export async function createTicket(db: D1Database, input: NewTicket): Promise<number> {
  const now = new Date().toISOString();
  const ticket = await db
    .prepare(
      `INSERT INTO tickets (subject, requester, status, priority, created_at, updated_at)
       VALUES (?, ?, 'New', 'Normal', ?, ?) RETURNING id`,
    )
    .bind(input.subject, input.requester, now, now)
    .first<{ id: number }>();
  if (ticket === null) throw new Error("Ticket insert returned no id.");

  await db.batch([
    db
      .prepare(
        `INSERT INTO messages (ticket_id, direction, author, body, message_id, created_at)
         VALUES (?, 'inbound', ?, ?, ?, ?)`,
      )
      .bind(ticket.id, input.requester, input.body, input.messageId, now),
    db
      .prepare(
        `INSERT INTO ingest_log (uid, outcome, ticket_id, at) VALUES (?, 'ticket', ?, ?)`,
      )
      .bind(input.uid, ticket.id, now),
  ]);
  return ticket.id;
}

/** Record a UID we deliberately did not turn into a ticket. */
export async function recordSkip(
  db: D1Database,
  uid: number,
  outcome: "rejected_sender" | "error",
  detail: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO ingest_log (uid, outcome, detail, at) VALUES (?, ?, ?, ?)`,
    )
    .bind(uid, outcome, detail.slice(0, 500), new Date().toISOString())
    .run();
}
