import { describe, it, expect } from "vitest";
import { responseState } from "./overdue";

const now = new Date("2026-09-17T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString();

describe("responseState", () => {
  it("is overdue once the deadline has passed with no reply", () => {
    const state = responseState(iso(-60_000), null, "In Progress", now);
    expect(state.overdue).toBe(true);
    expect(state.met).toBe(false);
  });

  it("is not overdue before the deadline", () => {
    const state = responseState(iso(60_000), null, "New", now);
    expect(state.overdue).toBe(false);
    expect(state.minutesRemaining).toBe(1);
  });

  // R28: the deadline is met by a real reply from IT. The automatic
  // acknowledgement is not stored as an outbound message precisely so it cannot
  // satisfy this - answering someone with "we got your email" is not an answer.
  it("is met once IT has actually replied", () => {
    const state = responseState(iso(-60_000), iso(-120_000), "In Progress", now);
    expect(state.met).toBe(true);
    expect(state.overdue).toBe(false);
  });

  // A ticket opened before deadlines existed has none. Treating a missing
  // deadline as breached would show every old ticket as overdue the moment the
  // feature shipped.
  it("is never overdue without a deadline", () => {
    expect(responseState(null, null, "New", now).overdue).toBe(false);
    expect(responseState(null, null, "New", now).minutesRemaining).toBeNull();
  });

  // Finished work is not waiting on a response.
  it("is never overdue once resolved or closed", () => {
    expect(responseState(iso(-999_999), null, "Resolved", now).overdue).toBe(false);
    expect(responseState(iso(-999_999), null, "Closed", now).overdue).toBe(false);
  });

  it("reports how overdue it is, for sorting the worst first", () => {
    expect(responseState(iso(-3_600_000), null, "New", now).minutesOverdue).toBe(60);
    expect(responseState(iso(60_000), null, "New", now).minutesOverdue).toBeNull();
  });

  it("treats an unparseable deadline as not overdue rather than inventing one", () => {
    expect(responseState("not a date", null, "New", now).overdue).toBe(false);
  });
});
