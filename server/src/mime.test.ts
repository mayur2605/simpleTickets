import { describe, it, expect } from "vitest";
import { buildMessage, parseOutgoingMessage, HeaderInjectionError } from "./mime.ts";
import { replyCode, isReplyComplete } from "./smtp.ts";

const base = {
  from: "SimpleTickets <simpleticketssupport@gmail.com>",
  to: ["ananya.rao@allcheckservices.com"],
  subject: "[#42] Printer not working",
  body: "We are looking into it.",
  messageId: "<t42.1@simpletickets>",
  date: new Date("2026-09-17T06:30:00Z"),
};

describe("buildMessage", () => {
  it("emits the headers a reply needs, CRLF separated", () => {
    const msg = buildMessage(base);
    expect(msg).toContain("From: SimpleTickets <simpleticketssupport@gmail.com>\r\n");
    expect(msg).toContain("To: ananya.rao@allcheckservices.com\r\n");
    expect(msg).toContain("Subject: [#42] Printer not working\r\n");
    expect(msg).toContain("Message-ID: <t42.1@simpletickets>\r\n");
    expect(msg).toContain("Date: Thu, 17 Sep 2026 06:30:00 +0000\r\n");
    expect(msg).toContain("MIME-Version: 1.0\r\n");
    // A blank line ends the headers and begins the body.
    expect(msg).toContain("\r\n\r\nWe are looking into it.");
  });

  it("joins multiple recipients with commas", () => {
    const msg = buildMessage({ ...base, to: ["a@allcheckservices.com", "b@allcheckservices.com"] });
    expect(msg).toContain("To: a@allcheckservices.com, b@allcheckservices.com\r\n");
  });

  // R03 threading: a reply must carry these or mail clients start a new thread.
  it("includes threading headers when replying", () => {
    const msg = buildMessage({
      ...base,
      inReplyTo: "<abc@mail.gmail.com>",
      references: ["<root@mail.gmail.com>", "<abc@mail.gmail.com>"],
    });
    expect(msg).toContain("In-Reply-To: <abc@mail.gmail.com>\r\n");
    expect(msg).toContain("References: <root@mail.gmail.com> <abc@mail.gmail.com>\r\n");
  });

  it("omits threading headers on a first message", () => {
    const msg = buildMessage(base);
    expect(msg).not.toContain("In-Reply-To:");
    expect(msg).not.toContain("References:");
  });

  // The subject comes from employee email, so it is attacker-controlled. A CR
  // or LF in it would end the Subject header and let the sender write their own
  // headers - including extra Bcc recipients.
  it("refuses a subject carrying a newline", () => {
    expect(() => buildMessage({ ...base, subject: "hi\r\nBcc: attacker@evil.test" })).toThrow(
      HeaderInjectionError,
    );
    expect(() => buildMessage({ ...base, subject: "hi\nBcc: attacker@evil.test" })).toThrow(
      HeaderInjectionError,
    );
  });

  it("refuses a recipient carrying a newline", () => {
    expect(() =>
      buildMessage({ ...base, to: ["ok@allcheckservices.com\r\nBcc: attacker@evil.test"] }),
    ).toThrow(HeaderInjectionError);
  });

  it("refuses a from address carrying a newline", () => {
    expect(() => buildMessage({ ...base, from: "x\r\nBcc: attacker@evil.test" })).toThrow(
      HeaderInjectionError,
    );
  });

  // RFC 5321: a line of "." alone ends DATA. Any body line starting with "."
  // must be doubled or the message is truncated there.
  it("dot-stuffs body lines that begin with a period", () => {
    const msg = buildMessage({ ...base, body: "before\r\n.\r\n.hidden\r\nafter" });
    expect(msg).toContain("\r\n..\r\n");
    expect(msg).toContain("\r\n..hidden\r\n");
    expect(msg).toContain("before");
    expect(msg).toContain("after");
  });

  it("normalises bare newlines in the body to CRLF", () => {
    const msg = buildMessage({ ...base, body: "one\ntwo" });
    expect(msg).toContain("one\r\ntwo");
    expect(msg).not.toMatch(/[^\r]\n/);
  });

  // A non-ASCII subject must be encoded or it arrives as mojibake.
  it("encodes a non-ASCII subject as an RFC 2047 encoded-word", () => {
    const msg = buildMessage({ ...base, subject: "Rückmeldung" });
    expect(msg).toContain("Subject: =?UTF-8?B?");
    expect(msg).not.toContain("Subject: Rückmeldung");
  });

  it("leaves a plain ASCII subject unencoded", () => {
    expect(buildMessage(base)).toContain("Subject: [#42] Printer not working\r\n");
  });
});

