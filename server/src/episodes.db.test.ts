/**
 * Response episodes (R16), against real PostgreSQL.
 *
 * R16 is two sentences that pull in opposite directions, which is why it needs
 * its own suite: "subsequent employee messages require an IT reply within four
 * working hours", and "later employee follow-ups do not reset the first
 * unanswered deadline". One says a new message creates an obligation; the other
 * says a repeated one must not push the existing obligation later.
 *
 * The distinction is whether a response is ALREADY owed. It is, exactly when no
 * outbound message exists after the most recent inbound one.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { Pool } from "pg";
import { testPool, truncate } from "./db/testing.ts";
import {
  createTicket,
  appendReply,
  addReply,
  addNote,
  addStaff,
  getTicket,
  listTickets,
  ticketsNeedingReminder,
} from "./store.ts";

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

const REQUESTER = "ananya.rao@allcheckservices.com";
const ORIGINAL_DUE = "2026-09-17T09:00:00.000Z";
const LATER_DUE = "2026-09-20T09:00:00.000Z";

async function ticket(): Promise<number> {
  return createTicket(pool, {
    uid: 1,
    subject: "Printer jams",
    requester: REQUESTER,
    body: "It keeps jamming.",
    messageId: "<in.1@x>",
    responseDue: ORIGINAL_DUE,
    owner: "staff1",
  });
}

/** A real IT reply. Not an acknowledgement, which is never written to messages. */
async function itReplies(id: number, at: string): Promise<void> {
  await addReply(pool, {
    ticketId: id,
    author: "staff1",
    body: "We have ordered a new roller.",
    messageId: `<reply.${at}@simpletickets>`,
    recipient: REQUESTER,
    payload: "{}",
  });
}

async function employeeWrites(id: number, uid: number, due: string): Promise<void> {
  await appendReply(pool, {
    ticketId: id,
    uid,
    author: REQUESTER,
    body: "Still jamming.",
    messageId: `<in.${String(uid)}@x>`,
    responseDue: due,
  });
}

describe("a response is owed per episode, not per ticket", () => {
  it("counts a brand new ticket as unanswered", async () => {
    const id = await ticket();
    expect((await getTicket(pool, id))?.ticket.first_response_at).toBeNull();
  });

  it("counts it as answered once IT replies", async () => {
    const id = await ticket();
    await itReplies(id, "1");
    expect((await getTicket(pool, id))?.ticket.first_response_at).not.toBeNull();
  });

  /**
   * The bug this suite exists for. With "the earliest outbound message, full
   * stop", a ticket IT had ever replied to read as answered forever - so an
   * employee who wrote back a week later was owed nothing and appeared on no
   * overdue list.
   */
  it("owes a response again when the employee writes back", async () => {
    const id = await ticket();
    await itReplies(id, "1");
    await employeeWrites(id, 2, LATER_DUE);
    expect((await getTicket(pool, id))?.ticket.first_response_at).toBeNull();
  });

  it("is answered again once IT replies to that", async () => {
    const id = await ticket();
    await itReplies(id, "1");
    await employeeWrites(id, 2, LATER_DUE);
    await itReplies(id, "2");
    expect((await getTicket(pool, id))?.ticket.first_response_at).not.toBeNull();
  });

  /**
   * An internal note is not a response (R13). Structurally it cannot be one -
   * it is written with direction 'note' - but the episode query selects on
   * direction, so it is worth pinning.
   */
  it("does not count an internal note as an answer", async () => {
    const id = await ticket();
    await addNote(pool, id, "staff1", "Vendor says the part is on back order.");
    expect((await getTicket(pool, id))?.ticket.first_response_at).toBeNull();
  });
});

describe("which employee messages move the deadline (R16)", () => {
  /**
   * "Later employee follow-ups do not reset the first unanswered deadline."
   * Without this, an anxious employee who writes three times before anyone
   * looks pushes their own deadline out each time - and the ticket that needs
   * attention most drops down the overdue list.
   */
  it("leaves an unanswered deadline where it is", async () => {
    const id = await ticket();
    await employeeWrites(id, 2, LATER_DUE);
    await employeeWrites(id, 3, LATER_DUE);
    expect((await getTicket(pool, id))?.ticket.response_due).toBe(ORIGINAL_DUE);
  });

  /** "Subsequent employee messages require an IT reply within four working hours." */
  it("sets a new deadline when the message opens a new episode", async () => {
    const id = await ticket();
    await itReplies(id, "1");
    await employeeWrites(id, 2, LATER_DUE);
    expect((await getTicket(pool, id))?.ticket.response_due).toBe(LATER_DUE);
  });

  it("then holds that one against a follow-up too", async () => {
    const id = await ticket();
    await itReplies(id, "1");
    await employeeWrites(id, 2, LATER_DUE);
    await employeeWrites(id, 3, "2026-09-25T09:00:00.000Z");
    expect((await getTicket(pool, id))?.ticket.response_due).toBe(LATER_DUE);
  });

  // A caller that supplies no deadline must not clear one.
  it("changes nothing when the caller supplies no deadline", async () => {
    const id = await ticket();
    await itReplies(id, "1");
    await appendReply(pool, {
      ticketId: id,
      uid: 2,
      author: REQUESTER,
      body: "Still jamming.",
      messageId: "<in.2@x>",
    });
    expect((await getTicket(pool, id))?.ticket.response_due).toBe(ORIGINAL_DUE);
  });
});

describe("reminders follow the same definition", () => {
  it("reminds again on a ticket the employee reopened the clock on", async () => {
    const id = await ticket();
    await itReplies(id, "1");
    // Nothing owed: IT has answered the only thing asked.
    expect(await ticketsNeedingReminder(pool, new Date("2026-09-18T00:00:00.000Z"))).toEqual([]);

    await employeeWrites(id, 2, ORIGINAL_DUE);
    const due = await ticketsNeedingReminder(pool, new Date("2026-09-18T00:00:00.000Z"));
    expect(due.map((row) => row.id)).toEqual([id]);
  });

  it("does not remind while the current episode is answered", async () => {
    const id = await ticket();
    await employeeWrites(id, 2, ORIGINAL_DUE);
    await itReplies(id, "1");
    expect(await ticketsNeedingReminder(pool, new Date("2026-09-18T00:00:00.000Z"))).toEqual([]);
  });
});

describe("the queue reports it too", () => {
  it("shows a reopened clock in the list, not only on the detail", async () => {
    const id = await ticket();
    await itReplies(id, "1");
    await employeeWrites(id, 2, LATER_DUE);
    const listed = (await listTickets(pool)).find((row) => row.id === id);
    expect(listed?.first_response_at).toBeNull();
    expect(listed?.response_due).toBe(LATER_DUE);
  });
});
