import { describe, it, expect } from "vitest";
import { Ticker } from "./ticker.ts";

/**
 * These replace the Durable Object alarm tests.
 *
 * The alarm had to reschedule itself *before* doing its work, because one
 * failed tick would otherwise end the chain forever. setInterval keeps firing
 * on its own, so that particular hazard is gone — but the two properties it
 * protected are not, and they are what is tested here: a tick that throws must
 * not stop the loop, and two ticks must never run at once.
 */
describe("Ticker", () => {
  it("keeps going after a tick throws", async () => {
    let calls = 0;
    const ticker = new Ticker(() => {
      calls += 1;
      if (calls === 1) throw new Error("IMAP refused the connection");
      return Promise.resolve("ok");
    });

    expect(await ticker.tick()).toBeNull();
    expect(ticker.status().lastError).toContain("IMAP refused");
    // The failure is recorded, not propagated: a caller that let this throw
    // would take the interval with it.
    expect(await ticker.tick()).toBe("ok");
    expect(ticker.status().failures).toBe(1);
    expect(ticker.status().ticks).toBe(1);
  });

  /**
   * The mutual exclusion the Durable Object gave by being single-threaded.
   * Two concurrent polls can both claim the same outbox row, and the employee
   * receives the message twice.
   */
  it("refuses to start a tick while one is in flight", async () => {
    let release = (): void => undefined;
    const started: number[] = [];
    const ticker = new Ticker(async () => {
      started.push(1);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return "done";
    });

    const first = ticker.tick();
    const second = await ticker.tick();
    // Skipped, distinguishable from "ran and found nothing".
    expect(second).toBeNull();
    expect(started).toHaveLength(1);

    release();
    expect(await first).toBe("done");
  });

  it("clears the last error once a tick succeeds", async () => {
    let fail = true;
    const ticker = new Ticker(() => {
      if (fail) throw new Error("transient");
      return Promise.resolve(1);
    });
    await ticker.tick();
    expect(ticker.status().lastError).not.toBeNull();
    fail = false;
    await ticker.tick();
    expect(ticker.status().lastError).toBeNull();
  });

  // Never having ticked is not health. A watchdog that treated it as healthy
  // would never notice a loop that failed to start.
  it("reports stalled before the first tick", () => {
    const ticker = new Ticker(() => Promise.resolve(null));
    expect(ticker.status().health.stalled).toBe(true);
    expect(ticker.status().running).toBe(false);
  });

  it("reports healthy immediately after a tick, and stalled after long silence", async () => {
    const ticker = new Ticker(() => Promise.resolve(null), 1_000);
    await ticker.tick();
    expect(ticker.status().health.stalled).toBe(false);
    // Three intervals of quiet is the documented tolerance.
    expect(ticker.status(new Date(Date.now() + 10_000)).health.stalled).toBe(true);
  });

  it("start is idempotent and stop actually stops", () => {
    const ticker = new Ticker(() => Promise.resolve(null), 60_000);
    ticker.start();
    ticker.start();
    expect(ticker.status().running).toBe(true);
    ticker.stop();
    expect(ticker.status().running).toBe(false);
    ticker.stop();
  });
});
