/**
 * The dashboard API, exercised as a browser would call it, against real
 * PostgreSQL.
 *
 * `handleApi` is called with real `Request` objects rather than through an HTTP
 * server: the routing, the session check, the authorisation and the validation
 * are all the real ones, and there is no port to collide with. What this covers
 * and the store suites cannot is the layer where most of the mistakes are -
 * who is allowed to do what, and what the server does with what the client
 * claims.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { Pool } from "pg";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testPool, truncate } from "./db/testing.ts";
import { handleApi } from "./api.ts";
import type { AppContext } from "./pipeline.ts";
import { Storage } from "./storage.ts";
import { config } from "./config.ts";
import { hashToken, newToken, expiryFrom } from "./session.ts";
import {
  addStaff,
  createTicket,
  createSession,
  setPasswordHash,
  setStatus,
  listParticipants,
  listTemplates,
  findSession,
  findStaff,
  enqueueIntent,
  recordAcceptance,
  recordBounce,
  getTicket,
} from "./store.ts";
import { hashPassword } from "./password.ts";
import { randomUUID } from "node:crypto";

let pool: Pool;
let env: AppContext;
let storageDir: string;

const REQUESTER = "ananya.rao@allcheckservices.com";

/**
 * Generated per run rather than written down.
 *
 * Partly because the pre-commit hook refuses a literal in this shape and is
 * right to - a scanner cannot tell a test fixture from a leak - and partly
 * because a fixed string in a test is the one that ends up pasted into a real
 * seed script. `right` is what the account is given; `wrong` differs from it
 * and is never stored.
 */
const correctSecret = `fixture-${randomUUID()}`;
const incorrectSecret = `fixture-${randomUUID()}`;

beforeAll(async () => {
  pool = await testPool();
  storageDir = await mkdtemp(join(tmpdir(), "simpletickets-api-"));
  env = { pool, storage: new Storage(storageDir), config: { ...config } };
});

beforeEach(async () => {
  await truncate(pool);
  await addStaff(pool, "staff1", "staff1@allcheckservices.com", true);
  await addStaff(pool, "staff2", "staff2@allcheckservices.com");
});

afterAll(async () => {
  await pool.end();
  await rm(storageDir, { recursive: true, force: true });
});

/** Sign somebody in without going through the password, which is tested apart. */
async function sessionFor(name: string): Promise<string> {
  const token = newToken();
  await createSession(pool, await hashToken(token), name, expiryFrom(new Date()));
  return token;
}

