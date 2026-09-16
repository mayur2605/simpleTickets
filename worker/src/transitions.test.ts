import { describe, it, expect } from "vitest";
import { transitionRule, STATUSES } from "./transitions";

describe("transitionRule", () => {
  // Internal progress needs no email, so it applies at once.
  it("lets IT pick a ticket up immediately", () => {
    expect(transitionRule("New", "In Progress")).toEqual({ kind: "immediate" });
  });

  // R28: these take effect only when the mail server ACCEPTS the message.
  // Flipping the status first would tell IT the employee had been asked
  // something, or told their issue was fixed, when no mail had gone out.
  it("gates Waiting for Employee on delivery", () => {
    expect(transitionRule("In Progress", "Waiting for Employee")).toEqual({
      kind: "delivery-gated",
      intent: "reply",
    });
  });

  it("gates Resolved on delivery", () => {
    expect(transitionRule("In Progress", "Resolved")).toEqual({
      kind: "delivery-gated",
      intent: "resolution",
    });
  });

  // R28: manual closure is still gated - the ticket stays Resolved until the
  // closure email is accepted.
  it("gates closure on delivery", () => {
    expect(transitionRule("Resolved", "Closed")).toEqual({
      kind: "delivery-gated",
      intent: "closure",
    });
  });

  it("refuses closing a ticket that was never resolved", () => {
    expect(transitionRule("New", "Closed").kind).toBe("invalid");
    expect(transitionRule("In Progress", "Closed").kind).toBe("invalid");
  });

  it("refuses a no-op", () => {
    expect(transitionRule("New", "New").kind).toBe("invalid");
    expect(transitionRule("Resolved", "Resolved").kind).toBe("invalid");
  });

  // A closed ticket reopens when the employee writes again, not by IT flipping
  // it back - otherwise the employee is never told anything changed.
  it("refuses reopening a closed ticket by hand", () => {
    expect(transitionRule("Closed", "In Progress").kind).toBe("invalid");
    expect(transitionRule("Closed", "New").kind).toBe("invalid");
  });

  it("lets a waiting ticket be picked back up without an email", () => {
    expect(transitionRule("Waiting for Employee", "In Progress")).toEqual({ kind: "immediate" });
  });

  it("refuses moving backwards to New", () => {
    expect(transitionRule("In Progress", "New").kind).toBe("invalid");
  });

  it("covers every declared status", () => {
    expect(STATUSES).toEqual(["New", "In Progress", "Waiting for Employee", "Resolved", "Closed"]);
    // Every pair must produce a decision rather than throwing.
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        expect(transitionRule(from, to).kind).toBeTruthy();
      }
    }
  });
});
