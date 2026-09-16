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
   * Control surface, reached only through the worker's own token-gated routes.
   *
   * `start` is idempotent: setting an alarm that is already set simply moves
   * it, so calling it twice cannot produce two chains.
   */
  async fetch(request: Request): Promise<Response> {
    const action = new URL(request.url).pathname;

    if (action === "/start") {
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
      await this.#ctx.storage.deleteAlarm();
      return Response.json({ stopped: true });
    }

    const alarm = await this.#ctx.storage.getAlarm();
    const last = await this.#ctx.storage.get<TickRecord>("last");
    return Response.json({
      running: alarm !== null,
      nextAlarm: alarm === null ? null : new Date(alarm).toISOString(),
      intervalMs: TICK_INTERVAL_MS,
      last: last ?? null,
    });
  }

  async alarm(): Promise<void> {
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
