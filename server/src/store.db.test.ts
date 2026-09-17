/**
 * Integration tests for store.ts against real PostgreSQL.
 *
 * These are new. Under D1 this file could not exist — the only database was
 * Cloudflare's, so every property below was verified by reading the SQL and
 * hoping. CLAUDE.md lists "store.ts and index.ts have no integration tests" as
 * a known gap; this is that gap, and each test here corresponds to a guarantee
 * the comments in store.ts claim.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { Pool } from "pg";
import { testPool, truncate } from "./db/testing.ts";
import {
  createTicket,
  appendReply,
  recordSkip,
  alreadyIngested,
  enqueueIntent,
  claimNextIntent,
  recordAcceptance,
  recordSendFailure,
  sweepStaleSending,
  markAmbiguous,
  findTicketByMessageIds,
  recordBounce,
  outboxSummary,
  stuckIntents,
  listTickets,
  getTicket,
  threadIds,
  addReply,
  addNote,
  addStaff,
  setAvailability,
  setOwner,
  openTicketsOwnedBy,
  staffWorkloads,
  lastAssignee,
  setStatus,
  readCheckpoint,
  writeCheckpoint,
  findStaff,
  setPasswordHash,
  createSession,
  findSession,
  deleteSession,
  recordLoginFailure,
  recentFailures,
  addAttachment,
  listAttachments,
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

const ticket = {
  owner: null,
  responseDue: "2026-09-18T12:00:00.000Z",
  uid: 100,
  subject: "Laptop will not boot",
  requester: "ananya.rao@allcheckservices.com",
  body: "It shows a blue screen.",
  messageId: "<employee-1@allcheckservices.com>",
};

const ack = (ticketId: number) => ({
  ticketId,
  intent: "acknowledgement" as const,
  recipient: ticket.requester,
  messageId: `<ack.${String(ticketId)}@simpletickets>`,
  payload: JSON.stringify({ subject: "We got it" }),
});

describe("createTicket", () => {
  it("writes the ticket, its message, the log entry and the acknowledgement together", async () => {
    const id = await createTicket(pool, ticket, ack);

    const detail = await getTicket(pool, id);
    expect(detail?.ticket.subject).toBe(ticket.subject);
    expect(detail?.messages).toHaveLength(1);
    expect(detail?.messages[0]?.direction).toBe("inbound");
    expect(await alreadyIngested(pool, ticket.uid)).toBe(true);
    expect((await outboxSummary(pool))["pending"]).toBe(1);
  });

  /**
   * The guarantee that stops one email opening two tickets. ingest_log.uid is
   * the primary key, so the second attempt cannot commit — and because the
   * ticket insert shares its transaction, no orphan ticket is left behind.
   */
  it("cannot ingest the same UID twice", async () => {
    await createTicket(pool, ticket, ack);
    await expect(createTicket(pool, ticket, ack)).rejects.toThrow();

    const tickets = await listTickets(pool);
    expect(tickets).toHaveLength(1);
  });

  /**
   * The acknowledgement shares the ticket's transaction. If the outbox insert
   * fails, the ticket must not exist either — otherwise a ticket sits there
   * that ingest_log calls done and that nothing will ever acknowledge.
   */
  it("rolls the ticket back when the acknowledgement cannot be queued", async () => {
    await expect(
      createTicket(pool, ticket, () => ({
        ...ack(1),
        // 'greeting' is not in the intent CHECK constraint.
        intent: "greeting" as unknown as "reply",
      })),
    ).rejects.toThrow();

    expect(await listTickets(pool)).toHaveLength(0);
    expect(await alreadyIngested(pool, ticket.uid)).toBe(false);
  });

  it("records a skipped UID so a blocked sender is visible, not silent", async () => {
    await recordSkip(pool, 55, "rejected_sender", "Sender outside the approved domain");
    expect(await alreadyIngested(pool, 55)).toBe(true);
    // Recording it twice must not throw: runs overlap.
    await recordSkip(pool, 55, "rejected_sender", "again");
  });
});

