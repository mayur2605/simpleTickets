import { describe, it, expect } from "vitest";
import { timingSafeEqual, isAuthorised } from "./auth";

const token = "0123456789abcdef0123456789abcdef";

describe("timingSafeEqual", () => {
  it("accepts identical strings", () => {
    expect(timingSafeEqual(token, token)).toBe(true);
    expect(timingSafeEqual("", "")).toBe(true);
  });

  it("rejects different strings of equal length", () => {
    expect(timingSafeEqual(token, `${token.slice(0, -1)}0`)).toBe(false);
  });

  it("rejects different lengths", () => {
    expect(timingSafeEqual(token, `${token}x`)).toBe(false);
    expect(timingSafeEqual(token, "")).toBe(false);
  });

  it("rejects a difference in the very first character", () => {
    expect(timingSafeEqual(token, `x${token.slice(1)}`)).toBe(false);
  });
});

describe("isAuthorised", () => {
  it("accepts the configured token", () => {
    expect(isAuthorised(token, token)).toBe(true);
  });

  it("rejects a wrong token", () => {
    expect(isAuthorised(token, `${token.slice(0, -1)}0`)).toBe(false);
  });

  // Fails closed: a worker deployed with no ADMIN_TOKEN must not expose its
  // admin routes to everyone.
  it("rejects when no token is configured", () => {
    expect(isAuthorised(undefined, token)).toBe(false);
    expect(isAuthorised("", "")).toBe(false);
  });

  // A short token is treated as unconfigured rather than honoured.
  it("rejects a configured token that is too short to be meaningful", () => {
    expect(isAuthorised("short", "short")).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(isAuthorised(token, null)).toBe(false);
  });
});
