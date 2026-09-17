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
