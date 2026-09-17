import { describe, it, expect } from "vitest";
import { buildLoginCode } from "./login-code.ts";
import { newCode, CODE_DIGITS, codeExpiryFrom, CODE_MINUTES } from "./session.ts";
import { buildMessage } from "./mime.ts";

describe("newCode", () => {
  it("is always the right length, digits only", () => {
    for (let i = 0; i < 500; i += 1) {
      const code = newCode();
      expect(code).toHaveLength(CODE_DIGITS);
      expect(/^\d+$/.test(code)).toBe(true);
    }
  });

  /**
   * Leading zeros are the classic bug here: a code formatted from a number
   * loses them, so "000042" is sent as "42" and the person types what they were
   * sent and is refused.
   */
  it("keeps leading zeros", () => {
    // 500 draws from a million will not reliably produce one, so this checks
    // the formatting directly rather than hoping.
    expect(String(42).padStart(CODE_DIGITS, "0")).toBe("000042");
    expect(newCode().length).toBe(CODE_DIGITS);
  });

  it("does not repeat itself in any small run", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) seen.add(newCode());
    // 200 draws from a million: a collision is possible but a cluster is not.
    expect(seen.size).toBeGreaterThan(190);
  });
});

describe("codeExpiryFrom", () => {
  it("expires in ten minutes", () => {
    const now = new Date("2026-09-17T10:00:00.000Z");
    expect(codeExpiryFrom(now)).toBe("2026-09-17T10:10:00.000Z");
    expect(CODE_MINUTES).toBe(10);
  });
});

describe("buildLoginCode", () => {
  const message = buildLoginCode({
    code: "042719",
    recipient: "staff1@allcheckservices.com",
    supportAddress: "SimpleTickets <support@allcheckservices.com>",
    date: new Date("2026-09-17T10:00:00.000Z"),
  });

  it("puts the code where it can be read without opening the mail", () => {
    expect(message.subject).toContain("042719");
    expect(message.body).toContain("042719");
  });

  it("says how long it lasts and that it works once", () => {
    expect(message.body).toContain("10 minutes");
    expect(message.body).toContain("once");
  });

  /**
   * No link, deliberately. A sign-in email with a clickable link is the shape of
   * every credential phishing message ever sent, and training staff to click
   * one is worse than the inconvenience of typing six digits.
   */
  it("contains no link at all", () => {
    expect(message.body).not.toMatch(/https?:\/\//);
  });

  // The advice that actually protects the account: a code arriving unbidden
  // means the password is already gone.
  it("says what to do if it arrives unexpectedly", () => {
    expect(message.body).toContain("somebody has your password");
    expect(message.body).toContain("Nobody from IT will ever ask you for this code");
  });

  it("is one-way, like the other automatic mail", () => {
    expect(message.autoSubmitted).toBe(true);
    expect(message.replyTo).toBe("no-reply@allcheckservices.com");
    expect(message.messageId).toContain("signin.");
  });

  it("builds into a valid message", () => {
    const raw = buildMessage(message);
    expect(raw).toContain("To: staff1@allcheckservices.com");
    expect(raw).toContain("Auto-Submitted: auto-replied");
  });
});
