import { describe, it, expect } from "vitest";
import { tickHealth, STALL_TOLERANCE } from "./health";

const interval = 120_000;
const now = Date.parse("2026-09-17T06:00:00.000Z");
const ago = (ms: number) => new Date(now - ms).toISOString();

describe("tickHealth", () => {
  it("is healthy just after a tick", () => {
    expect(tickHealth(ago(10_000), now, interval).stalled).toBe(false);
  });

  // One late tick is normal: a slow IMAP dialogue, a retried alarm. Declaring a
  // stall on the first missed beat would restart a chain that is merely busy,
  // and two chains polling is worse than one running late.
  it("tolerates a single missed interval", () => {
    expect(tickHealth(ago(interval * 1.5), now, interval).stalled).toBe(false);
  });

  it("is stalled once several intervals have passed", () => {
    expect(tickHealth(ago(interval * (STALL_TOLERANCE + 1)), now, interval).stalled).toBe(true);
  });

  // Never ticked and no alarm pending is a chain that never started, which is
  // exactly as broken as one that stopped.
  it("treats a chain that never ticked as stalled", () => {
    expect(tickHealth(null, now, interval).stalled).toBe(true);
  });

  it("reports how long it has been quiet", () => {
    const health = tickHealth(ago(300_000), now, interval);
    expect(health.silentMs).toBe(300_000);
    expect(health.silentMinutes).toBe(5);
  });

  it("reports null silence when it never ticked", () => {
    expect(tickHealth(null, now, interval).silentMs).toBeNull();
  });

  // A clock skew or a bad stored value must not read as healthy forever.
  it("treats an unparseable timestamp as stalled", () => {
    expect(tickHealth("not a date", now, interval).stalled).toBe(true);
  });

  it("treats a future timestamp as healthy rather than negative-silent", () => {
    const health = tickHealth(new Date(now + 60_000).toISOString(), now, interval);
    expect(health.stalled).toBe(false);
    expect(health.silentMs).toBe(0);
  });
});
