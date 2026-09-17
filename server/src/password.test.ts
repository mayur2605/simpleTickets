import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, SCRYPT_N, SCRYPT_R, SCRYPT_P } from "./password.ts";

describe("password hashing", () => {
  // The point of scrypt over PBKDF2 is that guessing costs memory, not just
  // time. If N or r were ever lowered to make logins feel faster, that property
  // would quietly go with them, so the memory cost is asserted directly.
  it("is memory-hard at OWASP's parameters", () => {
    expect(SCRYPT_N).toBeGreaterThanOrEqual(65_536);
    expect(SCRYPT_R).toBeGreaterThanOrEqual(8);
    expect(128 * SCRYPT_N * SCRYPT_R).toBeGreaterThanOrEqual(64 * 1024 * 1024);
    // N must be a power of two or scrypt rejects it outright.
    expect(SCRYPT_N & (SCRYPT_N - 1)).toBe(0);
  });

  it("verifies a correct password", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("Correct horse battery staple", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  // A shared salt would let one precomputed table break every account at once,
  // and would make identical passwords visibly identical in the database.
  it("salts each hash separately", async () => {
    const a = await hashPassword("same password");
    const b = await hashPassword("same password");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same password", a)).toBe(true);
    expect(await verifyPassword("same password", b)).toBe(true);
  });

  it("stores its parameters, so they can change without invalidating old hashes", async () => {
    const stored = await hashPassword("x");
    const [scheme, n, r, p] = stored.split("$");
    expect(scheme).toBe("scrypt");
    expect(Number(n)).toBe(SCRYPT_N);
    expect(Number(r)).toBe(SCRYPT_R);
    expect(Number(p)).toBe(SCRYPT_P);
  });

  /**
   * The Cloudflare build hashed passwords with six chained PBKDF2 rounds,
   * because Workers capped a single deriveBits call at 100,000 iterations.
   * Anyone whose password was set then must still be able to sign in, so the
   * old verifier stays even though nothing writes that format any more.
   *
   * This value was produced by the previous implementation for the password
   * below. If this test ever fails, a real person has been locked out.
   */
  it("still verifies a password hashed by the Cloudflare-era scheme", async () => {
    const legacy =
      "pbkdf2-sha256$6$100000$5nQkQyBBnTKnUQFKOaUEeg==$yNx72Nqdikl71eO3OuauMEz0FVwMi5G4gnZ42kDToa8=";
    expect(await verifyPassword("correct horse battery staple", legacy)).toBe(true);
    expect(await verifyPassword("wrong password", legacy)).toBe(false);
  });

  // An absurd N from a corrupted row sizes an allocation. It must fail the
  // login, not the process.
  it("refuses stored parameters that would exhaust memory", async () => {
    const huge = `scrypt$${String(2 ** 24)}$8$2$c2FsdA==$${Buffer.alloc(32).toString("base64")}`;
    expect(await verifyPassword("x", huge)).toBe(false);
  });

  // A malformed row must fail closed, never throw its way into a 500 that
  // reveals the record exists.
  it("refuses a malformed stored value rather than throwing", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
    expect(await verifyPassword("x", "scrypt$65536$8$2$notbase64$notbase64")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$1$1$a$b$c")).toBe(false);
    // N that is not a power of two.
    expect(await verifyPassword("x", "scrypt$65535$8$2$c2FsdA==$c2FsdA==")).toBe(false);
  });

  it("handles unicode passwords", async () => {
    const stored = await hashPassword("pässwörd-日本語-🔐");
    expect(await verifyPassword("pässwörd-日本語-🔐", stored)).toBe(true);
    expect(await verifyPassword("pässwörd-日本語", stored)).toBe(false);
  });
});
