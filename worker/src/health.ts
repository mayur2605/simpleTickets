/**
 * Deciding whether the ingestion chain has stopped.
 *
 * Pure: takes the time rather than reading a clock, so the thresholds can be
 * tested exactly.
 *
 * This exists because the Durable Object alarm that drives ingestion has no
 * safety net. Rescheduling before the work protects against a failing tick, not
 * against the chain ending - an evicted object or a lost alarm stops everything
 * silently, with no error raised and nobody told. Silence is the only symptom,
 * so silence is what gets measured.
 */

/**
 * How many intervals of quiet before the chain is considered stopped.
 *
 * Not 1. A single late tick is ordinary - a slow IMAP dialogue, a retried
 * alarm - and restarting on the first missed beat would arm a second chain
 * alongside one that was merely busy, doubling the poll rate. Three intervals
 * is six minutes: long enough to be unambiguous, short enough that nobody
 * waits an hour for a stuck mailbox.
 */
export const STALL_TOLERANCE = 3;

export interface TickHealth {
  stalled: boolean;
  silentMs: number | null;
  silentMinutes: number | null;
}

export function tickHealth(lastTickAt: string | null, now: number, intervalMs: number): TickHealth {
  if (lastTickAt === null) {
    return { stalled: true, silentMs: null, silentMinutes: null };
  }
  const last = Date.parse(lastTickAt);
  if (Number.isNaN(last)) {
    // A stored value we cannot read is not evidence of health.
    return { stalled: true, silentMs: null, silentMinutes: null };
  }
  // A timestamp in the future means clock skew, not silence. Clamp rather than
  // report negative quiet.
  const silentMs = Math.max(0, now - last);
  return {
    stalled: silentMs > intervalMs * STALL_TOLERANCE,
    silentMs,
    silentMinutes: Math.floor(silentMs / 60_000),
  };
}
