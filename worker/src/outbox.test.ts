import { describe, it, expect } from "vitest";
import {
  classifySmtpFailure,
  backoffMs,
  nextAttemptAt,
  isDue,
  isAbandoned,
  isAmbiguous,
  MAX_ATTEMPTS,
  SENDING_TIMEOUT_MS,
  type OutboxRow,
} from "./outbox";

const row = (over: Partial<OutboxRow> = {}): OutboxRow => ({
  state: "pending",
  attempts: 0,
  nextAttemptAt: "2026-09-17T06:00:00.000Z",
  sendingSince: null,
  ...over,
});

describe("classifySmtpFailure", () => {
  // 5xx is the server saying "never"; retrying just re-sends a rejection.
  it("treats 5xx as permanent", () => {
    expect(classifySmtpFailure("550")).toBe("permanent");
    expect(classifySmtpFailure("553")).toBe("permanent");
    expect(classifySmtpFailure("535")).toBe("permanent");
  });

  // 4xx is "not now" - greylisting, rate limits, temporary refusals.
  it("treats 4xx as transient", () => {
    expect(classifySmtpFailure("421")).toBe("transient");
    expect(classifySmtpFailure("450")).toBe("transient");
    expect(classifySmtpFailure("452")).toBe("transient");
  });

  // Fail safe: an unrecognised code must not silently drop an employee's mail.
  // MAX_ATTEMPTS still stops it retrying forever.
  it("treats an unknown or missing code as transient", () => {
    expect(classifySmtpFailure("")).toBe("transient");
    expect(classifySmtpFailure("???")).toBe("transient");
    expect(classifySmtpFailure("250")).toBe("transient");
  });
});

describe("backoffMs", () => {
  it("grows with each attempt", () => {
    expect(backoffMs(1)).toBeLessThan(backoffMs(2));
    expect(backoffMs(2)).toBeLessThan(backoffMs(3));
  });

  it("starts in the tens of seconds, not milliseconds", () => {
    expect(backoffMs(1)).toBeGreaterThanOrEqual(30_000);
  });

  // Unbounded doubling would push a retry beyond any useful response deadline.
  it("is capped", () => {
    expect(backoffMs(50)).toBe(backoffMs(99));
    expect(backoffMs(99)).toBeLessThanOrEqual(60 * 60 * 1000);
  });
});

describe("nextAttemptAt", () => {
  it("returns an ISO timestamp in the future", () => {
    const now = new Date("2026-09-17T06:00:00.000Z");
    const next = nextAttemptAt(1, now);
    expect(new Date(next).getTime()).toBeGreaterThan(now.getTime());
    expect(next).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("isDue", () => {
  const now = new Date("2026-09-17T06:00:00.000Z");

  it("is due when pending and the wait has passed", () => {
    expect(isDue(row({ nextAttemptAt: "2026-09-17T05:59:59.000Z" }), now)).toBe(true);
  });

  it("is not due while still waiting out the backoff", () => {
    expect(isDue(row({ nextAttemptAt: "2026-09-17T06:00:01.000Z" }), now)).toBe(false);
  });

  it("is never due once accepted or failed", () => {
    const past = "2026-09-17T05:00:00.000Z";
    expect(isDue(row({ state: "accepted", nextAttemptAt: past }), now)).toBe(false);
    expect(isDue(row({ state: "failed", nextAttemptAt: past }), now)).toBe(false);
    expect(isDue(row({ state: "ambiguous", nextAttemptAt: past }), now)).toBe(false);
  });

  // A row mid-flight must not be picked up by an overlapping run, or the
  // employee gets the message twice.
  it("is never due while a send is in flight", () => {
    expect(isDue(row({ state: "sending", nextAttemptAt: "2026-09-17T05:00:00.000Z" }), now)).toBe(
      false,
    );
  });
});

describe("isAbandoned", () => {
  it("is abandoned once attempts are exhausted", () => {
    expect(isAbandoned(MAX_ATTEMPTS)).toBe(true);
    expect(isAbandoned(MAX_ATTEMPTS + 1)).toBe(true);
  });

  it("is not abandoned before that", () => {
    expect(isAbandoned(MAX_ATTEMPTS - 1)).toBe(false);
    expect(isAbandoned(0)).toBe(false);
  });
});

// The dangerous case (PRD open point 4): we wrote the message, the server may
// have accepted it, and we died before recording that. Resending risks a
// duplicate to a real person; dropping it risks silence. Neither is safe to
// choose automatically, so it is surfaced to IT instead.
describe("isAmbiguous", () => {
  const now = new Date("2026-09-17T06:10:00.000Z");

  it("flags a send that has been in flight too long", () => {
    const stuck = row({
      state: "sending",
      sendingSince: new Date(now.getTime() - SENDING_TIMEOUT_MS - 1000).toISOString(),
    });
    expect(isAmbiguous(stuck, now)).toBe(true);
  });

  it("does not flag a send that is still within the window", () => {
    const recent = row({
      state: "sending",
      sendingSince: new Date(now.getTime() - 1000).toISOString(),
    });
    expect(isAmbiguous(recent, now)).toBe(false);
  });

  it("only applies to rows that are sending", () => {
    const old = new Date(now.getTime() - SENDING_TIMEOUT_MS - 1000).toISOString();
    expect(isAmbiguous(row({ state: "pending", sendingSince: old }), now)).toBe(false);
    expect(isAmbiguous(row({ state: "accepted", sendingSince: old }), now)).toBe(false);
  });

  it("is not ambiguous when no send was ever started", () => {
    expect(isAmbiguous(row({ state: "sending", sendingSince: null }), now)).toBe(false);
  });
});