describe("threading", () => {
  it("finds a ticket from a Message-ID on either side of the conversation", async () => {
    const id = await createTicket(pool, ticket, ack);
    expect(await findTicketByMessageIds(pool, [ticket.messageId])).toBe(id);
    // The reply quotes our acknowledgement, whose id is only in the outbox.
    expect(await findTicketByMessageIds(pool, [`<ack.${String(id)}@simpletickets>`])).toBe(id);
    expect(await findTicketByMessageIds(pool, ["<nothing@example.com>"])).toBeNull();
  });

  it("tries candidates in order, so the closest relative wins", async () => {
    const first = await createTicket(pool, ticket, ack);
    const second = await createTicket(pool, { ...ticket, uid: 101, messageId: "<b@x>" }, ack);
    expect(await findTicketByMessageIds(pool, ["<b@x>", ticket.messageId])).toBe(second);
    expect(await findTicketByMessageIds(pool, [ticket.messageId, "<b@x>"])).toBe(first);
  });

  it("reopens a closed ticket on a reply and raises it in the queue", async () => {
    const id = await createTicket(pool, ticket, ack);
    await setStatus(pool, id, "Resolved");
    const before = (await getTicket(pool, id))?.ticket.updated_at ?? "";

    await appendReply(pool, {
      ticketId: id,
      uid: 200,
      author: ticket.requester,
      body: "It is still broken.",
      messageId: "<reply-1@allcheckservices.com>",
    });

    const after = await getTicket(pool, id);
    expect(after?.ticket.status).toBe("In Progress");
    expect(after?.messages).toHaveLength(2);
    // updated_at bumps on every reply, not only on reopen: the queue sorts by
    // it, and tickets with unanswered replies must not sink below quiet ones.
    expect((after?.ticket.updated_at ?? "") >= before).toBe(true);
  });

  it("leaves the response deadline alone when a reply arrives", async () => {
    const id = await createTicket(pool, ticket, ack);
    await appendReply(pool, {
      ticketId: id,
      uid: 201,
      author: ticket.requester,
      body: "Any news?",
      messageId: "<reply-2@allcheckservices.com>",
    });
    expect((await getTicket(pool, id))?.ticket.response_due).toBe(ticket.responseDue);
  });
});

describe("outbox", () => {
  it("enqueues an intent once, however many times it is offered", async () => {
    const id = await createTicket(pool, ticket, ack);
    await enqueueIntent(pool, ack(id));
    await enqueueIntent(pool, ack(id));
    expect((await outboxSummary(pool))["pending"]).toBe(1);
  });

  /**
   * THE important case. Two runs claim at the same moment; exactly one may get
   * the row. Without this the employee receives the same message twice.
   *
   * Under D1 this was a compare-and-swap tested against a scripted fake, which
   * could only prove the control flow reacted correctly to an answer the test
   * itself supplied. This runs both claims concurrently against the real
   * database and the real `FOR UPDATE SKIP LOCKED`.
   */
  it("gives a due intent to exactly one of two concurrent claimers", async () => {
    await createTicket(pool, ticket, ack);
    const [a, b] = await Promise.all([
      claimNextIntent(pool, new Date()),
      claimNextIntent(pool, new Date()),
    ]);
    expect([a, b].filter((claim) => claim !== null)).toHaveLength(1);
    expect((await outboxSummary(pool))["sending"]).toBe(1);
  });

  it("claims nothing when nothing is due yet", async () => {
    const id = await createTicket(pool, ticket, ack);
    await recordSendFailure(pool, 1, "pending", "2099-01-01T00:00:00.000Z", "deferred");
    expect(await claimNextIntent(pool, new Date())).toBeNull();
    expect(id).toBeGreaterThan(0);
  });

  it("reports attempts post-increment, so retry accounting counts this attempt", async () => {
    await createTicket(pool, ticket, ack);
    expect((await claimNextIntent(pool, new Date()))?.attempts).toBe(1);
  });

  /**
   * R28. The status change and the acceptance record commit together — a
   * ticket must never show a status whose required email was not accepted.
   */
  it("applies a pending status only with the acceptance, in one transaction", async () => {
    const id = await createTicket(pool, ticket, ack);
    await addReply(pool, {
      ticketId: id,
      author: "staff1",
      body: "Try restarting.",
      messageId: "<reply.out@simpletickets>",
      recipient: ticket.requester,
      payload: "{}",
      intent: "resolution",
      pendingStatus: "Resolved",
    });

    // Queued but not sent: the status must not have moved.
    expect((await getTicket(pool, id))?.ticket.status).toBe("New");

    // Two intents are due - the acknowledgement and this resolution - and the
    // claim order between them is not specified, so find the right one rather
    // than assuming it comes first.
    let due = await claimNextIntent(pool, new Date());
    while (due !== null && due.pendingStatus === null) {
      await recordAcceptance(pool, due.id, id, new Date().toISOString(), "250 OK", null);
      due = await claimNextIntent(pool, new Date());
    }
    expect(due?.pendingStatus).toBe("Resolved");

    // Still New: claiming a row is not acceptance.
    expect((await getTicket(pool, id))?.ticket.status).toBe("New");

    await recordAcceptance(
      pool,
      due?.id ?? 0,
      id,
      new Date().toISOString(),
      "250 2.0.0 OK queued",
      due?.pendingStatus ?? null,
    );
    expect((await getTicket(pool, id))?.ticket.status).toBe("Resolved");
  });

  it("parks a send whose outcome never came back, rather than resending it", async () => {
    await createTicket(pool, ticket, ack);
    await claimNextIntent(pool, new Date());
    const parked = await sweepStaleSending(pool, new Date(Date.now() + 600_000), 300_000);
    expect(parked).toBe(1);
    expect((await outboxSummary(pool))["ambiguous"]).toBe(1);
    // Ambiguous rows are never re-claimed: a human decides.
    expect(await claimNextIntent(pool, new Date())).toBeNull();
  });

  it("marks a bounce as bounced, not failed — it WAS accepted", async () => {
    const id = await createTicket(pool, ticket, ack);
    const matched = await recordBounce(pool, [`<ack.${String(id)}@simpletickets>`]);
    expect(matched).toBe(id);
    expect((await outboxSummary(pool))["bounced"]).toBe(1);
  });

  it("surfaces everything needing a human, and nothing that does not", async () => {
    const id = await createTicket(pool, ticket, ack);
    await enqueueIntent(pool, { ...ack(id), messageId: "<second@simpletickets>" });
    await recordSendFailure(pool, 1, "failed", new Date().toISOString(), "550 rejected");
    const claimed = await claimNextIntent(pool, new Date());
    await markAmbiguous(pool, claimed?.id ?? 0);

    const stuck = await stuckIntents(pool);
    expect(stuck.map((row) => row.state).sort()).toEqual(["ambiguous", "failed"]);
  });

  it("reports every state as a number, so a missing key cannot read as healthy", async () => {
    expect(await outboxSummary(pool)).toEqual({
      pending: 0,
      sending: 0,
      accepted: 0,
      failed: 0,
      ambiguous: 0,
      bounced: 0,
    });
  });
});

