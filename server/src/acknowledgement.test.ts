import { describe, it, expect } from "vitest";
import { buildAcknowledgement, subjectWithTicket } from "./acknowledgement.ts";
import { buildMessage, HeaderInjectionError } from "./mime.ts";

const base = {
  ticketNumber: 42,
  originalSubject: "Printer not working",
  requester: "ananya.rao@allcheckservices.com",
  supportAddress: "SimpleTickets <simpleticketssupport@gmail.com>",
  inboundMessageId: "<abc@mail.gmail.com>",
  date: new Date("2026-09-17T06:30:00Z"),
};

describe("subjectWithTicket", () => {
  it("prefixes the ticket number", () => {
    expect(subjectWithTicket(42, "Printer not working")).toBe("[#42] Printer not working");
  });

  // Otherwise every round trip grows another tag: "[#42] [#42] [#42] ...".
  it("does not double a tag that is already there", () => {
    expect(subjectWithTicket(42, "[#42] Printer not working")).toBe("[#42] Printer not working");
    expect(subjectWithTicket(42, "Re: [#42] Printer not working")).toBe(
      "Re: [#42] Printer not working",
    );
  });

  it("does not treat a different ticket's tag as its own", () => {
    expect(subjectWithTicket(42, "[#7] Printer not working")).toBe(
      "[#42] [#7] Printer not working",
    );
  });

  it("still produces a usable subject when the original is empty", () => {
    expect(subjectWithTicket(42, "")).toBe("[#42] (no subject)");
    expect(subjectWithTicket(42, "   ")).toBe("[#42] (no subject)");
  });
});

describe("buildAcknowledgement", () => {
  it("addresses the requester and carries the ticket number in the subject", () => {
    const ack = buildAcknowledgement(base);
    expect(ack.to).toEqual(["ananya.rao@allcheckservices.com"]);
    expect(ack.subject).toBe("[#42] Printer not working");
  });

  it("states the ticket number in the body", () => {
    expect(buildAcknowledgement(base).body).toContain("#42");
  });

  // spec.md: "Merely knowing a ticket number is insufficient." Threading has to
  // work off real headers, so a reply lands on this ticket.
  it("threads to the message that opened the ticket", () => {
    const ack = buildAcknowledgement(base);
    expect(ack.inReplyTo).toBe("<abc@mail.gmail.com>");
    expect(ack.references).toEqual(["<abc@mail.gmail.com>"]);
  });

  it("omits threading headers when the inbound message had no Message-ID", () => {
    const ack = buildAcknowledgement({ ...base, inboundMessageId: null });
    expect(ack.inReplyTo).toBeUndefined();
    expect(ack.references).toBeUndefined();
  });

  it("gives each acknowledgement its own Message-ID", () => {
    const a = buildAcknowledgement(base);
    const b = buildAcknowledgement({ ...base, ticketNumber: 43 });
    expect(a.messageId).not.toBe(b.messageId);
    expect(a.messageId).toMatch(/^<.+>$/);
  });

  // RFC 3834. Without this, this auto-reply and someone's out-of-office can
  // answer each other indefinitely.
  it("marks itself as an automatic reply so it cannot start a loop", () => {
    expect(buildAcknowledgement(base).autoSubmitted).toBe(true);
    expect(buildMessage(buildAcknowledgement(base))).toContain("Auto-Submitted: auto-replied\r\n");
  });

  // The subject came from employee mail, so it is attacker-controlled all the
  // way through to the built message.
  it("refuses a subject carrying a header injection", () => {
    const ack = buildAcknowledgement({
      ...base,
      originalSubject: "x\r\nBcc: attacker@evil.test",
    });
    expect(() => buildMessage(ack)).toThrow(HeaderInjectionError);
  });
});
