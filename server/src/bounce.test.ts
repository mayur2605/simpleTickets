import { describe, it, expect } from "vitest";
import { isBounce, bouncedMessageIds } from "./bounce.ts";

describe("isBounce", () => {
  // The standard machine-readable form (RFC 3464).
  it("spots a delivery-status report", () => {
    expect(
      isBounce('Content-Type: multipart/report; report-type=delivery-status;\r\n boundary="x"\r\n'),
    ).toBe(true);
  });

  it("spots the usual daemon senders", () => {
    expect(isBounce("From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>\r\n")).toBe(true);
    expect(isBounce("From: MAILER-DAEMON@example.test\r\n")).toBe(true);
    expect(isBounce("From: postmaster@example.test\r\n")).toBe(true);
  });

  it("does not treat ordinary mail as a bounce", () => {
    expect(isBounce("From: ananya.rao@allcheckservices.com\r\nSubject: printer\r\n")).toBe(false);
    expect(isBounce("")).toBe(false);
  });

  // An out-of-office also has a null return path, so that alone must not be
  // enough - otherwise every auto-reply is misfiled as a delivery failure.
  it("does not call a plain auto-reply a bounce", () => {
    expect(isBounce("Return-Path: <>\r\nAuto-Submitted: auto-replied\r\n")).toBe(false);
  });

  it("is not fooled by the words appearing in a subject", () => {
    expect(isBounce("Subject: question about our mailer-daemon setup\r\n")).toBe(false);
  });
});

describe("bouncedMessageIds", () => {
  // A DSN quotes the original headers, so the failed message can be matched
  // back to the outbox row that sent it.
  it("finds the original Message-ID quoted in the report", () => {
    const dsn =
      "Content-Type: multipart/report; report-type=delivery-status\r\n" +
      "\r\n--x\r\nContent-Type: message/rfc822\r\n\r\n" +
      "Message-ID: <ack.42.123@simpletickets>\r\n" +
      "Subject: [#42] Printer\r\n";
    expect(bouncedMessageIds(dsn)).toContain("<ack.42.123@simpletickets>");
  });

  it("also reads In-Reply-To and References from the quoted original", () => {
    const dsn = "References: <a@x> <b@x>\r\nIn-Reply-To: <b@x>\r\n";
    const found = bouncedMessageIds(dsn);
    expect(found).toContain("<a@x>");
    expect(found).toContain("<b@x>");
  });

  it("returns nothing when no ids are quoted", () => {
    expect(bouncedMessageIds("Content-Type: multipart/report\r\n\r\nno ids here")).toEqual([]);
  });

  it("deduplicates", () => {
    expect(bouncedMessageIds("Message-ID: <a@x>\r\nIn-Reply-To: <a@x>\r\n")).toEqual(["<a@x>"]);
  });
});

/**
 * The matching half of R15, which was the known-unreliable part. `readBody`
 * returns the human-readable notice from a delivery report; the original
 * message is in the report's message/rfc822 part, so for as long as this was
 * given the extracted body, detection worked and matching almost never did.
 */
describe("bouncedMessageIds against a complete delivery report", () => {
  const dsn = [
    "Return-Path: <>",
    "From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
    "Content-Type: multipart/report; report-type=delivery-status; boundary=b",
    "Message-ID: <the-report-itself@mx.google.com>",
    "",
    "--b",
    "Content-Type: text/plain",
    "",
    "Your message was not delivered to ananya.rao@allcheckservices.com.",
    "",
    "--b",
    "Content-Type: message/delivery-status",
    "",
    "Action: failed",
    "Status: 5.1.1",
    "",
    "--b",
    "Content-Type: message/rfc822",
    "",
    "Message-ID: <resolution.42.1700000000@simpletickets>",
    "In-Reply-To: <ack.42.1699999000@simpletickets>",
    "Subject: [#42] Printer jams",
    "--b--",
  ].join("\r\n");

  it("finds the original message's id in the rfc822 part", () => {
    expect(bouncedMessageIds(dsn)[0]).toBe("<resolution.42.1700000000@simpletickets>");
  });

  /**
   * The report's OWN Message-ID belongs to the report, not to the message that
   * failed, and can never be in the outbox. Returning it first meant the
   * caller's lookup spent its best guess on an id guaranteed to miss.
   */
  it("never offers the report's own Message-ID", () => {
    expect(bouncedMessageIds(dsn)).not.toContain("<the-report-itself@mx.google.com>");
  });

  it("still offers the thread's other ids as fallbacks", () => {
    expect(bouncedMessageIds(dsn)).toContain("<ack.42.1699999000@simpletickets>");
  });

  // Some servers quote the id only in the readable notice.
  it("reads an id quoted in the human-readable part", () => {
    const readable =
      "From: postmaster@example.test\r\n\r\n" +
      "Delivery failed.\r\nOriginal-Message-ID: <reply.7.123@simpletickets>\r\n";
    expect(bouncedMessageIds(readable)).toEqual(["<reply.7.123@simpletickets>"]);
  });
});
