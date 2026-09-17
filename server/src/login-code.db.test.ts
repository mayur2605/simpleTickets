/**
 * Sign-in codes against real PostgreSQL (R06).
 *
 * The consume path is the one worth testing against a real database rather than
 * a fake: it locks a row, counts an attempt, and deletes on success, all in one
 * transaction, because it is the statement an attacker would race. Two guesses
 * arriving together must count as two attempts, and a correct code must be
 * usable exactly once.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { Pool } from "pg";
import { testPool, truncate } from "./db/testing.ts";
import { addStaff, storeLoginCode, consumeLoginCode, sweepExpiredCodes } from "./store.ts";
import { hashToken, newCode, codeExpiryFrom, MAX_CODE_ATTEMPTS } from "./session.ts";

let pool: Pool;
beforeAll(async () => {
  pool = await testPool();
});
beforeEach(async () => {
  await truncate(pool);
  await addStaff(pool, "staff1", "staff1@allcheckservices.com", true);
});
afterAll(async () => {
  await pool.end();
});

const NOW = new Date("2026-09-17T10:00:00.000Z");
const LATER = new Date("2026-09-17T10:11:00.000Z");

async function issue(code: string, at = NOW): Promise<void> {
  await storeLoginCode(pool, "staff1", await hashToken(code), codeExpiryFrom(at));
}

describe("consuming a code", () => {
  it("accepts the right one", async () => {
    await issue("042719");
    expect(await consumeLoginCode(pool, "staff1", await hashToken("042719"), NOW)).toBe("accepted");
  });

  /** Single use. Deleted rather than marked, so a replay finds nothing at all. */
  it("refuses the same code twice", async () => {
    await issue("042719");
    await consumeLoginCode(pool, "staff1", await hashToken("042719"), NOW);
    expect(await consumeLoginCode(pool, "staff1", await hashToken("042719"), NOW)).toBe("none");
  });

  it("refuses a wrong one and counts the attempt", async () => {
    await issue("042719");
    expect(await consumeLoginCode(pool, "staff1", await hashToken("000000"), NOW)).toBe("wrong");
    const row = await pool.query<{ attempts: number }>(
      `SELECT attempts FROM login_codes WHERE staff_name = 'staff1'`,
    );
    expect(row.rows[0]?.attempts).toBe(1);
    // Still usable: one wrong guess is a typo, not an attack.
    expect(await consumeLoginCode(pool, "staff1", await hashToken("042719"), NOW)).toBe("accepted");
  });

  /**
   * What actually makes six digits safe. Five guesses at one in a million, and
   * then the code is gone rather than merely locked - a locked code that comes
   * back would hand the attacker another five on the next window.
   */
  it("gives up after five wrong guesses and destroys the code", async () => {
    await issue("042719");
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i += 1) {
      expect(await consumeLoginCode(pool, "staff1", await hashToken("000000"), NOW)).toBe("wrong");
    }
    expect(await consumeLoginCode(pool, "staff1", await hashToken("042719"), NOW)).toBe(
      "exhausted",
    );
    expect(await consumeLoginCode(pool, "staff1", await hashToken("042719"), NOW)).toBe("none");
  });

  it("refuses an expired one, and removes it", async () => {
    await issue("042719");
    expect(await consumeLoginCode(pool, "staff1", await hashToken("042719"), LATER)).toBe(
      "expired",
    );
    const left = await pool.query(`SELECT 1 FROM login_codes`);
    expect(left.rowCount).toBe(0);
  });

  it("says nothing was issued when nothing was", async () => {
    expect(await consumeLoginCode(pool, "staff1", await hashToken("042719"), NOW)).toBe("none");
  });
});

describe("issuing a code", () => {
  /**
   * One row per account. Asking for a new code invalidates the previous one, so
   * a code intercepted a minute ago cannot be held in reserve while its owner
   * carries on signing in.
   */
  it("replaces an outstanding code rather than adding one", async () => {
    await issue("111111");
    await issue("222222");
    const rows = await pool.query(`SELECT 1 FROM login_codes WHERE staff_name = 'staff1'`);
    expect(rows.rowCount).toBe(1);
    expect(await consumeLoginCode(pool, "staff1", await hashToken("111111"), NOW)).toBe("wrong");
    expect(await consumeLoginCode(pool, "staff1", await hashToken("222222"), NOW)).toBe("accepted");
  });

  it("resets the attempt count with the new code", async () => {
    await issue("111111");
    for (let i = 0; i < 3; i += 1) {
      await consumeLoginCode(pool, "staff1", await hashToken("000000"), NOW);
    }
    await issue("222222");
    // A fresh code gets its full five guesses, not the two left over.
    for (let i = 0; i < 4; i += 1) {
      expect(await consumeLoginCode(pool, "staff1", await hashToken("000000"), NOW)).toBe("wrong");
    }
    expect(await consumeLoginCode(pool, "staff1", await hashToken("222222"), NOW)).toBe("accepted");
  });

  /** Nothing usable to sign in with may be readable in this table. */
  it("never stores the code itself", async () => {
    const code = newCode();
    await issue(code);
    const row = await pool.query<{ code_hash: string }>(
      `SELECT code_hash FROM login_codes WHERE staff_name = 'staff1'`,
    );
    expect(row.rows[0]?.code_hash).not.toContain(code);
    expect(row.rows[0]?.code_hash).toHaveLength(64);
  });
});

describe("sweeping", () => {
  it("clears expired codes and leaves live ones", async () => {
    await addStaff(pool, "staff2", "staff2@allcheckservices.com");
    await storeLoginCode(pool, "staff1", await hashToken("111111"), codeExpiryFrom(NOW));
    await storeLoginCode(
      pool,
      "staff2",
      await hashToken("222222"),
      codeExpiryFrom(new Date(LATER.getTime() + 3_600_000)),
    );
    expect(await sweepExpiredCodes(pool, LATER)).toBe(1);
    const left = await pool.query<{ staff_name: string }>(`SELECT staff_name FROM login_codes`);
    expect(left.rows.map((row) => row.staff_name)).toEqual(["staff2"]);
  });
});

describe("two guesses at once", () => {
  /**
   * The race the row lock exists for. Both arrive, both are wrong, and both must
   * be counted - a lost update here gives an attacker unlimited guesses at the
   * cost of sending them in pairs.
   */
  it("counts both", async () => {
    await issue("042719");
    const wrong = await hashToken("000000");
    await Promise.all([
      consumeLoginCode(pool, "staff1", wrong, NOW),
      consumeLoginCode(pool, "staff1", wrong, NOW),
    ]);
    const row = await pool.query<{ attempts: number }>(
      `SELECT attempts FROM login_codes WHERE staff_name = 'staff1'`,
    );
    expect(row.rows[0]?.attempts).toBe(2);
  });

  /** And the correct code, raced against itself, may be spent exactly once. */
  it("lets exactly one of two simultaneous correct guesses through", async () => {
    await issue("042719");
    const right = await hashToken("042719");
    const results = await Promise.all([
      consumeLoginCode(pool, "staff1", right, NOW),
      consumeLoginCode(pool, "staff1", right, NOW),
    ]);
    expect(results.filter((result) => result === "accepted")).toHaveLength(1);
  });
});
