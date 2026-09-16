/**
 * The self-rescheduling tick, kept separate from the Durable Object so the one
 * property that matters can be tested without a Workers runtime.
 *
 * Cloudflare's cron triggers do not fire on this account - measured on
 * 17 September 2026 with a dedicated probe worker that had no HTTP surface at
 * all, so nothing but the scheduler could have invoked it. It never ran. See
 * docs/stack-validation.md. A Durable Object alarm replaces them: it stays
 * inside Cloudflare, needs no external scheduler and no third party holding our
 * admin token, and gives something cron never did - a Durable Object is
 * single-threaded, so two ticks can never overlap.
 */

/** R02: check for new mail every two minutes. */
export const TICK_INTERVAL_MS = 120_000;

export interface AlarmStorage {
  setAlarm(scheduledTime: number): Promise<void>;
}

export interface TickResult {
  error: string | null;
}

/**
 * Reschedule, then work.
 *
 * The order is the whole point. Doing the work first and rescheduling after
 * means one failed poll - a dropped IMAP connection, a Gmail hiccup - ends the
 * chain permanently: no further alarm is ever set, and the system stops with
 * nothing raised and nobody told. Rescheduling first makes a failure cost one
 * missed cycle instead of every future one.
 *
 * The error is returned rather than thrown for the same reason. A throwing
 * alarm handler is retried by the platform, and that retry would schedule a
 * second alarm on top of the one already set, leaving two chains ticking and
 * the mailbox polled twice as often. Swallowing it here keeps exactly one.
 */
export async function runTick(
  storage: AlarmStorage,
  work: () => Promise<void>,
  now: number,
  intervalMs: number = TICK_INTERVAL_MS,
): Promise<TickResult> {
  await storage.setAlarm(now + intervalMs);
  try {
    await work();
    return { error: null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
