import { describe, it, expect } from "vitest";
import {
  hashPassword,
  verifyPassword,
  TOTAL_ITERATIONS,
  ITERATIONS_PER_ROUND,
  ROUNDS,
} from "./password";

describe("password hashing", () => {
  it("reaches the guidance figure despite the platform cap", () => {
    // Workers' WebCrypto refuses a single deriveBits above 100,000. Chaining
    // rounds costs an attacker the same total work.
    expect(ITERATIONS_PER_ROUND).toBeLessThanOrEqual(100_000);
    expect(TOTAL_ITERATIONS).toBe(ITERATIONS_PER_ROUND * ROUNDS);
    expect(TOTAL_ITERATIONS).toBeGreaterThanOrEqual(600_000);
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
    const [scheme, rounds, iterations] = stored.split("$");
    expect(scheme).toBe("pbkdf2-sha256");
    expect(Number(rounds)).toBe(ROUNDS);
    expect(Number(iterations)).toBe(ITERATIONS_PER_ROUND);
  });

  // A malformed row must fail closed, never throw its way into a 500 that
  // reveals the record exists.
  it("refuses a malformed stored value rather than throwing", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
    expect(await verifyPassword("x", "pbkdf2-sha256$6$100000$notbase64$notbase64")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$1$1$a$b")).toBe(false);
  });

  it("handles unicode passwords", async () => {
    const stored = await hashPassword("pässwörd-日本語-🔐");
    expect(await verifyPassword("pässwörd-日本語-🔐", stored)).toBe(true);
    expect(await verifyPassword("pässwörd-日本語", stored)).toBe(false);
  });
});
