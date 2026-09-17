import { describe, it, expect } from "vitest";
import {
  parseCookie,
  sessionCookie,
  clearedCookie,
  isExpired,
  expiryFrom,
  SESSION_HOURS,
  hashToken,
  newToken,
} from "./session.ts";

describe("parseCookie", () => {
  it("reads a single cookie", () => {
    expect(parseCookie("st_session=abc123", "st_session")).toBe("abc123");
  });

  it("reads one cookie from several", () => {
    expect(parseCookie("a=1; st_session=abc123; b=2", "st_session")).toBe("abc123");
  });

  it("tolerates missing spaces", () => {
    expect(parseCookie("a=1;st_session=abc", "st_session")).toBe("abc");
  });

  it("returns null when absent", () => {
    expect(parseCookie("a=1; b=2", "st_session")).toBeNull();
    expect(parseCookie(null, "st_session")).toBeNull();
    expect(parseCookie("", "st_session")).toBeNull();
  });

  // A prefix match would let `st_session_other=x` be read as the session.
  it("does not match a cookie whose name merely starts the same", () => {
    expect(parseCookie("st_session_other=x", "st_session")).toBeNull();
  });
});

describe("sessionCookie", () => {
  const cookie = sessionCookie("tok");

  // HttpOnly keeps it out of reach of any script on the page, which is what
  // stops an XSS from stealing a staff session outright.
  it("is HttpOnly", () => {
    expect(cookie).toContain("HttpOnly");
  });

  it("is Secure", () => {
    expect(cookie).toContain("Secure");
  });

  // SameSite=Strict is the CSRF defence: another site cannot make the browser
  // attach this cookie to a request it forges.
  it("is SameSite=Strict", () => {
    expect(cookie).toContain("SameSite=Strict");
  });

  it("is scoped to the whole API", () => {
    expect(cookie).toContain("Path=/");
  });

  it("expires, rather than living forever", () => {
    expect(cookie).toContain("Max-Age=");
  });

  it("clears by expiring immediately", () => {
    expect(clearedCookie()).toContain("Max-Age=0");
    expect(clearedCookie()).toContain("HttpOnly");
  });
});

describe("expiry", () => {
  const now = new Date("2026-09-17T10:00:00.000Z");

  it("expires after the session window", () => {
    expect(expiryFrom(now)).toBe(new Date(now.getTime() + SESSION_HOURS * 3_600_000).toISOString());
  });

  it("treats a past expiry as expired", () => {
    expect(isExpired("2026-09-17T09:59:59.000Z", now)).toBe(true);
  });

  it("treats a future expiry as live", () => {
    expect(isExpired("2026-09-17T10:00:01.000Z", now)).toBe(false);
  });

  // An unreadable expiry must not grant access forever.
  it("treats an unreadable expiry as expired", () => {
    expect(isExpired("not a date", now)).toBe(true);
    expect(isExpired("", now)).toBe(true);
  });
});

describe("tokens", () => {
  it("are long and unpredictable", () => {
    const a = newToken();
    const b = newToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });

  // Sessions are stored hashed for the same reason passwords are: someone who
  // reads the database must not be able to use what they find to log in.
  it("hash to a stable, different value", async () => {
    const token = newToken();
    const hashed = await hashToken(token);
    expect(hashed).not.toBe(token);
    expect(await hashToken(token)).toBe(hashed);
    expect(await hashToken(newToken())).not.toBe(hashed);
  });
});