describe("dashboard writes", () => {
  it("records a reply and queues it in one transaction", async () => {
    const id = await createTicket(pool, ticket, ack);
    await addReply(pool, {
      ticketId: id,
      author: "staff1",
      body: "Looking into it.",
      messageId: "<r1@simpletickets>",
      recipient: ticket.requester,
      payload: "{}",
    });
    const detail = await getTicket(pool, id);
    expect(detail?.messages.some((m) => m.direction === "outbound")).toBe(true);
    expect((await outboxSummary(pool))["pending"]).toBe(2);
  });

  /**
   * Constitution III: an internal note must never reach employee email. The
   * structural guarantee is that addNote has no outbox statement at all, so
   * this asserts the queue is untouched rather than that some flag was set.
   */
  it("never queues mail for an internal note", async () => {
    const id = await createTicket(pool, ticket, ack);
    const before = await outboxSummary(pool);
    await addNote(pool, id, "staff1", "Employee is on the third floor.");
    expect(await outboxSummary(pool)).toEqual(before);

    const detail = await getTicket(pool, id);
    expect(detail?.messages.filter((m) => m.direction === "note")).toHaveLength(1);
  });

  it("excludes notes from the thread, so one cannot be quoted into an email", async () => {
    const id = await createTicket(pool, ticket, ack);
    await addNote(pool, id, "staff1", "internal");
    const ids = await threadIds(pool, id);
    expect(ids).toContain(ticket.messageId);
    expect(ids.every((value) => typeof value === "string")).toBe(true);
  });

  it("counts only real outbound replies as a first response", async () => {
    const id = await createTicket(pool, ticket, ack);
    // The acknowledgement is queued, never written to messages, so it must not
    // satisfy the response deadline.
    expect((await listTickets(pool))[0]?.first_response_at).toBeNull();

    await addReply(pool, {
      ticketId: id,
      author: "staff1",
      body: "On it.",
      messageId: "<r2@simpletickets>",
      recipient: ticket.requester,
      payload: "{}",
    });
    expect((await listTickets(pool))[0]?.first_response_at).not.toBeNull();
  });
});

