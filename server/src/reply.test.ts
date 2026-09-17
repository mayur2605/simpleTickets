import { describe, it, expect } from "vitest";
import { buildReply } from "./reply.ts";
import { buildMessage, HeaderInjectionError } from "./mime.ts";

const base = {
  ticketNumber: 7,
  ticketSubject: "Printer not working",
  requester: "ananya.rao@allcheckservices.com",
  supportAddress: "SimpleTickets <simpleticketssupport@gmail.com>",
  body: "We have reset the print queue. Please try again.",
  // Message-IDs already on the thread, oldest first.
  threadMessageIds: ["<root@hxcore.ol>", "<ack.7.1@simpletickets>"],
  date: new Date("2026-09-17T07:00:00Z"),
};

describe("buildReply", () => {
  it("addresses the requester and tags the subject", () => {
    const reply = buildReply(base);
    expect(reply.to).toEqual(["ananya.rao@allcheckservices.com"]);
    expect(reply.subject).toBe("[#7] Printer not working");
  });

  it("carries the IT message as the body", () => {
    expect(buildReply(base).body).toContain("We have reset the print queue.");
  });

  // Threads onto the newest message so it lands in the employee's existing
  // conversation rather than starting a new one in their client.
  it("replies to the most recent message on the thread", () => {
    const reply = buildReply(base);
    expect(reply.inReplyTo).toBe("<ack.7.1@simpletickets>");
    expect(reply.references).toEqual(["<root@hxcore.ol>", "<ack.7.1@simpletickets>"]);
  });

  it("still sends when the thread has no usable ids", () => {
    const reply = buildReply({ ...base, threadMessageIds: [] });
    expect(reply.inReplyTo).toBeUndefined();
    expect(reply.references).toBeUndefined();
    expect(reply.to).toEqual(["ananya.rao@allcheckservices.com"]);
  });

  // A human pressed send, so this is NOT an automatic message. Marking it
  // auto-replied would tell the employee's client not to answer it - the
  // opposite of what a reply asking for information needs.
  it("is not marked as an automatic reply", () => {
    expect(buildReply(base).autoSubmitted).toBeUndefined();
    expect(buildMessage(buildReply(base))).not.toContain("Auto-Submitted:");
  });

  it("gives each reply its own Message-ID", () => {
    const a = buildReply(base);
    const b = buildReply({ ...base, date: new Date("2026-09-17T07:05:00Z") });
    expect(a.messageId).not.toBe(b.messageId);
  });

  it("refuses a subject carrying a header injection", () => {
    const reply = buildReply({ ...base, ticketSubject: "x\r\nBcc: attacker@evil.test" });
    expect(() => buildMessage(reply)).toThrow(HeaderInjectionError);
  });

  it("refuses an empty reply rather than mailing a blank message", () => {
    expect(() => buildReply({ ...base, body: "   " })).toThrow();
    expect(() => buildReply({ ...base, body: "" })).toThrow();
  });
});

/**
 * R25: eligible CC participants are copied on public replies.
 *
 * Header and envelope are separate problems and both matter. A colleague in the
 * Cc header but missing from RCPT TO sees their own name on a message they
 * never received, which is worse than not being copied at all.
 */
describe("buildReply with CC participants", () => {
  const base = {
    ticketNumber: 42,
    ticketSubject: "Printer jams",
    requester: "ananya.rao@allcheckservices.com",
    supportAddress: "SimpleTickets <support@allcheckservices.com>",
    body: "We have ordered a new roller.",
    threadMessageIds: [],
    date: new Date("2026-09-17T10:00:00.000Z"),
  };

  it("copies the participants", () => {
    const message = buildReply({ ...base, participants: ["sam@allcheckservices.com"] });
    expect(message.to).toEqual(["ananya.rao@allcheckservices.com"]);
    expect(message.cc).toEqual(["sam@allcheckservices.com"]);
  });

  /**
   * The requester is the addressee, never also a copy. Some clients show the
   * address twice and some servers deliver two copies of the message.
   */
  it("never copies the requester on their own ticket", () => {
    const message = buildReply({
      ...base,
      participants: ["Ananya.Rao@allcheckservices.com", "sam@allcheckservices.com"],
    });
    expect(message.cc).toEqual(["sam@allcheckservices.com"]);
  });

  it("omits the header entirely when nobody is copied", () => {
    expect(buildReply({ ...base, participants: [] }).cc).toBeUndefined();
    expect(buildReply(base).cc).toBeUndefined();
  });
});

describe("the signature (R14)", () => {
  const base = {
    ticketNumber: 42,
    ticketSubject: "Printer jams",
    requester: "ananya.rao@allcheckservices.com",
    supportAddress: "SimpleTickets <support@allcheckservices.com>",
    body: "We have ordered a new roller.",
    threadMessageIds: [],
    date: new Date("2026-09-17T10:00:00.000Z"),
  };

  /**
   * Appended rather than typed, so it cannot be forgotten and cannot claim
   * somebody else - the caller takes the name from the session.
   */
  it("signs with the responding staff member's name", () => {
    const message = buildReply({ ...base, signedBy: "staff2" });
    expect(message.body).toContain("We have ordered a new roller.");
    expect(message.body.endsWith("--\nstaff2\nIT Support")).toBe(true);
  });

  it("does not double the blank line when the body already ends in one", () => {
    const message = buildReply({ ...base, body: "Sorted.\n\n", signedBy: "staff2" });
    expect(message.body).toBe("Sorted.\n\n--\nstaff2\nIT Support");
  });

  /**
   * An automatic message signs nothing. "IT Support" under an auto-closure is a
   * fiction - nobody pressed anything, and the audit trail should not read as
   * though somebody did.
   */
  it("leaves an unsigned message alone", () => {
    expect(buildReply(base).body).toBe(base.body);
    expect(buildReply({ ...base, signedBy: "" }).body).toBe(base.body);
  });
});
