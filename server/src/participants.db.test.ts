/**
 * Integration tests for CC participants, the audit trail, account access and
 * reply templates (R08, R24, R25) against real PostgreSQL.
 *
 * Four things arrive together here because three of them are one requirement
 * seen from different angles: disabling an account has to redistribute work AND
 * be recorded, adding a participant has to be recorded, and a template that
 * moves a ticket has to be recorded like any other transition.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { Pool } from "pg";
import { testPool, truncate } from "./db/testing.ts";
import {
  createTicket,
  addStaff,
  setOwner,
  setStatus,
  setAvailability,
  setEnabled,
  createSession,
  findSession,
  findStaff,
  addParticipants,
  removeParticipant,
  listParticipants,
  participantHistory,
  isTicketParticipant,
  recordAudit,
  ticketAudit,
  recentAudit,
  upsertTemplate,
  listTemplates,
  getTemplate,
  deleteTemplate,
  claimOversizedNotice,
  requeueIntent,
  enqueueIntent,
  recordAcceptance,
  recordBounce,
  ticketsReadyToClose,
  unassignedOpenTickets,
  assignable,
  staffWorkloads,
  getTicket,
} from "./store.ts";

let pool: Pool;
beforeAll(async () => {
  pool = await testPool();
});
beforeEach(async () => {
  await truncate(pool);
});
afterAll(async () => {
  await pool.end();
});

const REQUESTER = "ananya.rao@allcheckservices.com";

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

describe("CC participants", () => {
  it("adds, lists and refuses to duplicate", async () => {
    const id = await ticket();
    expect(await addParticipants(pool, id, ["Sam@allcheckservices.com"], "requester")).toEqual([
      "sam@allcheckservices.com",
    ]);
    // Already there: adding again must return nothing, or the caller would
    // announce a colleague joining a ticket they have been on for a week.
    expect(await addParticipants(pool, id, ["sam@allcheckservices.com"], "requester")).toEqual([]);
    expect(await listParticipants(pool, id)).toEqual(["sam@allcheckservices.com"]);
  });

  /**
   * R25 in as many words: "Omitting an existing participant from an email does
   * not remove them; IT must explicitly remove them." Removal is therefore a
   * timestamp, not a DELETE - the record of who could see the conversation
   * while they could see it is worth keeping.
   */
  it("removes only explicitly, and keeps the record", async () => {
    const id = await ticket();
    await addParticipants(pool, id, ["sam@allcheckservices.com"], "requester");
    expect(await removeParticipant(pool, id, "sam@allcheckservices.com", "staff1")).toBe(true);
    expect(await listParticipants(pool, id)).toEqual([]);

    const history = await participantHistory(pool, id);
    expect(history).toHaveLength(1);
    expect(history[0]?.removed_at).not.toBeNull();

    // Removing twice is not a second removal.
    expect(await removeParticipant(pool, id, "sam@allcheckservices.com", "staff1")).toBe(false);
  });

  it("lets IT put a removed participant back", async () => {
    const id = await ticket();
    await addParticipants(pool, id, ["sam@allcheckservices.com"], "requester");
    await removeParticipant(pool, id, "sam@allcheckservices.com", "staff1");
    expect(await addParticipants(pool, id, ["sam@allcheckservices.com"], "staff1")).toEqual([
      "sam@allcheckservices.com",
    ]);
    expect(await listParticipants(pool, id)).toEqual(["sam@allcheckservices.com"]);
  });

  /**
   * The authorisation question R25 turns on. Everybody in the company is on the
   * approved domain, so without this anyone who learned a Message-ID could
   * write into anybody's ticket - and IT would read it as the employee's own
   * reply.
   */
  it("authorises the requester and current participants, and nobody else", async () => {
    const id = await ticket();
    await addParticipants(pool, id, ["sam@allcheckservices.com"], "requester");

    expect(await isTicketParticipant(pool, id, REQUESTER)).toBe(true);
    expect(await isTicketParticipant(pool, id, "Ananya.Rao@allcheckservices.com")).toBe(true);
    expect(await isTicketParticipant(pool, id, "sam@allcheckservices.com")).toBe(true);
    // Same domain, no relationship to this ticket.
    expect(await isTicketParticipant(pool, id, "stranger@allcheckservices.com")).toBe(false);
  });

  it("stops authorising a participant once they are removed", async () => {
    const id = await ticket();
    await addParticipants(pool, id, ["sam@allcheckservices.com"], "requester");
    await removeParticipant(pool, id, "sam@allcheckservices.com", "staff1");
    expect(await isTicketParticipant(pool, id, "sam@allcheckservices.com")).toBe(false);
  });

  it("keeps each ticket's participants to itself", async () => {
    const first = await ticket("Printer", 1);
    const second = await ticket("Laptop", 2);
    await addParticipants(pool, first, ["sam@allcheckservices.com"], "requester");
    expect(await isTicketParticipant(pool, second, "sam@allcheckservices.com")).toBe(false);
  });

  it("records every addition and removal", async () => {
    const id = await ticket();
    await addParticipants(pool, id, ["sam@allcheckservices.com"], "requester");
    await removeParticipant(pool, id, "sam@allcheckservices.com", "staff1");
    const actions = (await ticketAudit(pool, id)).map((entry) => entry.action);
    expect(actions).toEqual(["participant_added", "participant_removed"]);
  });
});

