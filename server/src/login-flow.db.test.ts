/**
 * The two-step sign-in, end to end (R06).
 *
 * `smtp.ts` is mocked and nothing else is — the database, the code store, the
 * throttle and the session machinery are all real. The point of the suite is
 * the ORDER of things: that a password alone produces no session, that the code
 * step does, and that nothing in between hands out access it should not.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import type { Pool } from "pg";

const sent: { to: string; subject: string; body: string }[] = [];
const smtp = { fail: false };

vi.mock("./smtp.ts", () => ({
  SmtpError: class extends Error {},
  sendMessage: (options: { message: { to: string[]; subject: string; body: string } }) => {
    if (smtp.fail) return Promise.reject(new Error("connection refused"));
    sent.push({
      to: options.message.to[0] ?? "",
      subject: options.message.subject,
      body: options.message.body,
    });
    return Promise.resolve({ acceptedAt: new Date().toISOString(), reply: "250 ok" });
  },
}));

const { testPool, truncate } = await import("./db/testing.ts");
const { handleApi } = await import("./api.ts");
const store = await import("./store.ts");

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.ts";
import { Storage } from "./storage.ts";
import { hashPassword } from "./password.ts";
import type { AppContext } from "./pipeline.ts";

let pool: Pool;
let env: AppContext;
let root: string;

/**
 * Generated per run rather than written down. A literal in this shape is a
 * credential as far as any scanner is concerned - the pre-commit hook refuses
 * one and is right to - and a fixed string in a test is the one that ends up
 * pasted into a real seed script.
 */
const secret = `fixture-${randomUUID()}`;
const notTheSecret = `fixture-${randomUUID()}`;

beforeAll(async () => {
  pool = await testPool();
  root = await mkdtemp(join(tmpdir(), "simpletickets-login-"));
  env = {
    pool,
    storage: new Storage(root),
    config: { ...config, loginCodes: true, gmailUser: "bot@gmail.test", gmailAppPassword: "x" },
  };
});

beforeEach(async () => {
  await truncate(pool);
  sent.length = 0;
  smtp.fail = false;
  await store.addStaff(pool, "staff1", "staff1@allcheckservices.com", true);
  await store.setPasswordHash(pool, "staff1", await hashPassword(secret));
});

afterAll(async () => {
  await pool.end();
  await rm(root, { recursive: true, force: true });
});

async function post(
  path: string,
  body: unknown,
  cookie?: string,
): Promise<{ status: number; body: Record<string, unknown>; cookie: string | null }> {
  const url = new URL(`http://localhost:8787${path}`);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie !== undefined) headers["Cookie"] = cookie;
  const response = await handleApi(
    url,
    new Request(url, { method: "POST", headers, body: JSON.stringify(body) }),
    env,
  );
  const parsed: unknown = await response.json();
  return {
    status: response.status,
    body: typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {},
    cookie: response.headers.get("Set-Cookie"),
  };
}

/** The code the mocked transport just delivered. */
function delivered(): string {
  const last = sent[sent.length - 1];
  return /\b(\d{6})\b/.exec(last?.subject ?? "")?.[1] ?? "";
}

describe("the password step", () => {
  it("sends a code and does NOT hand out a session", async () => {
    const result = await post("/api/login", { name: "staff1", password: secret });
    expect(result.status).toBe(200);
    expect(result.body["codeRequired"]).toBe(true);
    // The crux: password accepted, nothing granted.
    expect(result.cookie).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("staff1@allcheckservices.com");
  });

  it("sends nothing at all for a wrong password", async () => {
    const result = await post("/api/login", { name: "staff1", password: notTheSecret });
    expect(result.status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  /**
   * A code that could not be sent must not sign anybody in, and must not leave
   * a usable code behind either. The person is told to talk to their admin
   * rather than left refreshing an inbox.
   */
  it("refuses when the code cannot be delivered", async () => {
    smtp.fail = true;
    const result = await post("/api/login", { name: "staff1", password: secret });
    expect(result.status).toBe(502);
    expect(result.cookie).toBeNull();
  });

  // No address, no code, no way in - and answered like any other failure, so
  // the response does not say which accounts are misconfigured.
  it("refuses an account with no email address", async () => {
    await store.addStaff(pool, "staff9", null);
    await store.setPasswordHash(pool, "staff9", await hashPassword(secret));
    const result = await post("/api/login", { name: "staff9", password: secret });
    expect(result.status).toBe(401);
    expect(sent).toHaveLength(0);
  });
});

describe("the code step", () => {
  it("signs in with the code that was sent", async () => {
    await post("/api/login", { name: "staff1", password: secret });
    const result = await post("/api/login/verify", { name: "staff1", code: delivered() });
    expect(result.status).toBe(200);
    expect(result.cookie).toContain("st_session=");
    expect(result.cookie).toContain("HttpOnly");
    expect(result.body["isAdmin"]).toBe(true);
  });

  it("refuses a wrong code, and says nothing about why", async () => {
    await post("/api/login", { name: "staff1", password: secret });
    const wrong = await post("/api/login/verify", { name: "staff1", code: "000000" });
    const never = await post("/api/login/verify", { name: "staff2", code: "000000" });
    expect(wrong.status).toBe(401);
    // Same message for "wrong code" and "no code was ever issued": distinguishing
    // them confirms which accounts have had one sent, which is to say which
    // passwords are already known.
    expect(wrong.body["error"]).toBe(never.body["error"]);
  });

  it("refuses a code that has already been used", async () => {
    await post("/api/login", { name: "staff1", password: secret });
    const code = delivered();
    expect((await post("/api/login/verify", { name: "staff1", code })).status).toBe(200);
    expect((await post("/api/login/verify", { name: "staff1", code })).status).toBe(401);
  });

  /**
   * Ten minutes can pass between the two steps, and an admin can disable the
   * account in them. The account is re-read rather than trusted from the first
   * step.
   */
  it("refuses a code for an account disabled since the password was accepted", async () => {
    await post("/api/login", { name: "staff1", password: secret });
    const code = delivered();
    await store.setEnabled(pool, "staff1", false, "admin");
    const result = await post("/api/login/verify", { name: "staff1", code });
    expect(result.status).toBe(401);
    expect(result.cookie).toBeNull();
  });

  /**
   * The same per-account throttle as the password. An attacker holding the
   * password would otherwise have a second, unthrottled surface to grind codes
   * against - five on the row plus five on the account, both pushing back.
   */
  it("locks the account out after repeated wrong codes", async () => {
    await post("/api/login", { name: "staff1", password: secret });
    for (let i = 0; i < 5; i += 1) {
      await post("/api/login/verify", { name: "staff1", code: "000000" });
    }
    const result = await post("/api/login/verify", { name: "staff1", code: delivered() });
    expect(result.status).toBe(429);
  });

  it("wants both a name and a code", async () => {
    expect((await post("/api/login/verify", { name: "staff1" })).status).toBe(400);
    expect((await post("/api/login/verify", { code: "000000" })).status).toBe(400);
  });
});

describe("a second code request", () => {
  it("invalidates the first", async () => {
    await post("/api/login", { name: "staff1", password: secret });
    const first = delivered();
    await post("/api/login", { name: "staff1", password: secret });
    const second = delivered();
    expect(first).not.toBe(second);
    expect((await post("/api/login/verify", { name: "staff1", code: first })).status).toBe(401);
  });
});
