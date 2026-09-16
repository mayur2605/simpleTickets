/**
 * Outbox state machine (T013, R28).
 *
 * Pure decisions only: no sockets, no database, no clock of its own. Every
 * function takes the current time so tests are deterministic.
 *
 * The outbox exists because sending can fail in more ways than it can succeed,
 * and because an employee must never receive the same automatic message twice.
 * Three properties carry that weight:
 *
 *   Idempotency. Each intent has a Message-ID that is unique in the table, so
 *   an overlapping or retried run enqueues nothing the second time. This is the
 *   same guarantee `ingest_log.uid` gives ingestion.
 *
 *   No concurrent send of one row. A row mid-flight is never "due", so two
 *   overlapping runs cannot both write it to the wire.
 *
 *   Honest ambiguity. If we wrote a message and died before recording the
 *   server's answer, we genuinely do not know whether it was delivered.
 *   Resending risks a duplicate to a real person; dropping it risks silence.
 *   The row is parked as `ambiguous` for IT to decide, never resolved by guess.
 *   PRD open point 4 leaves the mechanism open; this is that mechanism.
 */

export type OutboxState = "pending" | "sending" | "accepted" | "failed" | "ambiguous";

export interface OutboxRow {
  state: OutboxState;
  attempts: number;
  /** ISO timestamp; the row is not retried before this. */
  nextAttemptAt: string;
  /** ISO timestamp of when the in-flight attempt began, else null. */
  sendingSince: string | null;
}

/** After this many attempts a row stops retrying and becomes visible to IT. */
export const MAX_ATTEMPTS = 5;

/**
 * How long a send may stay in flight before it is treated as unknown rather
 * than running. Generous: a slow SMTP dialogue is normal, and calling a live
 * send ambiguous would be worse than waiting.
 */
export const SENDING_TIMEOUT_MS = 5 * 60 * 1000;

const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

/**
 * 5xx is the server saying "never" - retrying only re-sends a rejection.
 * 4xx is "not now": greylisting, rate limits, a full mailbox.
 *
 * Anything unrecognised is treated as transient on purpose. Misjudging a
 * temporary failure as permanent silently loses an employee's mail, which is
 * worse than a few wasted retries, and MAX_ATTEMPTS still bounds it.
 */
export function classifySmtpFailure(code: string): "permanent" | "transient" {
  return /^5\d\d$/.test(code) ? "permanent" : "transient";
}

/** Exponential, capped so a retry cannot drift past any useful deadline. */
export function backoffMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  // Cap the exponent before shifting: 1 << 50 overflows into nonsense.
  const raw = BASE_BACKOFF_MS * 2 ** Math.min(exponent, 20);
  return Math.min(raw, MAX_BACKOFF_MS);
}

export function nextAttemptAt(attempts: number, now: Date): string {
  return new Date(now.getTime() + backoffMs(attempts)).toISOString();
}

/**
 * A row is due only when it is pending and its wait has elapsed. `sending` is
 * excluded so overlapping runs cannot both pick up the same row; `accepted`,
 * `failed` and `ambiguous` are terminal until someone acts on them.
 */
export function isDue(row: OutboxRow, now: Date): boolean {
  if (row.state !== "pending") {
    return false;
  }
  return new Date(row.nextAttemptAt).getTime() <= now.getTime();
}

export function isAbandoned(attempts: number): boolean {
  return attempts >= MAX_ATTEMPTS;
}

/**
 * True when a send has been in flight long enough that its outcome is unknown.
 * Deliberately never decides what to do about it - it only marks the row for a
 * human, because the system cannot tell delivered from undelivered here.
 */
export function isAmbiguous(row: OutboxRow, now: Date): boolean {
  if (row.state !== "sending" || row.sendingSince === null) {
    return false;
  }
  return now.getTime() - new Date(row.sendingSince).getTime() > SENDING_TIMEOUT_MS;
}
