import { describe, it, expect } from "vitest";
import { buildNotification, type NotificationKind } from "./notification.ts";
import { buildMessage } from "./mime.ts";

const base = {
  ticketNumber: 42,
  ticketSubject: "Laptop will not boot",
  requester: "ananya.rao@allcheckservices.com",
  supportAddress: "SimpleTickets <support@allcheckservices.com>",
  dashboardUrl: "http://localhost:8787",
  recipient: "staff2@allcheckservices.com",
  date: new Date("2026-09-17T10:00:00.000Z"),
};

const kinds: NotificationKind[] = ["assigned", "employee_reply", "overdue", "delivery_failed"];

describe("staff notifications", () => {
  it("links every kind to the ticket in the dashboard", () => {
    for (const kind of kinds) {
      expect(buildNotification({ ...base, kind }).body).toContain(
        "http://localhost:8787/tickets/42",
      );
    }
  });

  it("does not double the slash when the dashboard URL has a trailing one", () => {
    const message = buildNotification({ ...base, kind: "assigned", dashboardUrl: "http://x/" });
    expect(message.body).toContain("http://x/tickets/42");
  });

  /**
   * R15: replying to a notification must neither reach the ticket nor satisfy
   * a deadline. IT staff are on the approved sender domain, so nothing about
   * the address stops their reply being ingested — these two headers and the
   * exclusion in store.findTicketByMessageIds are what do.
   */
  it("is one-way: Reply-To points away, and it says so", () => {
    const message = buildNotification({ ...base, kind: "assigned" });
    expect(message.replyTo).toBe("no-reply@allcheckservices.com");
    expect(message.autoSubmitted).toBe(true);
    expect(message.body).toContain("Do not reply");
    expect(message.body).toContain("does not satisfy the response deadline");

    const raw = buildMessage(message);
    expect(raw).toContain("Reply-To: no-reply@allcheckservices.com");
    expect(raw).toContain("Auto-Submitted: auto-replied");
  });

  /**
   * The Message-ID prefix is not cosmetic: it is how a notification is
   * recognisable in the outbox, and it is distinct from an acknowledgement's
   * or a reply's so the two can never be confused.
   */
  it("carries a distinguishable, unique Message-ID", () => {
    const a = buildNotification({ ...base, kind: "assigned" });
    const b = buildNotification({ ...base, kind: "overdue" });
    expect(a.messageId).toMatch(/^<notify\.assigned\.42\./);
    expect(b.messageId).toMatch(/^<notify\.overdue\.42\./);
    expect(a.messageId).not.toBe(b.messageId);
  });

  it("carries the ticket tag in the subject", () => {
    for (const kind of kinds) {
      expect(buildNotification({ ...base, kind }).subject).toContain("[#42]");
    }
  });

  it("states how long a response has been overdue, and how to stop the reminders", () => {
    const message = buildNotification({ ...base, kind: "overdue", minutesOverdue: 135 });
    expect(message.body).toContain("2h 15m ago");
    expect(message.body).toContain("every four working hours until you reply");
  });

  it("falls back gracefully when the overdue amount is unknown", () => {
    const message = buildNotification({ ...base, kind: "overdue" });
    expect(message.body).toContain("deadline has passed");
    expect(message.body).not.toContain("NaN");
    expect(message.body).not.toContain("undefined");
  });

  // R28: a bounce after acceptance pauses auto-close, and the assignee has to
  // know why a ticket stopped moving.
  it("explains a delivery failure and its effect on auto-close", () => {
    const message = buildNotification({ ...base, kind: "delivery_failed" });
    expect(message.body).toContain("bounced");
    expect(message.body).toContain("Automatic closure is paused");
  });

  /**
   * Constitution III: an internal note must never reach email. The guarantee
   * here is structural — there is no parameter through which note text could
   * arrive — so this asserts the shape of the input, which is the thing that
   * would have to change for the guarantee to break.
   */
  it("has no way to carry conversation or note content", () => {
    const message = buildNotification({ ...base, kind: "employee_reply" });
    // Subject and requester only; nothing that could hold a note body.
    expect(message.body).toContain("Laptop will not boot");
    expect(message.body).toContain("ananya.rao@allcheckservices.com");
    expect(Object.keys(base)).not.toContain("body");
    expect(message.body.split("\n").length).toBeLessThan(15);
  });

  /**
   * The ticket subject came from an employee's email and is attacker
   * controlled. It never reaches a header: the notification's own Subject is
   * composed from our text plus the ticket number, and the employee's wording
   * appears only in the body, after the header/body separator, where a CRLF
   * injects nothing.
   *
   * This is stronger than refusing the input, and it is worth pinning: someone
   * "improving" the subject line to include the employee's wording would turn
   * an attacker-controlled string into a header without noticing.
   */
  it("keeps an attacker-controlled subject out of every header", () => {
    const hostile = "x\r\nBcc: attacker@example.com";
    const raw = buildMessage(
      buildNotification({ ...base, kind: "assigned", ticketSubject: hostile }),
    );
    // Split on the FIRST blank line only: the body has blank lines of its own.
    const separator = raw.indexOf("\r\n\r\n");
    const headers = raw.slice(0, separator);
    const body = raw.slice(separator);
    expect(headers).not.toContain("Bcc:");
    expect(headers).toContain("Subject: [#42] Ticket #42 is yours");
    // It does appear in the body, which is where untrusted text belongs.
    expect(body).toContain("Bcc: attacker@example.com");
  });
});

describe("the unassigned alert (R24)", () => {
  it("says nobody has it and that the clock is still running", () => {
    const message = buildNotification({
      kind: "unassigned",
      ticketNumber: 42,
      ticketSubject: "Printer jams",
      requester: "ananya.rao@allcheckservices.com",
      supportAddress: "SimpleTickets <support@allcheckservices.com>",
      dashboardUrl: "http://localhost:8787",
      recipient: "staff1@allcheckservices.com",
      date: new Date("2026-09-17T10:00:00.000Z"),
    });
    expect(message.subject).toContain("[#42]");
    expect(message.body).toContain("has not been assigned");
    // The deadline does not pause because nobody picked it up, and an alert
    // that failed to say so would be read as "deal with it whenever".
    expect(message.body).toContain("deadline is running");
    expect(message.body).toContain("http://localhost:8787/tickets/42");
  });

  // Same guarantee as every other kind: a staff reply to this must not thread.
  it("is one-way like the rest", () => {
    const message = buildNotification({
      kind: "unassigned",
      ticketNumber: 1,
      ticketSubject: "x",
      requester: "a@allcheckservices.com",
      supportAddress: "SimpleTickets <support@allcheckservices.com>",
      dashboardUrl: "http://localhost:8787",
      recipient: "staff1@allcheckservices.com",
      date: new Date(),
    });
    expect(message.messageId).toContain("notify.unassigned.");
    expect(message.autoSubmitted).toBe(true);
    expect(message.replyTo).toBe("no-reply@allcheckservices.com");
  });
});