describe("audit trail", () => {
  /**
   * Assignment changes left no trace at all before this. The message history
   * records what was said, never who the ticket passed through - which is the
   * question actually asked when one has sat untouched for a week.
   */
  it("records assignment, unassignment and status changes", async () => {
    const id = await ticket();
    await addStaff(pool, "staff1", "staff1@allcheckservices.com", true);
    await setOwner(pool, id, "staff1", "staff1");
    await setStatus(pool, id, "In Progress", "staff1");
    await setOwner(pool, id, null, "staff1");

    const entries = await ticketAudit(pool, id);
    expect(entries.map((entry) => entry.action)).toEqual(["assigned", "status", "unassigned"]);
    expect(entries[0]?.detail).toBe("staff1");
    expect(entries[0]?.actor).toBe("staff1");
    expect(entries[2]?.detail).toBeNull();
  });

  // Re-assigning to the same person is not a change, and an audit trail full of
  // non-events is one nobody reads.
  it("does not record an assignment that changed nothing", async () => {
    const id = await ticket();
    await addStaff(pool, "staff1", null, true);
    expect(await setOwner(pool, id, "staff1", "staff1")).toBe(true);
    expect(await setOwner(pool, id, "staff1", "staff1")).toBe(false);
    expect(await ticketAudit(pool, id)).toHaveLength(1);
  });

  it("keeps account-level events, which belong to no ticket", async () => {
    await addStaff(pool, "staff2", null);
    await setAvailability(pool, "staff2", false, "staff1");
    const entries = await recentAudit(pool);
    expect(entries[0]?.action).toBe("made_unavailable");
    expect(entries[0]?.ticket_id).toBeNull();
  });

  it("returns the whole trail newest first", async () => {
    await recordAudit(pool, { actor: "system", action: "first" });
    await recordAudit(pool, { actor: "system", action: "second" });
    expect((await recentAudit(pool)).map((entry) => entry.action)).toEqual(["second", "first"]);
  });
});

describe("account access", () => {
  /**
   * R24 keeps availability and account access apart, and the difference is the
   * whole point: somebody on leave keeps their login, a leaver does not.
   */
  it("disabling revokes live sessions; going unavailable does not", async () => {
    await addStaff(pool, "staff2", "staff2@allcheckservices.com");
    const expiry = new Date(Date.now() + 3_600_000).toISOString();
    await createSession(pool, "hash-unavailable", "staff2", expiry);

    await setAvailability(pool, "staff2", false, "staff1");
    expect(await findSession(pool, "hash-unavailable")).not.toBeNull();

    const result = await setEnabled(pool, "staff2", false, "staff1");
    expect(result?.sessionsRevoked).toBe(1);
    expect(await findSession(pool, "hash-unavailable")).toBeNull();
  });

  it("marks the account so sign-in can refuse it", async () => {
    await addStaff(pool, "staff2", null);
    expect((await findStaff(pool, "staff2"))?.enabled).toBe(true);
    await setEnabled(pool, "staff2", false, "staff1");
    expect((await findStaff(pool, "staff2"))?.enabled).toBe(false);
  });

  it("answers null for an account that does not exist", async () => {
    expect(await setEnabled(pool, "nobody", false, "staff1")).toBeNull();
  });

  /**
   * A disabled account must not receive work. `assignable` is where the two
   * columns are ANDed, so that a caller cannot forget the second half and hand
   * a ticket to somebody who no longer has a login.
   */
  it("excludes disabled accounts from assignment, not just unavailable ones", async () => {
    await addStaff(pool, "staff1", null, true);
    await addStaff(pool, "staff2", null);
    await addStaff(pool, "staff3", null);
    await setAvailability(pool, "staff2", false, "staff1");
    await setEnabled(pool, "staff3", false, "staff1");

    const candidates = assignable(await staffWorkloads(pool));
    expect(candidates.filter((member) => member.available).map((member) => member.name)).toEqual([
      "staff1",
    ]);
  });

  it("re-enabling restores access and does not return anyone's tickets", async () => {
    const id = await ticket();
    await addStaff(pool, "staff2", null);
    await setOwner(pool, id, "staff2", "staff1");
    await setEnabled(pool, "staff2", false, "staff1");
    // Redistribution is the API's job; what matters here is that re-enabling
    // moves no tickets on its own.
    await setEnabled(pool, "staff2", true, "staff1");
    expect((await getTicket(pool, id))?.ticket.owner).toBe("staff2");
    expect((await findStaff(pool, "staff2"))?.enabled).toBe(true);
  });
});

describe("unassigned tickets", () => {
  it("lists only open ones with no owner, oldest first", async () => {
    const first = await ticket("One", 1);
    const second = await ticket("Two", 2);
    const owned = await ticket("Three", 3);
    const resolved = await ticket("Four", 4);
    await addStaff(pool, "staff1", null, true);
    await setOwner(pool, owned, "staff1", "staff1");
    await setStatus(pool, resolved, "Resolved", "staff1");

    expect(await unassignedOpenTickets(pool)).toEqual([first, second]);
  });
});

