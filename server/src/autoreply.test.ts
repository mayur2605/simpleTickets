import { describe, it, expect } from "vitest";
import { isAutomaticMessage } from "./autoreply.ts";

describe("isAutomaticMessage", () => {
  it("accepts ordinary mail from a person", () => {
    expect(isAutomaticMessage("From: a@b\r\nSubject: help\r\n")).toBe(false);
    expect(isAutomaticMessage("")).toBe(false);
  });

  // RFC 3834. This is what we set on our own acknowledgement, so honouring it
  // on the way in is the other half of the same contract.
  it("spots Auto-Submitted", () => {
    expect(isAutomaticMessage("Auto-Submitted: auto-replied\r\n")).toBe(true);
    expect(isAutomaticMessage("auto-submitted: auto-generated\r\n")).toBe(true);
  });

  // "no" is the explicit marker for a human-sent message and must not match.
  it("does not treat Auto-Submitted: no as automatic", () => {
    expect(isAutomaticMessage("Auto-Submitted: no\r\n")).toBe(false);
  });

  it("spots the older Precedence conventions", () => {
    expect(isAutomaticMessage("Precedence: bulk\r\n")).toBe(true);
    expect(isAutomaticMessage("Precedence: auto_reply\r\n")).toBe(true);
    expect(isAutomaticMessage("Precedence: junk\r\n")).toBe(true);
  });

  it("does not treat an ordinary Precedence as automatic", () => {
    expect(isAutomaticMessage("Precedence: first-class\r\n")).toBe(false);
  });

  it("spots vendor autoresponder headers", () => {
    expect(isAutomaticMessage("X-Autoreply: yes\r\n")).toBe(true);
    expect(isAutomaticMessage("X-Autorespond: yes\r\n")).toBe(true);
  });

  // An empty Return-Path is the null reverse path: bounces and system mail use
  // it precisely so replying to them is impossible.
  it("spots a null return path", () => {
    expect(isAutomaticMessage("Return-Path: <>\r\n")).toBe(true);
    expect(isAutomaticMessage("Return-Path: <someone@allcheckservices.com>\r\n")).toBe(false);
  });

  it("is not fooled by the words appearing in a body", () => {
    expect(isAutomaticMessage("Subject: about precedence: bulk mail\r\n")).toBe(false);
  });
});