describe("replyCode / isReplyComplete", () => {
  it("reads the code off a single-line reply", () => {
    expect(replyCode("250 OK\r\n")).toBe("250");
  });

  // A multi-line reply uses "250-" on every line but the last, which uses
  // "250 ". Stopping at the first line would leave the rest in the buffer and
  // desynchronise every later command.
  it("treats a hyphenated line as incomplete", () => {
    expect(isReplyComplete("250-smtp.gmail.com at your service\r\n")).toBe(false);
    expect(isReplyComplete("250-SIZE 35882577\r\n250-8BITMIME\r\n")).toBe(false);
  });

  it("treats a space-separated final line as complete", () => {
    expect(isReplyComplete("250-SIZE 35882577\r\n250 SMTPUTF8\r\n")).toBe(true);
  });

  it("reads the code off the last line of a multi-line reply", () => {
    expect(replyCode("250-SIZE 35882577\r\n250 SMTPUTF8\r\n")).toBe("250");
  });

  it("is incomplete on a partial line", () => {
    expect(isReplyComplete("25")).toBe(false);
    expect(isReplyComplete("250 OK")).toBe(false);
  });
});

describe("buildMessage auto-submitted", () => {
  it("omits Auto-Submitted on an ordinary message", () => {
    expect(buildMessage(base)).not.toContain("Auto-Submitted:");
  });

  it("emits Auto-Submitted: auto-replied when asked", () => {
    expect(buildMessage({ ...base, autoSubmitted: true })).toContain(
      "Auto-Submitted: auto-replied\r\n",
    );
  });
});

describe("parseOutgoingMessage", () => {
  const stored = JSON.stringify(buildMessage_input());

  function buildMessage_input() {
    return {
      from: "SimpleTickets <simpleticketssupport@gmail.com>",
      to: ["ananya.rao@allcheckservices.com"],
      subject: "[#42] Printer",
      body: "hello",
      messageId: "<t42@simpletickets>",
      date: "2026-09-17T06:30:00.000Z",
    };
  }

  it("revives a stored message, turning the date back into a Date", () => {
    const parsed = parseOutgoingMessage(stored);
    expect(parsed.date).toBeInstanceOf(Date);
    expect(parsed.date.toISOString()).toBe("2026-09-17T06:30:00.000Z");
    expect(parsed.to).toEqual(["ananya.rao@allcheckservices.com"]);
  });

  it("round-trips through buildMessage", () => {
    expect(buildMessage(parseOutgoingMessage(stored))).toContain("Subject: [#42] Printer\r\n");
  });

  // A row that is not a valid message must be rejected here, not discovered
  // halfway through an SMTP DATA command.
  it("rejects malformed rows", () => {
    expect(() => parseOutgoingMessage("not json")).toThrow();
    expect(() => parseOutgoingMessage("null")).toThrow();
    expect(() => parseOutgoingMessage("[]")).toThrow();
    expect(() =>
      parseOutgoingMessage(JSON.stringify({ ...buildMessage_input(), to: "x" })),
    ).toThrow();
    expect(() =>
      parseOutgoingMessage(JSON.stringify({ ...buildMessage_input(), to: [] })),
    ).toThrow();
    expect(() =>
      parseOutgoingMessage(JSON.stringify({ ...buildMessage_input(), date: "not a date" })),
    ).toThrow();
    const missing: Record<string, unknown> = { ...buildMessage_input() };
    delete missing["subject"];
    expect(() => parseOutgoingMessage(JSON.stringify(missing))).toThrow();
  });

  it("keeps optional threading fields when present and absent when not", () => {
    const withThread = JSON.stringify({
      ...buildMessage_input(),
      inReplyTo: "<a@b>",
      references: ["<a@b>"],
      autoSubmitted: true,
    });
    const parsed = parseOutgoingMessage(withThread);
    expect(parsed.inReplyTo).toBe("<a@b>");
    expect(parsed.references).toEqual(["<a@b>"]);
    expect(parsed.autoSubmitted).toBe(true);
    expect(parseOutgoingMessage(stored).inReplyTo).toBeUndefined();
  });
});

describe("Cc header", () => {
  const base = {
    from: "SimpleTickets <support@allcheckservices.com>",
    to: ["ananya.rao@allcheckservices.com"],
    subject: "[#42] Printer jams",
    body: "We have ordered a new roller.",
    messageId: "<reply.42.1@simpletickets>",
    date: new Date("2026-09-17T10:00:00.000Z"),
  };

  it("writes the copied addresses", () => {
    const raw = buildMessage({
      ...base,
      cc: ["sam@allcheckservices.com", "j@allcheckservices.com"],
    });
    expect(raw).toContain("Cc: sam@allcheckservices.com, j@allcheckservices.com\r\n");
  });

  it("writes no Cc header when there is nobody to copy", () => {
    expect(buildMessage({ ...base, cc: [] })).not.toContain("Cc:");
    expect(buildMessage(base)).not.toContain("Cc:");
  });

  /**
   * Cc addresses reach us from an employee's Cc header, so they are
   * attacker-controlled exactly as To and Subject are. A bare newline in one
   * would terminate the header and let the sender append their own, Bcc
   * included.
   */
  it("refuses a line break in a copied address", () => {
    expect(() => buildMessage({ ...base, cc: ["ok@x.test\r\nBcc: attacker@evil.test"] })).toThrow(
      HeaderInjectionError,
    );
  });

  it("survives a round trip through the outbox", () => {
    const message = { ...base, cc: ["sam@allcheckservices.com"] };
    const revived = parseOutgoingMessage(JSON.stringify(message));
    expect(revived.cc).toEqual(["sam@allcheckservices.com"]);
    expect(parseOutgoingMessage(JSON.stringify(base)).cc).toBeUndefined();
  });
});
