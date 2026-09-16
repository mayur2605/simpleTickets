/**
 * The Durable Object that drives ingestion, replacing Cloudflare's cron
 * triggers (which do not fire on this account - see docs/stack-validation.md).
 *
 * Why a Durable Object rather than an external scheduler: it stays inside
 * Cloudflare, so no third party has to hold ADMIN_TOKEN, and a Durable Object
 * is single-threaded. Two ticks can never overlap, which is the mutual
 * exclusion T010 asks for and that cron never provided - with cron, overlapping
 * runs were safe only because ingestion is idempotent.
 */
import { ingest, flushOutbox, type Env } from "./pipeline";
import { runTick, TICK_INTERVAL_MS } from "./tick";
import { tickHealth } from "./health";

interface TickRecord {
  at: string;
  ingested: number;
  sent: number;
  error: string | null;
}

export class Ticker implements DurableObject {
  readonly #ctx: DurableObjectState;
  readonly #env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.#ctx = ctx;
    this.#env = env;
  }

  /**
   * Re-arm the chain if it should be running and is not.
   *
   * The `wanted` flag is what separates "the chain died" from "someone stopped
   * it on purpose". Without it, healing would fight every deliberate stop and
   * there would be no way to turn the system off.
   *
   * Idempotent: an alarm that is already set is left alone, so healing can be
   * called as often as anything likes without ever producing a second chain.
   */
  async #heal(): Promise<boolean> {
    const wanted = (await this.#ctx.storage.get<boolean>("wanted")) ?? false;
    if (!wanted) return false;
    if ((await this.#ctx.storage.getAlarm()) !== null) return false;
    await this.#ctx.storage.setAlarm(Date.now() + 1000);
    console.log(JSON.stringify({ source: "ticker", healed: true, at: new Date().toISOString() }));
    return true;
  }

  /**
   * Control surface, reached only through the worker's own token-gated routes.
   */
  async fetch(request: Request): Promise<Response> {
    const action = new URL(request.url).pathname;

    if (action === "/start") {
      await this.#ctx.storage.put("wanted", true);
      const existing = await this.#ctx.storage.getAlarm();
      if (existing === null) {
        await this.#ctx.storage.setAlarm(Date.now() + 1000);
      }
      return Response.json({
        started: true,
        alreadyRunning: existing !== null,
        nextAlarm: new Date(existing ?? Date.now() + 1000).toISOString(),
      });
    }

    if (action === "/stop") {
      // Recorded before the alarm is removed, so a tick landing in between
      // cannot reschedule a chain that has just been told to stop.
      await this.#ctx.storage.put("wanted", false);
      await this.#ctx.storage.deleteAlarm();
      return Response.json({ stopped: true });
    }

    // Any read of the status also heals, so every glance at the system is a
    // chance to notice it has stopped and restart it.
    const healed = await this.#heal();

    const wanted = (await this.#ctx.storage.get<boolean>("wanted")) ?? false;
    const alarm = await this.#ctx.storage.getAlarm();
    const last = await this.#ctx.storage.get<TickRecord>("last");
    const health = tickHealth(last?.at ?? null, Date.now(), TICK_INTERVAL_MS);

    return Response.json({
      wanted,
      running: alarm !== null,
      // Stalled only counts when the chain is supposed to be running; a
      // deliberately stopped ticker is quiet, not broken.
      stalled: wanted && health.stalled,
      healed,
      silentMinutes: health.silentMinutes,
      nextAlarm: alarm === null ? null : new Date(alarm).toISOString(),
      intervalMs: TICK_INTERVAL_MS,
      last: last ?? null,
    });
  }

  async alarm(): Promise<void> {
    // A tick that runs after a stop was requested must not reschedule itself.
    if (!((await this.#ctx.storage.get<boolean>("wanted")) ?? false)) {
      return;
    }

    let ingested = 0;
    let sent = 0;

    // runTick reschedules BEFORE running the work, so a failing poll costs one
    // cycle rather than ending the chain forever.
    const result = await runTick(
      this.#ctx.storage,
      async () => {
        const summary = await ingest(this.#env);
        const outbox = await flushOutbox(this.#env);
        ingested = summary.created + summary.appended;
        sent = outbox.sent;
      },
      Date.now(),
    );

    const record: TickRecord = {
      at: new Date().toISOString(),
      ingested,
      sent,
      error: result.error,
    };
    await this.#ctx.storage.put("last", record);
    // Counts only: subjects and addresses stay out of the logs.
    console.log(JSON.stringify({ source: "ticker", ...record }));
  }
}