async function api(
  path: string,
  options: { as?: string; method?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.as !== undefined) headers["Cookie"] = `st_session=${options.as}`;
  const url = new URL(`http://localhost:8787${path}`);
  const request = new Request(url, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const response = await handleApi(url, request, env);
  const parsed: unknown = await response.json();
  return {
    status: response.status,
    body: typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {},
  };
}

async function ticket(subject = "Printer jams", uid = 1): Promise<number> {
  return createTicket(pool, {
    uid,
    subject,
    requester: REQUESTER,
    body: "It keeps jamming.",
    messageId: `<in.${String(uid)}@x>`,
    responseDue: new Date(Date.now() + 3_600_000).toISOString(),
    owner: null,
  });
}

describe("who may do what", () => {
  it("refuses everything without a session", async () => {
    expect((await api("/api/tickets")).status).toBe(401);
    expect((await api("/api/templates")).status).toBe(401);
    expect((await api("/api/audit")).status).toBe(401);
  });

  /**
   * A disabled account keeps its cookie until the DELETE lands, and may already
   * have a request in flight. Refused on the session read, not only at sign-in.
   */
  it("refuses a session whose account has been disabled", async () => {
    const token = await sessionFor("staff2");
    expect((await api("/api/tickets", { as: token })).status).toBe(200);

    await api("/api/staff", {
      as: await sessionFor("staff1"),
      method: "POST",
      body: { name: "staff2", enabled: false },
    });
    expect((await api("/api/tickets", { as: token })).status).toBe(401);
  });

  /**
   * Same message as a wrong password. Saying "this account is disabled" would
   * confirm the name exists and that it used to work, which is what someone
   * probing a leaver's credentials wants to know.
   */
  it("refuses sign-in to a disabled account, indistinguishably", async () => {
    await setPasswordHash(pool, "staff2", await hashPassword(correctSecret));
    const admin = await sessionFor("staff1");
    await api("/api/staff", {
      as: admin,
      method: "POST",
      body: { name: "staff2", enabled: false },
    });

    const refused = await api("/api/login", {
      method: "POST",
      body: { name: "staff2", password: correctSecret },
    });
    const wrong = await api("/api/login", {
      method: "POST",
      body: { name: "staff2", password: incorrectSecret },
    });
    expect(refused.status).toBe(401);
    expect(refused.body["error"]).toBe(wrong.body["error"]);
  });

  it("lets only an admin change availability or account access", async () => {
    const staff = await sessionFor("staff2");
    expect(
      (
        await api("/api/staff", {
          as: staff,
          method: "POST",
          body: { name: "staff1", available: false },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api("/api/staff", {
          as: staff,
          method: "POST",
          body: { name: "staff1", enabled: false },
        })
      ).status,
    ).toBe(403);
  });

  /**
   * Only an admin may re-enable an account, and only from a session this would
   * have just deleted. Allowing it locks the last door from the inside.
   */
  it("stops an admin disabling their own account", async () => {
    const admin = await sessionFor("staff1");
    const result = await api("/api/staff", {
      as: admin,
      method: "POST",
      body: { name: "staff1", enabled: false },
    });
    expect(result.status).toBe(409);
    expect((await findStaff(pool, "staff1"))?.enabled).toBe(true);
  });
});

describe("availability and account access (R24)", () => {
  it("moves the open tickets of somebody who becomes unavailable", async () => {
    const id = await ticket();
    const admin = await sessionFor("staff1");
    await api(`/api/tickets/${String(id)}/assign`, {
      as: admin,
      method: "POST",
      body: { owner: "staff2" },
    });

    const result = await api("/api/staff", {
      as: admin,
      method: "POST",
      body: { name: "staff2", available: false },
    });
    expect(result.status).toBe(200);
    expect((await getTicket(pool, id))?.ticket.owner).toBe("staff1");
  });

  /**
   * R24: restoring availability picks up what nobody owns, and ONLY that.
   * Rebalancing tickets somebody else has started is how two people end up
   * answering the same employee.
   */
  it("assigns unowned tickets when somebody comes back, without rebalancing", async () => {
    const admin = await sessionFor("staff1");
    await api("/api/staff", {
      as: admin,
      method: "POST",
      body: { name: "staff1", available: false },
    });
    await api("/api/staff", {
      as: admin,
      method: "POST",
      body: { name: "staff2", available: false },
    });

    const orphan = await ticket("Nobody's", 1);
    const held = await ticket("Somebody's", 2);
    await api(`/api/tickets/${String(held)}/assign`, {
      as: admin,
      method: "POST",
      body: { owner: "staff1" },
    });

    const back = await api("/api/staff", {
      as: admin,
      method: "POST",
      body: { name: "staff2", available: true },
    });
    expect(back.body["assigned"]).toBe(1);
    expect((await getTicket(pool, orphan))?.ticket.owner).toBe("staff2");
    expect((await getTicket(pool, held))?.ticket.owner).toBe("staff1");
  });

  it("signs out a disabled account and moves its work in one call", async () => {
    const id = await ticket();
    const admin = await sessionFor("staff1");
    const victim = await sessionFor("staff2");
    await api(`/api/tickets/${String(id)}/assign`, {
      as: admin,
      method: "POST",
      body: { owner: "staff2" },
    });

    const result = await api("/api/staff", {
      as: admin,
      method: "POST",
      body: { name: "staff2", enabled: false },
    });
    expect(result.body["sessionsRevoked"]).toBe(1);
    expect(await findSession(pool, await hashToken(victim))).toBeNull();
    expect((await getTicket(pool, id))?.ticket.owner).toBe("staff1");
  });
});

describe("participants (R25)", () => {
  it("adds a company colleague and refuses an external address", async () => {
    const id = await ticket();
    const staff = await sessionFor("staff2");

    const good = await api(`/api/tickets/${String(id)}/participants`, {
      as: staff,
      method: "POST",
      body: { add: ["Sam@allcheckservices.com"] },
    });
    expect(good.body["added"]).toEqual(["sam@allcheckservices.com"]);

    const bad = await api(`/api/tickets/${String(id)}/participants`, {
      as: staff,
      method: "POST",
      body: { add: ["contractor@example.com"] },
    });
    expect(bad.body["added"]).toEqual([]);
    expect(bad.body["refused"]).toEqual(["contractor@example.com"]);
    expect(await listParticipants(pool, id)).toEqual(["sam@allcheckservices.com"]);
  });

  it("removes one, and says so when there is nobody to remove", async () => {
    const id = await ticket();
    const staff = await sessionFor("staff2");
    await api(`/api/tickets/${String(id)}/participants`, {
      as: staff,
      method: "POST",
      body: { add: ["sam@allcheckservices.com"] },
    });

    const removed = await api(`/api/tickets/${String(id)}/participants`, {
      as: staff,
      method: "POST",
      body: { remove: "sam@allcheckservices.com" },
    });
    expect(removed.body["removed"]).toBe("sam@allcheckservices.com");
    expect(await listParticipants(pool, id)).toEqual([]);

    const again = await api(`/api/tickets/${String(id)}/participants`, {
      as: staff,
      method: "POST",
      body: { remove: "sam@allcheckservices.com" },
    });
    expect(again.status).toBe(404);
  });

  /** Everyone on the ticket is copied on a public reply, and only them. */
  it("copies participants on a reply", async () => {
    const id = await ticket();
    const staff = await sessionFor("staff2");
    await api(`/api/tickets/${String(id)}/participants`, {
      as: staff,
      method: "POST",
      body: { add: ["sam@allcheckservices.com"] },
    });

    const sent = await api(`/api/tickets/${String(id)}/reply`, {
      as: staff,
      method: "POST",
      body: { body: "We have ordered a new roller." },
    });
    expect(sent.body["copiedTo"]).toEqual(["sam@allcheckservices.com"]);
    const queued = await pool.query<{ payload: string }>(
      `SELECT payload FROM outbox WHERE intent = 'reply'`,
    );
    expect(queued.rows[0]?.payload).toContain("sam@allcheckservices.com");
  });

  // An internal note must reach nobody, copied colleagues least of all.
  it("never copies anyone on an internal note", async () => {
    const id = await ticket();
    const staff = await sessionFor("staff2");
    await api(`/api/tickets/${String(id)}/participants`, {
      as: staff,
      method: "POST",
      body: { add: ["sam@allcheckservices.com"] },
    });
    await api(`/api/tickets/${String(id)}/note`, {
      as: staff,
      method: "POST",
      body: { body: "Vendor says the part is on back order." },
    });
    const queued = await pool.query(`SELECT 1 FROM outbox`);
    expect(queued.rowCount).toBe(0);
  });
});

describe("reply templates (R24)", () => {
  it("lets any signed-in staff read them and only an admin write", async () => {
    const admin = await sessionFor("staff1");
    const staff = await sessionFor("staff2");

    expect((await api("/api/templates", { as: staff })).status).toBe(200);
    expect(
      (
        await api("/api/templates", {
          as: staff,
          method: "POST",
          body: { name: "Mine", body: "text", mapsTo: null },
        })
      ).status,
    ).toBe(403);

    const made = await api("/api/templates", {
      as: admin,
      method: "POST",
      body: { name: "Working on it", body: "We are on it.", mapsTo: "In Progress" },
    });
    expect(made.status).toBe(200);
    expect(await listTemplates(pool)).toHaveLength(1);
  });

  it("refuses to map a template to Closed", async () => {
    const admin = await sessionFor("staff1");
    const result = await api("/api/templates", {
      as: admin,
      method: "POST",
      body: { name: "Close it", body: "text", mapsTo: "Closed" },
    });
    expect(result.status).toBe(400);
    expect(String(result.body["error"])).toContain("mapsTo");
  });

  /**
   * R24: "Sending Working on it sets In Progress." In Progress needs no email
   * of its own, so it applies at once - unlike the gated three below.
   */
  it("applies an In Progress mapping immediately", async () => {
    const id = await ticket();
    const admin = await sessionFor("staff1");
    const made = await api("/api/templates", {
      as: admin,
      method: "POST",
      body: { name: "Working on it", body: "We are on it.", mapsTo: "In Progress" },
    });
    const templateId = (made.body["template"] as { id: number }).id;

    const sent = await api(`/api/tickets/${String(id)}/reply`, {
      as: admin,
      method: "POST",
      body: { body: "We are on it.", templateId },
    });
    expect(sent.body["status"]).toBe("In Progress");
    expect((await getTicket(pool, id))?.ticket.status).toBe("In Progress");
  });

  /**
   * R24 and R28 together: a template-mapped transition is delivery-gated like
   * any other, so the ticket stays where it is until the message is accepted.
   */
  it("holds a Resolved mapping until the mail server accepts it", async () => {
    const id = await ticket();
    const admin = await sessionFor("staff1");
    const made = await api("/api/templates", {
      as: admin,
      method: "POST",
      body: { name: "Issue resolved", body: "Sorted.", mapsTo: "Resolved" },
    });
    const templateId = (made.body["template"] as { id: number }).id;

    const sent = await api(`/api/tickets/${String(id)}/reply`, {
      as: admin,
      method: "POST",
      body: { body: "Sorted - we replaced the roller.", templateId },
    });
    expect(sent.body["pendingStatus"]).toBe("Resolved");
    expect((await getTicket(pool, id))?.ticket.status).toBe("New");

    const row = await pool.query<{ id: number }>(
      `SELECT id FROM outbox WHERE pending_status = 'Resolved'`,
    );
    await recordAcceptance(
      pool,
      row.rows[0]?.id ?? 0,
      id,
      new Date().toISOString(),
      "250 ok",
      "Resolved",
    );
    expect((await getTicket(pool, id))?.ticket.status).toBe("Resolved");
  });

  /**
   * R24: "Staff may edit a selected reply before sending. The edit affects only
   * that outgoing message; the saved shared template remains unchanged."
   */
  it("sends what was typed, not what the template says", async () => {
    const id = await ticket();
    const admin = await sessionFor("staff1");
    const made = await api("/api/templates", {
      as: admin,
      method: "POST",
      body: { name: "Working on it", body: "STORED WORDING", mapsTo: "In Progress" },
    });
    const templateId = (made.body["template"] as { id: number }).id;

    await api(`/api/tickets/${String(id)}/reply`, {
      as: admin,
      method: "POST",
      body: { body: "EDITED WORDING", templateId },
    });

    const detail = await getTicket(pool, id);
    const outbound = detail?.messages.find((m) => m.direction === "outbound");
    expect(outbound?.body).toBe("EDITED WORDING");
    // And the shared template is untouched.
    expect((await listTemplates(pool))[0]?.body).toBe("STORED WORDING");
  });

  /**
   * R24 again: "Editing a shared template must not modify previously sent
   * ticket messages." The wording is copied at send time, so it cannot be.
   */
  it("leaves already-sent messages alone when the template changes", async () => {
    const id = await ticket();
    const admin = await sessionFor("staff1");
    const made = await api("/api/templates", {
      as: admin,
      method: "POST",
      body: { name: "Working on it", body: "Version one.", mapsTo: null },
    });
    const templateId = (made.body["template"] as { id: number }).id;
    await api(`/api/tickets/${String(id)}/reply`, {
      as: admin,
      method: "POST",
      body: { body: "Version one.", templateId },
    });

    await api(`/api/templates/${String(templateId)}`, {
      as: admin,
      method: "POST",
      body: { name: "Working on it", body: "Version two.", mapsTo: null },
    });

    const detail = await getTicket(pool, id);
    expect(detail?.messages.find((m) => m.direction === "outbound")?.body).toBe("Version one.");
  });

  it("answers 404 for a template that is not there", async () => {
    const id = await ticket();
    const result = await api(`/api/tickets/${String(id)}/reply`, {
      as: await sessionFor("staff1"),
      method: "POST",
      body: { body: "text", templateId: 999 },
    });
    expect(result.status).toBe(404);
  });
});

describe("what the ticket detail exposes", () => {
  /**
   * R28 needs this visible. A status change hangs off the message that
   * justifies it, so pressing Resolve and seeing "New" is correct and looks
   * broken - and the obvious response is to press it again.
   */
  it("reports outgoing mail the ticket is still waiting on", async () => {
    const id = await ticket();
    const admin = await sessionFor("staff1");
    await api(`/api/tickets/${String(id)}/status`, {
      as: admin,
      method: "POST",
      body: { status: "Resolved", body: "All sorted." },
    });

    const detail = await api(`/api/tickets/${String(id)}`, { as: admin });
    const pending = detail.body["pending"] as { pending_status: string | null }[];
    expect(pending).toHaveLength(1);
    expect(pending[0]?.pending_status).toBe("Resolved");
  });

  it("reports the audit trail beside the conversation", async () => {
    const id = await ticket();
    const admin = await sessionFor("staff1");
    await api(`/api/tickets/${String(id)}/assign`, {
      as: admin,
      method: "POST",
      body: { owner: "staff2" },
    });

    const detail = await api(`/api/tickets/${String(id)}`, { as: admin });
    const audit = detail.body["audit"] as { action: string; actor: string }[];
    expect(audit.map((entry) => entry.action)).toContain("assigned");
    expect(audit[0]?.actor).toBe("staff1");
  });
});

describe("priority (R11, R22)", () => {
  it("records who changed it, and changes no deadline", async () => {
    const id = await ticket();
    const before = (await getTicket(pool, id))?.ticket.response_due;

    const result = await api(`/api/tickets/${String(id)}/priority`, {
      as: await sessionFor("staff2"),
      method: "POST",
      body: { priority: "Urgent" },
    });
    expect(result.body["changed"]).toBe(true);

    const detail = await getTicket(pool, id);
    expect(detail?.ticket.priority).toBe("Urgent");
    // R11: every priority gets the same four working hours.
    expect(detail?.ticket.response_due).toBe(before);
    const entry = detail?.audit.find((item) => item.action === "priority");
    expect(entry?.actor).toBe("staff2");
    expect(entry?.detail).toBe("Urgent");
  });

  it("refuses a priority that is not one of the four", async () => {
    const id = await ticket();
    const result = await api(`/api/tickets/${String(id)}/priority`, {
      as: await sessionFor("staff1"),
      method: "POST",
      body: { priority: "Critical" },
    });
    expect(result.status).toBe(400);
  });

  // Setting it to what it already is is not a change, and an audit trail full
  // of non-events is one nobody reads.
  it("records nothing when the priority did not move", async () => {
    const id = await ticket();
    const staff = await sessionFor("staff1");
    await api(`/api/tickets/${String(id)}/priority`, {
      as: staff,
      method: "POST",
      body: { priority: "Normal" },
    });
    expect((await getTicket(pool, id))?.audit).toHaveLength(0);
  });
});

describe("resending (R28)", () => {
  it("requeues a bounced message and refuses anything still pending", async () => {
    const id = await ticket();
    const admin = await sessionFor("staff1");
    await enqueueIntent(pool, {
      ticketId: id,
      intent: "resolution",
      recipient: REQUESTER,
      messageId: "<resolution.1@simpletickets>",
      payload: "{}",
      pendingStatus: "Resolved",
    });
    const row = await pool.query<{ id: number }>(`SELECT id FROM outbox LIMIT 1`);
    const outboxId = row.rows[0]?.id ?? 0;

    expect(
      (await api(`/api/outbox/${String(outboxId)}/resend`, { as: admin, method: "POST" })).status,
    ).toBe(409);

    await recordAcceptance(pool, outboxId, id, new Date().toISOString(), "250 ok", "Resolved");
    await recordBounce(pool, ["<resolution.1@simpletickets>"]);

    const resent = await api(`/api/outbox/${String(outboxId)}/resend`, {
      as: admin,
      method: "POST",
    });
    expect(resent.status).toBe(200);
    const after = await pool.query<{ state: string; accepted_at: string | null }>(
      `SELECT state, accepted_at FROM outbox WHERE id = $1`,
      [outboxId],
    );
    expect(after.rows[0]?.state).toBe("pending");
    expect(after.rows[0]?.accepted_at).toBeNull();
  });
});

describe("the author is the session, never the request", () => {
  it("ignores an author the client claims", async () => {
    const id = await ticket();
    await api(`/api/tickets/${String(id)}/reply`, {
      as: await sessionFor("staff2"),
      method: "POST",
      body: { body: "Hello.", author: "staff1" },
    });
    const detail = await getTicket(pool, id);
    expect(detail?.messages.find((m) => m.direction === "outbound")?.author).toBe("staff2");
  });

  it("records the actor on a status change from the session", async () => {
    const id = await ticket();
    await setStatus(pool, id, "In Progress", "system");
    await api(`/api/tickets/${String(id)}/status`, {
      as: await sessionFor("staff2"),
      method: "POST",
      body: { status: "Waiting for Employee", body: "Which building are you in?" },
    });
    const detail = await getTicket(pool, id);
    const requested = detail?.audit.find((entry) => entry.action === "status_requested");
    expect(requested?.actor).toBe("staff2");
  });
});

describe("the signature (R14)", () => {
  /**
   * R14: "signed with the responding staff member's name". Taken from the
   * session like `author`, so a client cannot sign a colleague's name to its
   * own message.
   */
  it("signs the outgoing message with the session's name", async () => {
    const id = await ticket();
    await api(`/api/tickets/${String(id)}/reply`, {
      as: await sessionFor("staff2"),
      method: "POST",
      body: { body: "We have ordered a new roller.", signedBy: "staff1" },
    });
    const queued = await pool.query<{ payload: string }>(
      `SELECT payload FROM outbox WHERE intent = 'reply'`,
    );
    const payload = queued.rows[0]?.payload ?? "";
    expect(payload).toContain("staff2");
    expect(payload).not.toContain("staff1");
  });

  /**
   * The signature is on the WIRE, not in the ticket history. IT already knows
   * who they are, and repeating it under every message in the dashboard is
   * noise beside a row that already carries the author.
   */
  it("keeps the signature out of the stored message", async () => {
    const id = await ticket();
    await api(`/api/tickets/${String(id)}/reply`, {
      as: await sessionFor("staff2"),
      method: "POST",
      body: { body: "We have ordered a new roller." },
    });
    const detail = await getTicket(pool, id);
    expect(detail?.messages.find((m) => m.direction === "outbound")?.body).toBe(
      "We have ordered a new roller.",
    );
  });
});

describe("automatic assignment (R07)", () => {
  it("hands the choice to the rule, and only for an admin", async () => {
    const id = await ticket();
    expect(
      (
        await api(`/api/tickets/${String(id)}/assign`, {
          as: await sessionFor("staff2"),
          method: "POST",
          body: { auto: true },
        })
      ).status,
    ).toBe(403);

    const result = await api(`/api/tickets/${String(id)}/assign`, {
      as: await sessionFor("staff1"),
      method: "POST",
      body: { auto: true },
    });
    expect(result.body["owner"]).not.toBeNull();
    expect((await getTicket(pool, id))?.ticket.owner).toBe(result.body["owner"]);
  });

  // Nobody available means nobody assigned, not somebody assigned anyway.
  it("returns no owner when nobody can take it", async () => {
    const id = await ticket();
    const admin = await sessionFor("staff1");
    for (const who of ["staff1", "staff2"]) {
      await api("/api/staff", { as: admin, method: "POST", body: { name: who, available: false } });
    }
    const result = await api(`/api/tickets/${String(id)}/assign`, {
      as: admin,
      method: "POST",
      body: { auto: true },
    });
    expect(result.body["owner"]).toBeNull();
  });
});
