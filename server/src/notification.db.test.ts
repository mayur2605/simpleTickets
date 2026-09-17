/**
 * Notification behaviour that only shows up against a real database (R15, R18).
 *
 * The one that matters most is the first: IT staff are on the approved sender
 * domain, so a staff member who hits Reply on a notification produces a message
 * that looks exactly like an employee's. Nothing about the address stops it.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { Pool } from "pg";
import { testPool, truncate, TEST_DATABASE_URL } from "./db/testing.ts";
import {
  createTicket,
  addStaff,
  setOwner,
  setStatus,
  addReply,
  findTicketByMessageIds,
  isNotificationThread,
  ticketsNeedingReminder,
  outboxSummary,
  listTickets,
} from "./store.ts";
import { sendReminders, notifyAssignee, type AppContext } from "./pipeline.ts";
import { Storage } from "./storage.ts";
import { config } from "./config.ts";

let pool: Pool;
let env: AppContext;

beforeAll(async () => {
  pool = await testPool();
  env = {
    pool,
    storage: new Storage("/tmp/simpletickets-notify-test"),
    config: { ...config, databaseUrl: TEST_DATABASE_URL, dashboardUrl: "http://localhost:8787" },
  };
});
beforeEach(async () => {
  await truncate(pool);
  for (const name of ["staff1", "staff2"]) {
    await addStaff(pool, name, `${name}@allcheckservices.com`, name === "staff1");
  }
});
afterAll(async () => {
  await pool.end();
});

const NOW = new Date("2026-09-17T10:00:00.000Z");

async function ticketOverdueSince(due: string): Promise<number> {
  const id = await createTicket(pool, {
    owner: "staff2",
    responseDue: due,
    uid: Math.floor(Math.random() * 1_000_000),
    subject: "Laptop will not boot",
    requester: "ananya.rao@allcheckservices.com",
    body: "Blue screen.",
    messageId: `<e${String(Math.random())}@allcheckservices.com>`,
  });
  return id;
}

describe("a reply to a one-way notification", () => {
  it("does not thread onto the ticket", async () => {
    const id = await ticketOverdueSince("2026-09-17T09:00:00.000Z");
    await notifyAssignee(env, id, "assigned");

    const { rows } = await pool.query<{ message_id: string }>(
      `SELECT message_id FROM outbox WHERE intent = 'notification'`,
    );
    const notificationId = rows[0]?.message_id ?? "";
    expect(notificationId).toMatch(/^<notify\./);

    // This is the whole point: the notification IS in the outbox, and a lookup
    // by its Message-ID must still find nothing. A staff reply quoting it
    // would otherwise be appended to the ticket as though the employee wrote
    // it, restarting the response clock.
    expect(await findTicketByMessageIds(pool, [notificationId])).toBeNull();
    expect(await isNotificationThread(pool, [notificationId])).toBe(true);
  });

  it("still threads on a real reply we sent", async () => {
    const id = await ticketOverdueSince("2026-09-17T09:00:00.000Z");
    await addReply(pool, {
      ticketId: id,
      author: "staff2",
      body: "Looking into it.",
      messageId: "<reply.real@simpletickets>",
      recipient: "ananya.rao@allcheckservices.com",
      payload: "{}",
    });
    expect(await findTicketByMessageIds(pool, ["<reply.real@simpletickets>"])).toBe(id);
    expect(await isNotificationThread(pool, ["<reply.real@simpletickets>"])).toBe(false);
  });

  it("recognises nothing when there are no candidates", async () => {
    expect(await isNotificationThread(pool, [])).toBe(false);
  });
});

describe("assignment notifications", () => {
  it("queues one for the assignee, and nothing for an unassigned ticket", async () => {
    const assigned = await ticketOverdueSince("2026-09-17T09:00:00.000Z");
    expect(await notifyAssignee(env, assigned, "assigned")).toBe(true);

    await setOwner(pool, assigned, null);
    expect(await notifyAssignee(env, assigned, "assigned")).toBe(false);
  });

  it("goes to the assignee's address, not the employee's", async () => {
    const id = await ticketOverdueSince("2026-09-17T09:00:00.000Z");
    await notifyAssignee(env, id, "employee_reply");
    const { rows } = await pool.query<{ recipient: string }>(
      `SELECT recipient FROM outbox WHERE intent = 'notification'`,
    );
    expect(rows[0]?.recipient).toBe("staff2@allcheckservices.com");
  });
});

describe("overdue reminders", () => {
  it("finds an overdue, unanswered ticket", async () => {
    await ticketOverdueSince("2026-09-17T09:00:00.000Z");
    expect(await ticketsNeedingReminder(pool, NOW)).toHaveLength(1);
  });

  it("ignores one that is not due yet", async () => {
    await ticketOverdueSince("2026-09-17T18:00:00.000Z");
    expect(await ticketsNeedingReminder(pool, NOW)).toHaveLength(0);
  });

  // R18: no reminders while the ball is in the employee's court.
  it("ignores Waiting for Employee, Resolved and Closed", async () => {
    for (const status of ["Waiting for Employee", "Resolved", "Closed"]) {
      await truncate(pool);
      await addStaff(pool, "staff2", "staff2@allcheckservices.com");
      const id = await ticketOverdueSince("2026-09-17T09:00:00.000Z");
      await setStatus(pool, id, status);
      expect(await ticketsNeedingReminder(pool, NOW)).toHaveLength(0);
    }
  });

  /**
   * R28: only a real reply from IT stops the clock. The automatic
   * acknowledgement is never written to `messages`, so it cannot satisfy this —
   * which this test proves by creating a ticket WITH an acknowledgement queued
   * and still expecting a reminder.
   */
  it("is not satisfied by the automatic acknowledgement", async () => {
    await createTicket(
      pool,
      {
        owner: "staff2",
        responseDue: "2026-09-17T09:00:00.000Z",
        uid: 7001,
        subject: "Printer",
        requester: "ananya.rao@allcheckservices.com",
        body: "Jammed.",
        messageId: "<ack-test@allcheckservices.com>",
      },
      (ticketId) => ({
        ticketId,
        intent: "acknowledgement" as const,
        recipient: "ananya.rao@allcheckservices.com",
        messageId: `<ack.${String(ticketId)}@simpletickets>`,
        payload: "{}",
      }),
    );
    expect(await ticketsNeedingReminder(pool, NOW)).toHaveLength(1);
  });

  it("stops once IT actually replies", async () => {
    const id = await ticketOverdueSince("2026-09-17T09:00:00.000Z");
    await addReply(pool, {
      ticketId: id,
      author: "staff2",
      body: "On it.",
      messageId: "<r@simpletickets>",
      recipient: "ananya.rao@allcheckservices.com",
      payload: "{}",
    });
    expect(await ticketsNeedingReminder(pool, NOW)).toHaveLength(0);
  });

  it("copies the assignee and every admin", async () => {
    await ticketOverdueSince("2026-09-17T09:00:00.000Z");
    const sent = await sendReminders(env, NOW);
    expect(sent).toBe(2);

    const { rows } = await pool.query<{ recipient: string }>(
      `SELECT recipient FROM outbox WHERE intent = 'notification' ORDER BY recipient`,
    );
    expect(rows.map((r) => r.recipient)).toEqual([
      "staff1@allcheckservices.com",
      "staff2@allcheckservices.com",
    ]);
  });

  /**
   * The reminder must not repeat on the very next tick — which is two minutes
   * later, not four working hours. Without the recorded timestamp this would
   * send a reminder every two minutes, forever.
   */
  it("does not repeat before four working hours have passed", async () => {
    await ticketOverdueSince("2026-09-17T09:00:00.000Z");
    expect(await sendReminders(env, NOW)).toBe(2);
    // Two minutes later, the next tick.
    expect(await sendReminders(env, new Date("2026-09-17T10:02:00.000Z"))).toBe(0);
    // Two hours later: still inside the window.
    expect(await sendReminders(env, new Date("2026-09-17T12:00:00.000Z"))).toBe(0);
  });

  it("repeats once four working hours have passed", async () => {
    await ticketOverdueSince("2026-09-17T09:00:00.000Z");
    expect(await sendReminders(env, NOW)).toBe(2);
    // 10:00 UTC is 15:30 IST; four working hours later is 10:30 IST the next
    // day, because the working day ends at 18:00. Well past that:
    expect(await sendReminders(env, new Date("2026-09-18T08:00:00.000Z"))).toBe(2);
    expect((await outboxSummary(pool))["pending"]).toBe(4);
  });

  it("records the attempt even when nobody can be reached", async () => {
    await truncate(pool);
    // No staff at all: no assignee address, no admin address.
    const id = await ticketOverdueSince("2026-09-17T09:00:00.000Z");
    await setOwner(pool, id, null);
    expect(await sendReminders(env, NOW)).toBe(0);
    // Recorded anyway, or this ticket is retried every two minutes forever.
    expect((await listTickets(pool))[0]).toBeDefined();
    expect(await sendReminders(env, new Date("2026-09-17T10:02:00.000Z"))).toBe(0);
    const { rows } = await pool.query<{ last_reminder_at: string | null }>(
      `SELECT last_reminder_at FROM tickets WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.last_reminder_at).not.toBeNull();
  });
});