describe("reply templates", () => {
  it("creates, lists, updates in place and deletes", async () => {
    const created = await upsertTemplate(pool, {
      name: "Working on it",
      body: "We have picked this up.",
      mapsTo: "In Progress",
    });
    expect(created?.maps_to).toBe("In Progress");
    expect(await listTemplates(pool)).toHaveLength(1);

    const updated = await upsertTemplate(pool, {
      id: created?.id ?? 0,
      name: "Working on it",
      body: "We are on it.",
      mapsTo: null,
    });
    expect(updated?.body).toBe("We are on it.");
    expect(updated?.maps_to).toBeNull();
    expect(await listTemplates(pool)).toHaveLength(1);

    expect(await deleteTemplate(pool, created?.id ?? 0)).toBe(true);
    expect(await getTemplate(pool, created?.id ?? 0)).toBeNull();
  });

  // Re-seeding refreshes the starter wording rather than accumulating copies.
  it("upserts by name when no id is given", async () => {
    await upsertTemplate(pool, { name: "Issue resolved", body: "v1", mapsTo: "Resolved" });
    await upsertTemplate(pool, { name: "Issue resolved", body: "v2", mapsTo: "Resolved" });
    const all = await listTemplates(pool);
    expect(all).toHaveLength(1);
    expect(all[0]?.body).toBe("v2");
  });

  /**
   * R24: closure is not a template action. The CHECK constraint is the
   * guarantee; the API's own validation is the readable error.
   */
  it("refuses to map a template to Closed", async () => {
    await expect(
      upsertTemplate(pool, { name: "Close it", body: "x", mapsTo: "Closed" }),
    ).rejects.toThrow();
  });
});

describe("oversized attachment notices", () => {
  /**
   * R12. The claim is the lock: two files refused in the same email must
   * produce one email back, not two, and a ticket where every reply carries a
   * 20 MB video should not generate a lecture each time.
   */
  it("is claimed exactly once per ticket", async () => {
    const id = await ticket();
    expect(await claimOversizedNotice(pool, id)).toBe(true);
    expect(await claimOversizedNotice(pool, id)).toBe(false);
  });
});

describe("resending a failed message", () => {
  /**
   * R28: the 72-hour auto-close clock is anchored to `accepted_at` on the
   * resolution row. A resolution that bounced and is resent must start its 72
   * hours from the NEW acceptance - otherwise the ticket closes on the strength
   * of a delivery that never arrived.
   */
  it("clears the acceptance so auto-close re-anchors", async () => {
    const id = await ticket();
    await enqueueIntent(pool, {
      ticketId: id,
      intent: "resolution",
      recipient: REQUESTER,
      messageId: "<resolution.1@simpletickets>",
      payload: "{}",
      pendingStatus: "Resolved",
    });
    const { rows } = await pool.query<{ id: number }>(`SELECT id FROM outbox LIMIT 1`);
    const outboxId = rows[0]?.id ?? 0;

    const longAgo = new Date(Date.now() - 100 * 3_600_000).toISOString();
    await recordAcceptance(pool, outboxId, id, longAgo, "250 ok", "Resolved");
    const cutoff = new Date(Date.now() - 72 * 3_600_000).toISOString();
    expect((await ticketsReadyToClose(pool, cutoff)).map((row) => row.id)).toEqual([id]);

    // The bounce pauses it (already covered elsewhere); the resend un-anchors it.
    await recordBounce(pool, ["<resolution.1@simpletickets>"]);
    expect(await ticketsReadyToClose(pool, cutoff)).toEqual([]);

    expect(await requeueIntent(pool, outboxId)).toBe(true);
    const requeued = await pool.query<{ state: string; accepted_at: string | null }>(
      `SELECT state, accepted_at FROM outbox WHERE id = $1`,
      [outboxId],
    );
    expect(requeued.rows[0]?.state).toBe("pending");
    expect(requeued.rows[0]?.accepted_at).toBeNull();
    // Nothing to close: the clock has no anchor until the resend is accepted.
    expect(await ticketsReadyToClose(pool, cutoff)).toEqual([]);

    // Accepted again, now: 72 hours from here, not from the bounced delivery.
    await recordAcceptance(pool, outboxId, id, new Date().toISOString(), "250 ok", "Resolved");
    expect(await ticketsReadyToClose(pool, cutoff)).toEqual([]);
  });

  it("refuses to requeue anything that is pending or accepted", async () => {
    const id = await ticket();
    await enqueueIntent(pool, {
      ticketId: id,
      intent: "reply",
      recipient: REQUESTER,
      messageId: "<reply.1@simpletickets>",
      payload: "{}",
    });
    const { rows } = await pool.query<{ id: number }>(`SELECT id FROM outbox LIMIT 1`);
    expect(await requeueIntent(pool, rows[0]?.id ?? 0)).toBe(false);
  });
});