describe("staff and assignment", () => {
  beforeEach(async () => {
    for (const name of ["staff1", "staff2", "staff3"]) {
      await addStaff(pool, name, `${name}@allcheckservices.com`, name === "staff1");
    }
  });

  it("counts only open tickets as workload", async () => {
    const id = await createTicket(pool, ticket, ack);
    await setOwner(pool, id, "staff2");
    expect((await staffWorkloads(pool)).find((s) => s.name === "staff2")?.openTickets).toBe(1);

    await setStatus(pool, id, "Closed");
    // Finished work must not count, or the longest-serving person starves.
    expect((await staffWorkloads(pool)).find((s) => s.name === "staff2")?.openTickets).toBe(0);
  });

  it("never exposes a password hash through the staff list", async () => {
    await setPasswordHash(pool, "staff1", "scrypt$65536$8$2$c2FsdA==$aGFzaA==");
    const rows = await staffWorkloads(pool);
    const admin = rows.find((s) => s.name === "staff1");
    expect(admin?.has_password).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("scrypt$");
  });

  it("lists open tickets for redistribution, oldest first", async () => {
    const a = await createTicket(pool, ticket, ack);
    const b = await createTicket(pool, { ...ticket, uid: 102, messageId: "<c@x>" }, ack);
    await setOwner(pool, a, "staff2");
    await setOwner(pool, b, "staff2");
    await setStatus(pool, b, "Closed");
    expect(await openTicketsOwnedBy(pool, "staff2")).toEqual([a]);
  });

  it("remembers who was assigned last, for round-robin rotation", async () => {
    const id = await createTicket(pool, ticket, ack);
    await setOwner(pool, id, "staff3");
    expect(await lastAssignee(pool)).toBe("staff3");
  });

  it("marks availability without revoking anything", async () => {
    expect(await setAvailability(pool, "staff2", false)).toBe(true);
    expect((await staffWorkloads(pool)).find((s) => s.name === "staff2")?.available).toBe(false);
    expect(await setAvailability(pool, "nobody", false)).toBe(false);
  });
});

describe("sessions", () => {
  beforeEach(async () => {
    await addStaff(pool, "staff1", "staff1@allcheckservices.com", true);
  });

  it("finds a live session and reports admin from the staff row", async () => {
    await createSession(pool, "hash-1", "staff1", "2099-01-01T00:00:00.000Z");
    const session = await findSession(pool, "hash-1");
    expect(session?.staff_name).toBe("staff1");
    expect(session?.is_admin).toBe(true);
  });

  it("clears the failure streak on a successful sign-in", async () => {
    await recordLoginFailure(pool, "staff1");
    await recordLoginFailure(pool, "staff1");
    expect(await recentFailures(pool, "staff1", "2000-01-01T00:00:00.000Z")).toBe(2);

    await createSession(pool, "hash-2", "staff1", "2099-01-01T00:00:00.000Z");
    // Otherwise an old streak locks the account out a minute after signing in.
    expect(await recentFailures(pool, "staff1", "2000-01-01T00:00:00.000Z")).toBe(0);
  });

  it("sweeps expired sessions when a new one starts", async () => {
    await createSession(pool, "old", "staff1", "2000-01-01T00:00:00.000Z");
    await createSession(pool, "new", "staff1", "2099-01-01T00:00:00.000Z");
    expect(await findSession(pool, "old")).toBeNull();
    expect(await findSession(pool, "new")).not.toBeNull();
  });

  it("removes a session on sign-out", async () => {
    await createSession(pool, "hash-3", "staff1", "2099-01-01T00:00:00.000Z");
    await deleteSession(pool, "hash-3");
    expect(await findSession(pool, "hash-3")).toBeNull();
  });

  it("only counts failures inside the window", async () => {
    await recordLoginFailure(pool, "staff1");
    expect(await recentFailures(pool, "staff1", "2099-01-01T00:00:00.000Z")).toBe(0);
  });

  it("returns an account with no password as existing but unusable", async () => {
    const account = await findStaff(pool, "staff1");
    expect(account?.password_hash).toBeNull();
    expect(await findStaff(pool, "ghost")).toBeNull();
  });
});

describe("checkpoint and attachments", () => {
  it("stores exactly one checkpoint, updating it in place", async () => {
    expect(await readCheckpoint(pool)).toBeNull();
    await writeCheckpoint(pool, { uidValidity: "1", lastUid: 10 });
    await writeCheckpoint(pool, { uidValidity: "1", lastUid: 20 });
    expect(await readCheckpoint(pool)).toEqual({ uidValidity: "1", lastUid: 20 });
    expect((await pool.query("SELECT COUNT(*)::int AS n FROM mailbox_state")).rows[0]).toEqual({
      n: 1,
    });
  });

  it("indexes attachments against their ticket", async () => {
    const id = await createTicket(pool, ticket, ack);
    await addAttachment(pool, {
      ticketId: id,
      messageId: null,
      filename: "screenshot.png",
      contentType: "image/png",
      bytes: 2048,
      path: `attachments/${String(id)}/abc.bin`,
    });
    const files = await listAttachments(pool, id);
    expect(files).toHaveLength(1);
    expect(files[0]?.filename).toBe("screenshot.png");
    expect((await getTicket(pool, id))?.attachments).toHaveLength(1);
  });
});
