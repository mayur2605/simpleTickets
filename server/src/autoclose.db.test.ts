/**
 * Automatic closure of Resolved tickets (R19, R28).
 *
 * The clock starts when the mail server ACCEPTED the resolution, not when IT
 * pressed Resolve — so every test here has to go through a real acceptance
 * rather than setting a status directly.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { Pool } from "pg";
import { testPool, truncate, TEST_DATABASE_URL } from "./db/testing.ts";
import {
  createTicket,
  addStaff,
  addReply,
  claimNextIntent,
  recordAcceptance,
  getTicket,
  recordBounce,
  outboxSummary,
  setStatus,
} from "./store.ts";
import { autoClose, AUTO_CLOSE_HOURS, type AppContext } from "./pipeline.ts";
import { Storage } from "./storage.ts";
import { config } from "./config.ts";

let pool: Pool;
let env: AppContext;

beforeAll(async () => {
  pool = await testPool();
  env = {
    pool,
    storage: new Storage("/tmp/simpletickets-autoclose-test"),
    config: { ...config, databaseUrl: TEST_DATABASE_URL },
  };
});
beforeEach(async () => {
  await truncate(pool);
  await addStaff(pool, "staff1", "staff1@allcheckservices.com", true);
});
afterAll(async () => {
  await pool.end();
});

const NOW = new Date("2026-09-20T10:00:00.000Z");
const LONG_AGO = new Date(NOW.getTime() - (AUTO_CLOSE_HOURS + 1) * 3_600_000).toISOString();
const RECENTLY = new Date(NOW.getTime() - 3_600_000).toISOString();

/** Open a ticket, resolve it, and have the mail server accept the resolution. */
async function resolvedAt(acceptedAt: string): Promise<number> {
  const id = await createTicket(pool, {
    owner: "staff1",
    responseDue: "2026-09-17T12:00:00.000Z",
    uid: Math.floor(Math.random() * 1_000_000),
    subject: "Laptop will not boot",
    requester: "ananya.rao@allcheckservices.com",
    body: "Blue screen.",
    messageId: `<e${String(Math.random())}@allcheckservices.com>`,
  });
  await addReply(pool, {
    ticketId: id,
    author: "staff1",
    body: "Replaced the RAM; it boots now.",
    messageId: `<res.${String(id)}@simpletickets>`,
    recipient: "ananya.rao@allcheckservices.com",
    payload: "{}",
    intent: "resolution",
    pendingStatus: "Resolved",
  });
  const due = await claimNextIntent(pool, NOW);
  await recordAcceptance(pool, due?.id ?? 0, id, acceptedAt, "250 OK", due?.pendingStatus ?? null);
  return id;
}

describe("automatic closure", () => {
  it("queues a closure once the quiet period has elapsed", async () => {
    const id = await resolvedAt(LONG_AGO);
    expect((await getTicket(pool, id))?.ticket.status).toBe("Resolved");

    expect(await autoClose(env, NOW)).toBe(1);

    // R19 and R28: still Resolved. The status moves only when the closure
    // email is accepted, exactly like a manual closure.
    expect((await getTicket(pool, id))?.ticket.status).toBe("Resolved");
    expect((await outboxSummary(pool))["pending"]).toBe(1);
  });

  it("closes the ticket when the closure email is accepted", async () => {
    const id = await resolvedAt(LONG_AGO);
    await autoClose(env, NOW);

    const due = await claimNextIntent(pool, NOW);
    expect(due?.intent).toBe("closure");
    await recordAcceptance(
      pool,
      due?.id ?? 0,
      id,
      NOW.toISOString(),
      "250 OK",
      due?.pendingStatus ?? null,
    );
    expect((await getTicket(pool, id))?.ticket.status).toBe("Closed");
  });

  it("waits while the quiet period is still running", async () => {
    await resolvedAt(RECENTLY);
    expect(await autoClose(env, NOW)).toBe(0);
  });

  /**
   * The clock runs from acceptance, not from the status change. A resolution
   * queued three days ago but accepted an hour ago has only been quiet for an
   * hour — the employee did not hear anything until it was accepted.
   */
  it("measures from acceptance, not from when Resolved was requested", async () => {
    const id = await resolvedAt(RECENTLY);
    // Backdate the ticket itself; only accepted_at should matter.
    await pool.query(`UPDATE tickets SET updated_at = $1 WHERE id = $2`, [LONG_AGO, id]);
    expect(await autoClose(env, NOW)).toBe(0);
  });

  /**
   * R28: a bounce reported after acceptance pauses automatic closure. Closing a
   * ticket whose "we fixed it" email never arrived marks a problem solved while
   * the person who reported it has heard nothing.
   */
  it("does not close when the resolution bounced", async () => {
    const id = await resolvedAt(LONG_AGO);
    await recordBounce(pool, [`<res.${String(id)}@simpletickets>`]);
    expect(await autoClose(env, NOW)).toBe(0);
  });

  it("does not queue a second closure on the next tick", async () => {
    await resolvedAt(LONG_AGO);
    expect(await autoClose(env, NOW)).toBe(1);
    expect(await autoClose(env, new Date(NOW.getTime() + 120_000))).toBe(0);
  });

  it("ignores a ticket that is not Resolved", async () => {
    const id = await resolvedAt(LONG_AGO);
    await setStatus(pool, id, "In Progress");
    expect(await autoClose(env, NOW)).toBe(0);
  });

  it("ignores a ticket whose resolution was never accepted", async () => {
    const id = await createTicket(pool, {
      owner: "staff1",
      responseDue: "2026-09-17T12:00:00.000Z",
      uid: 8100,
      subject: "Never sent",
      requester: "ananya.rao@allcheckservices.com",
      body: "x",
      messageId: "<never@allcheckservices.com>",
    });
    await addReply(pool, {
      ticketId: id,
      author: "staff1",
      body: "Fixed.",
      messageId: "<res.never@simpletickets>",
      recipient: "ananya.rao@allcheckservices.com",
      payload: "{}",
      intent: "resolution",
      pendingStatus: "Resolved",
    });
    // Queued but never accepted, so the ticket is still New.
    expect(await autoClose(env, NOW)).toBe(0);
  });

  // Nobody pressed anything, so no staff member may be recorded as having.
  it("attributes the closure to the system, not to a person", async () => {
    const id = await resolvedAt(LONG_AGO);
    await autoClose(env, NOW);
    const detail = await getTicket(pool, id);
    const closure = detail?.messages.at(-1);
    expect(closure?.author).toBe("system");
    expect(closure?.direction).toBe("outbound");
    expect(closure?.body).toContain("reply to this email and the ticket reopens");
  });
});
