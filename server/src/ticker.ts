/**
 * The two-minute ingestion loop (R02).
 *
 * This replaced a Cloudflare Durable Object, which itself replaced a cron
 * trigger that never fired on that account. What survives from the Durable
 * Object is the property that actually mattered: two ticks can never overlap.
 * There it came from the object being single-threaded; here it comes from the
 * `#running` flag below, and it matters for the same reason — two concurrent
 * polls can both claim the same outbox row and put the same message on the wire
 * twice.
 *
 * A tick never throws. An ingestion that fails is logged and the next tick
 * tries again; letting the error out would take the loop with it, and a
 * silently stopped poller is the failure mode this system has already had once.
 */
import { tickHealth, type TickHealth } from "./health.ts";

export const TICK_INTERVAL_MS = 120_000;

export interface TickerStatus {
  running: boolean;
  lastTickAt: string | null;
  lastError: string | null;
  ticks: number;
  failures: number;
  health: TickHealth;
}

export class Ticker {
  readonly #work: () => Promise<unknown>;
  readonly #intervalMs: number;
  #timer: NodeJS.Timeout | null = null;
  #running = false;
  #lastTickAt: string | null = null;
  #lastError: string | null = null;
  #ticks = 0;
  #failures = 0;

  constructor(work: () => Promise<unknown>, intervalMs: number = TICK_INTERVAL_MS) {
    this.#work = work;
    this.#intervalMs = intervalMs;
  }

  start(): void {
    if (this.#timer !== null) return;
    // unref() so the interval alone does not hold the process open; the HTTP
    // server is what keeps it alive, and Ctrl-C should not have to wait out a
    // two-minute timer.
    this.#timer = setInterval(() => void this.tick(), this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * Run one tick now. Returns what the work returned, or null if a tick was
   * already in flight — the caller can tell "skipped" from "ran and found
   * nothing", which a bare boolean would hide.
   */
  async tick(): Promise<unknown> {
    if (this.#running) return null;
    this.#running = true;
    try {
      const result = await this.#work();
      this.#lastTickAt = new Date().toISOString();
      this.#lastError = null;
      this.#ticks += 1;
      return result;
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      this.#failures += 1;
      console.error(JSON.stringify({ event: "tick_failed", error: this.#lastError }));
      return null;
    } finally {
      this.#running = false;
    }
  }

  status(now: Date = new Date()): TickerStatus {
    return {
      running: this.#timer !== null,
      lastTickAt: this.#lastTickAt,
      lastError: this.#lastError,
      ticks: this.#ticks,
      failures: this.#failures,
      health: tickHealth(this.#lastTickAt, now.getTime(), this.#intervalMs),
    };
  }
}
