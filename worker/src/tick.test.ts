import { describe, it, expect } from "vitest";
import { runTick, TICK_INTERVAL_MS } from "./tick";

function recorder() {
  const order: string[] = [];
  let alarmAt: number | null = null;
  return {
    order,
    get alarmAt() {
      return alarmAt;
    },
    storage: {
      setAlarm(at: number) {
        order.push("setAlarm");
        alarmAt = at;
        return Promise.resolve();
      },
    },
  };
}

const now = 1_770_000_000_000;

describe("runTick", () => {
  // THE property. Reschedule first, work second. Do it the other way round and
  // a single failing poll ends the chain forever: no alarm is ever set again,
  // and the system stops silently with no error anyone sees.
  it("schedules the next tick BEFORE doing the work", async () => {
    const r = recorder();
    await runTick(
      r.storage,
      () => {
        r.order.push("work");
        return Promise.resolve();
      },
      now,
    );
    expect(r.order).toEqual(["setAlarm", "work"]);
  });

  it("keeps ticking when the work throws", async () => {
    const r = recorder();
    const result = await runTick(r.storage, () => Promise.reject(new Error("IMAP down")), now);
    expect(r.order).toContain("setAlarm");
    expect(r.alarmAt).toBe(now + TICK_INTERVAL_MS);
    expect(result.error).toContain("IMAP down");
  });

  it("reports success when the work succeeds", async () => {
    const r = recorder();
    const result = await runTick(r.storage, () => Promise.resolve(), now);
    expect(result.error).toBeNull();
  });

  it("schedules exactly one interval ahead", async () => {
    const r = recorder();
    await runTick(r.storage, () => Promise.resolve(), now);
    expect(r.alarmAt).toBe(now + TICK_INTERVAL_MS);
  });

  // R02 asks for two minutes.
  it("ticks every two minutes", () => {
    expect(TICK_INTERVAL_MS).toBe(120_000);
  });

  // A throwing alarm is retried by the platform. If that retry also set an
  // alarm we could end up with two chains ticking, doubling the poll rate.
  // Swallowing the error after rescheduling keeps exactly one chain alive.
  it("does not rethrow, so the platform does not retry a already-rescheduled tick", async () => {
    const r = recorder();
    await expect(
      runTick(r.storage, () => Promise.reject(new Error("boom")), now),
    ).resolves.toBeDefined();
  });
});
