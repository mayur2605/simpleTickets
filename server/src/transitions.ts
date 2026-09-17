/**
 * Which status changes are allowed, and which must wait for mail to be
 * accepted (R09, R10, R28).
 *
 * Pure: a lookup, no storage and no sending.
 *
 * The distinction this encodes is the whole of R28. Some transitions are
 * internal bookkeeping and apply at once. Others are a promise made to the
 * employee - that they have been asked for something, that their problem is
 * fixed, that the ticket is closed - and those must not take effect until the
 * mail server has accepted the message that says so. Flipping the status first
 * would show IT a ticket "Waiting for Employee" when the employee was never
 * asked anything.
 */
import type { OutboxIntent } from "./store.ts";

export const STATUSES = [
  "New",
  "In Progress",
  "Waiting for Employee",
  "Resolved",
  "Closed",
] as const;

export type Status = (typeof STATUSES)[number];

export type TransitionRule =
  | { kind: "immediate" }
  | { kind: "delivery-gated"; intent: OutboxIntent }
  | { kind: "invalid"; reason: string };

export function transitionRule(from: Status, to: Status): TransitionRule {
  if (from === to) {
    return { kind: "invalid", reason: `Ticket is already ${to}.` };
  }

  // A closed ticket reopens when the employee writes again (T011), never by IT
  // flipping it back - otherwise the employee is never told anything changed.
  if (from === "Closed") {
    return {
      kind: "invalid",
      reason: "A closed ticket reopens when the employee replies, not by hand.",
    };
  }

  if (to === "New") {
    return { kind: "invalid", reason: "A ticket cannot go back to New." };
  }

  if (to === "Closed") {
    return from === "Resolved"
      ? { kind: "delivery-gated", intent: "closure" }
      : { kind: "invalid", reason: "Only a Resolved ticket can be closed." };
  }

  if (to === "Resolved") {
    return { kind: "delivery-gated", intent: "resolution" };
  }

  if (to === "Waiting for Employee") {
    return { kind: "delivery-gated", intent: "reply" };
  }

  // In Progress: picking a ticket up, or taking a waiting one back. Internal,
  // so nothing needs to be sent.
  return { kind: "immediate" };
}
