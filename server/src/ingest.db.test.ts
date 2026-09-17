/**
 * The ingestion pipeline, end to end, against real PostgreSQL and a fake
 * mailbox.
 *
 * `imap.ts` is mocked and nothing else is: the database, the store, the
 * threading, the domain rules and the outbox are all the real ones. That is
 * deliberate — the bugs this suite exists to catch live in how those pieces fit
 * together, not inside any one of them, and every previous attempt to verify
 * them ended in "read the code and reasoned about it".
 *
 * It also closes two gaps T010 named outright: downtime catch-up and a
 * UIDVALIDITY change, both of which needed a mailbox that could be made to
 * misbehave on demand.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import type { Pool } from "pg";

const mailbox = {
  uidValidity: "1000",
  uidNext: 1,
  messages: [] as unknown[],
};

vi.mock("./imap.ts", () => ({
  readNewMail: (_user: string, _password: string, sinceUid: number) =>
    Promise.resolve({
      uidValidity: mailbox.uidValidity,
      uidNext: mailbox.uidNext,
      messages: mailbox.messages.filter((message) => (message as { uid: number }).uid > sinceUid),
    }),
  readMailboxMarkers: () =>
    Promise.resolve({ uidValidity: mailbox.uidValidity, uidNext: mailbox.uidNext }),
}));

const { testPool, truncate } = await import("./db/testing.ts");
const { ingest, assignTicket } = await import("./pipeline.ts");
const { Storage } = await import("./storage.ts");
const store = await import("./store.ts");

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config.ts";
import type { AppContext } from "./pipeline.ts";

let pool: Pool;
let env: AppContext;
let storageDir: string;

const REQUESTER = "ananya.rao@allcheckservices.com";

/** A message as imap.ts would hand it over. */
function mail(
  uid: number,
  overrides: Partial<{
    from: string;
    subject: string;
    body: string;
    messageId: string | null;
    inReplyTo: string | null;
    references: string | null;
    rawHeaders: string;
    cc: string | null;
    oversized: string[];
  }> = {},
): Record<string, unknown> {
  return {
    uid,
    from: REQUESTER,
    subject: "Printer jams",
    body: "It keeps jamming.",
    messageId: `<in.${String(uid)}@mail.test>`,
    inReplyTo: null,
    references: null,
    rawHeaders: `From: ${REQUESTER}\r\nSubject: Printer jams\r\n`,
    cc: null,
    source: null,
    attachments: [],
    oversized: [],
    ...overrides,
  };
}

beforeAll(async () => {
  pool = await testPool();
  storageDir = await mkdtemp(join(tmpdir(), "simpletickets-ingest-"));
  env = {
    pool,
    storage: new Storage(storageDir),
    config: { ...config, gmailUser: "bot@gmail.test", gmailAppPassword: "x" },
  };
});

beforeEach(async () => {
  await truncate(pool);
  mailbox.uidValidity = "1000";
  mailbox.uidNext = 1;
  mailbox.messages = [];
});

afterAll(async () => {
  await pool.end();
  await rm(storageDir, { recursive: true, force: true });
});

/** Anchor the checkpoint so the next run imports rather than initialising. */
async function anchor(lastUid = 0): Promise<void> {
  await store.writeCheckpoint(pool, { uidValidity: mailbox.uidValidity, lastUid });
}

describe("the launch cutoff (R27)", () => {
  /**
   * The first run adopts the mailbox as it stands and imports nothing. Without
   * this, switching the system on turns every unread email anyone ever sent
   * into a ticket with a four-hour deadline.
   */
  it("imports nothing on first run and anchors below uidNext", async () => {
    mailbox.uidNext = 12;
    mailbox.messages = [mail(9), mail(10)];

    const summary = await ingest(env);
    expect(summary.initialised).toBe(true);
    expect(summary.created).toBe(0);
    expect(await store.readCheckpoint(pool)).toEqual({ uidValidity: "1000", lastUid: 11 });
    expect(await store.listTickets(pool)).toEqual([]);
  });
});

describe("downtime catch-up", () => {
  /**
   * T010 asks for this explicitly and it was previously untested. A server that
   * was off over a weekend comes back to a mailbox with days of new UIDs, and
   * every one of them must become a ticket exactly once.
   */
  it("processes everything that arrived while the server was down", async () => {
    await anchor(5);
    mailbox.uidNext = 11;
    mailbox.messages = [mail(6), mail(7), mail(8), mail(9), mail(10)];

    const summary = await ingest(env);
    expect(summary.created).toBe(5);
    expect(summary.lastUid).toBe(10);
    expect(await store.listTickets(pool)).toHaveLength(5);
  });

  /**
   * `N:*` re-reports the newest message even when nothing is new, and cron runs
   * overlap. ingest_log's primary key is what makes a re-run harmless; this
   * proves it end to end rather than by reading the constraint.
   */
  it("is idempotent when the same run happens twice", async () => {
    await anchor(5);
    mailbox.uidNext = 8;
    mailbox.messages = [mail(6), mail(7)];

    expect((await ingest(env)).created).toBe(2);
    const second = await ingest(env);
    expect(second.created).toBe(0);
    expect(await store.listTickets(pool)).toHaveLength(2);
    // One acknowledgement each, never two.
    expect((await store.outboxSummary(pool))["pending"]).toBe(2);
  });
});

describe("a UIDVALIDITY change", () => {
  /**
   * The server has renumbered every message, so the stored UID means nothing.
   * Re-anchoring is right and re-importing is not: the mailbox still holds
   * every message we have already turned into a ticket.
   */
  it("re-anchors instead of re-importing the mailbox", async () => {
    await anchor(5);
    mailbox.uidValidity = "2000";
    mailbox.uidNext = 4;
    mailbox.messages = [mail(1), mail(2), mail(3)];

    const summary = await ingest(env);
    expect(summary.uidValidityChanged).toBe(true);
    expect(summary.created).toBe(0);
    expect(await store.readCheckpoint(pool)).toEqual({ uidValidity: "2000", lastUid: 3 });
    expect(await store.listTickets(pool)).toEqual([]);
  });
});

describe("CC participants on ingest (R25)", () => {
  it("records eligible company colleagues and drops external ones", async () => {
    await anchor();
    mailbox.uidNext = 2;
    mailbox.messages = [
      mail(1, { cc: "Sam@allcheckservices.com, vendor@example.com, support@allcheckservices.com" }),
    ];

    await ingest(env);
    // The vendor is external; the support mailbox is us.
    expect(await store.listParticipants(pool, 1)).toEqual(["sam@allcheckservices.com"]);
  });

  /**
   * R25: "Eligible company-domain CC recipients can reply and add messages to
   * the same ticket."
   */
  it("lets a copied colleague reply onto the ticket", async () => {
    await anchor();
    mailbox.uidNext = 2;
    mailbox.messages = [mail(1, { cc: "sam@allcheckservices.com" })];
    await ingest(env);

    mailbox.uidNext = 3;
    mailbox.messages = [
      mail(2, {
        from: "sam@allcheckservices.com",
        body: "I see it too.",
        inReplyTo: "<in.1@mail.test>",
      }),
    ];
    const summary = await ingest(env);
    expect(summary.appended).toBe(1);
    const detail = await store.getTicket(pool, 1);
    expect(detail?.messages.at(-1)?.author).toBe("sam@allcheckservices.com");
  });

  /**
   * The case the requirement exists for. Everyone in the company is on the
   * approved domain, so nothing about the ADDRESS stops a stranger threading
   * onto a colleague's ticket - only membership does.
   */
  it("refuses an unrelated same-domain sender", async () => {
    await anchor();
    mailbox.uidNext = 2;
    mailbox.messages = [mail(1)];
    await ingest(env);

    mailbox.uidNext = 3;
    mailbox.messages = [
      mail(2, {
        from: "stranger@allcheckservices.com",
        body: "What is this?",
        inReplyTo: "<in.1@mail.test>",
      }),
    ];
    const summary = await ingest(env);
    expect(summary.appended).toBe(0);

    const detail = await store.getTicket(pool, 1);
    expect(detail?.messages).toHaveLength(1);
    // Recorded rather than dropped: somebody wrote something, and IT can add
    // them deliberately if they were right to try.
    expect(detail?.audit.map((entry) => entry.action)).toContain("reply_refused");
    const log = await pool.query<{ outcome: string }>(
      `SELECT outcome FROM ingest_log WHERE uid = 2`,
    );
    expect(log.rows[0]?.outcome).toBe("not_a_participant");
  });

  it("stops accepting a participant's replies once IT removes them", async () => {
    await anchor();
    mailbox.uidNext = 2;
    mailbox.messages = [mail(1, { cc: "sam@allcheckservices.com" })];
    await ingest(env);
    await store.removeParticipant(pool, 1, "sam@allcheckservices.com", "staff1");

    mailbox.uidNext = 3;
    mailbox.messages = [
      mail(2, { from: "sam@allcheckservices.com", inReplyTo: "<in.1@mail.test>" }),
    ];
    expect((await ingest(env)).appended).toBe(0);
  });

  /**
   * R25: "The requester may add company colleagues by CC'ing them on a later
   * authenticated reply." Nobody else can - a participant who added three more
   * would grow the audience of somebody else's IT conversation.
   */
  it("lets the requester add a colleague by copying them on a reply", async () => {
    await anchor();
    mailbox.uidNext = 2;
    mailbox.messages = [mail(1)];
    await ingest(env);

    mailbox.uidNext = 3;
    mailbox.messages = [mail(2, { inReplyTo: "<in.1@mail.test>", cc: "sam@allcheckservices.com" })];
    await ingest(env);
    expect(await store.listParticipants(pool, 1)).toEqual(["sam@allcheckservices.com"]);
  });

  it("ignores a participant trying to add someone, and says so in the audit", async () => {
    await anchor();
    mailbox.uidNext = 2;
    mailbox.messages = [mail(1, { cc: "sam@allcheckservices.com" })];
    await ingest(env);

    mailbox.uidNext = 3;
    mailbox.messages = [
      mail(2, {
        from: "sam@allcheckservices.com",
        inReplyTo: "<in.1@mail.test>",
        cc: "newcomer@allcheckservices.com",
      }),
    ];
    await ingest(env);

    expect(await store.listParticipants(pool, 1)).toEqual(["sam@allcheckservices.com"]);
    const detail = await store.getTicket(pool, 1);
    expect(detail?.audit.map((entry) => entry.action)).toContain("participant_addition_ignored");
  });

  /**
   * R25: "Omitting an existing participant from an email does not remove them."
   * A mail client that drops the Cc line on a reply is common, and treating
   * that as a removal would quietly cut people out of conversations.
   */
  it("keeps a participant who is left off a later reply", async () => {
    await anchor();
    mailbox.uidNext = 2;
    mailbox.messages = [mail(1, { cc: "sam@allcheckservices.com" })];
    await ingest(env);

    mailbox.uidNext = 3;
    mailbox.messages = [mail(2, { inReplyTo: "<in.1@mail.test>", cc: null })];
    await ingest(env);
    expect(await store.listParticipants(pool, 1)).toEqual(["sam@allcheckservices.com"]);
  });

  /**
   * A reply reopens a Resolved ticket and must not postpone the existing
   * deadline. Proved here for a CC participant specifically, because R25 says
   * their replies follow the same rules as the requester's.
   */
  it("reopens a resolved ticket on a participant's reply without moving the deadline", async () => {
    await anchor();
    mailbox.uidNext = 2;
    mailbox.messages = [mail(1, { cc: "sam@allcheckservices.com" })];
    await ingest(env);
    await store.setStatus(pool, 1, "Resolved", "staff1");
    const before = (await store.getTicket(pool, 1))?.ticket.response_due;

    mailbox.uidNext = 3;
    mailbox.messages = [
      mail(2, { from: "sam@allcheckservices.com", inReplyTo: "<in.1@mail.test>" }),
    ];
    await ingest(env);

    const after = await store.getTicket(pool, 1);
    expect(after?.ticket.status).toBe("In Progress");
    expect(after?.ticket.response_due).toBe(before);
  });
});

describe("oversized attachments (R12)", () => {
  /**
   * The employee attached them and has no way to know they did not arrive. The
   * notice is queued with no `messages` row on purpose: `first_response_at` is
   * the earliest outbound message, so recording it would have an automatic size
   * notice satisfy the four-hour response deadline.
   */
  it("tells the employee, once, without satisfying the response deadline", async () => {
    await anchor();
    mailbox.uidNext = 2;
    mailbox.messages = [mail(1, { oversized: ["holiday-video.mov"] })];
    await ingest(env);

    const queued = await pool.query<{ payload: string }>(
      `SELECT payload FROM outbox WHERE intent = 'reply'`,
    );
    expect(queued.rows).toHaveLength(1);
    expect(queued.rows[0]?.payload).toContain("holiday-video.mov");

    const detail = await store.getTicket(pool, 1);
    expect(detail?.messages.every((message) => message.direction === "inbound")).toBe(true);
    expect(detail?.ticket.first_response_at).toBeNull();
  });

  it("does not repeat the notice on a later oversized reply", async () => {
    await anchor();
    mailbox.uidNext = 2;
    mailbox.messages = [mail(1, { oversized: ["one.mov"] })];
    await ingest(env);

    mailbox.uidNext = 3;
    mailbox.messages = [mail(2, { inReplyTo: "<in.1@mail.test>", oversized: ["two.mov"] })];
    await ingest(env);

    const queued = await pool.query(`SELECT 1 FROM outbox WHERE intent = 'reply'`);
    expect(queued.rowCount).toBe(1);
  });
});

describe("nobody available (R24)", () => {
  /**
   * An unassigned ticket has no assignee to remind, so without an alert it
   * sits silently until its deadline passes and the overdue reminder finally
   * reaches an admin - hours late, by design rather than by accident.
   */
  it("alerts every admin when a ticket cannot be assigned", async () => {
    await store.addStaff(pool, "staff1", "staff1@allcheckservices.com", true);
    await store.addStaff(pool, "staff2", "staff2@allcheckservices.com");
    await store.setAvailability(pool, "staff1", false, "admin");
    await store.setAvailability(pool, "staff2", false, "admin");

    await anchor();
    mailbox.uidNext = 2;
    mailbox.messages = [mail(1)];
    await ingest(env);

    expect((await store.getTicket(pool, 1))?.ticket.owner).toBeNull();
    const notifications = await pool.query<{ recipient: string }>(
      `SELECT recipient FROM outbox WHERE intent = 'notification' AND message_id LIKE '%unassigned%'`,
    );
    expect(notifications.rows.map((row) => row.recipient)).toEqual(["staff1@allcheckservices.com"]);
  });

  it("does not alert when somebody picked it up", async () => {
    await store.addStaff(pool, "staff1", "staff1@allcheckservices.com", true);
    await anchor();
    mailbox.uidNext = 2;
    mailbox.messages = [mail(1)];
    await ingest(env);

    expect((await store.getTicket(pool, 1))?.ticket.owner).toBe("staff1");
    const alerts = await pool.query(`SELECT 1 FROM outbox WHERE message_id LIKE '%unassigned%'`);
    expect(alerts.rowCount).toBe(0);
  });

  /**
   * A disabled account must not receive work even while it is still marked
   * available - the two columns are separate and only `assignable` ANDs them.
   */
  it("never assigns to a disabled account", async () => {
    await store.addStaff(pool, "staff1", "staff1@allcheckservices.com", true);
    await store.addStaff(pool, "staff2", "staff2@allcheckservices.com");
    await store.setEnabled(pool, "staff2", false, "staff1");

    await anchor();
    mailbox.uidNext = 3;
    mailbox.messages = [mail(1), mail(2, { messageId: "<in.2@mail.test>" })];
    await ingest(env);

    const owners = (await store.listTickets(pool)).map((ticket) => ticket.owner);
    expect(owners).toEqual(["staff1", "staff1"]);
  });
});

describe("reopening a ticket whose owner has gone (R10)", () => {
  /**
   * R10 says a reopened ticket keeps its previous owner "if available". An
   * account disabled since the ticket was resolved would otherwise own a live
   * conversation nobody is reading - the exact failure redistribution exists to
   * prevent, arriving through a door redistribution does not watch.
   */
  it("moves it to somebody who can work it", async () => {
    await store.addStaff(pool, "staff1", "staff1@allcheckservices.com", true);
    await store.addStaff(pool, "staff2", "staff2@allcheckservices.com");
    await anchor();
    mailbox.uidNext = 2;
    mailbox.messages = [mail(1)];
    await ingest(env);

    const owner = (await store.getTicket(pool, 1))?.ticket.owner;
    expect(owner).not.toBeNull();
    await store.setStatus(pool, 1, "Resolved", "staff1");
    await store.setEnabled(pool, owner ?? "", false, "staff1");

    mailbox.uidNext = 3;
    mailbox.messages = [mail(2, { inReplyTo: "<in.1@mail.test>" })];
    await ingest(env);

    const after = await store.getTicket(pool, 1);
    expect(after?.ticket.status).toBe("In Progress");
    expect(after?.ticket.owner).not.toBe(owner);
    expect(after?.ticket.owner).not.toBeNull();
  });

  it("leaves the owner alone when they can still work it", async () => {
    await store.addStaff(pool, "staff1", "staff1@allcheckservices.com", true);
    await anchor();
    mailbox.uidNext = 2;
    mailbox.messages = [mail(1)];
    await ingest(env);
    await store.setStatus(pool, 1, "Resolved", "staff1");

    mailbox.uidNext = 3;
    mailbox.messages = [mail(2, { inReplyTo: "<in.1@mail.test>" })];
    await ingest(env);
    expect((await store.getTicket(pool, 1))?.ticket.owner).toBe("staff1");
  });
});

describe("assignment is serialised (R07)", () => {
  /**
   * Two assignments deciding at once both read the same workloads and both pick
   * the same least-loaded person, who ends up with two tickets while somebody
   * else gets none. Rare with one poller - which is why it went unnoticed - but
   * it is the same hazard the outbox claim solves, and assignment had no
   * equivalent lock until now.
   *
   * With two idle staff and two tickets assigned concurrently, the round-robin
   * tie-break must hand out one each.
   */
  it("does not give two concurrent tickets to the same idle person", async () => {
    await store.addStaff(pool, "staff1", "staff1@allcheckservices.com", true);
    await store.addStaff(pool, "staff2", "staff2@allcheckservices.com");
    await anchor();
    mailbox.uidNext = 3;
    mailbox.messages = [mail(1), mail(2, { messageId: "<in.2@mail.test>" })];
    await ingest(env);

    // Unassign both, then race the two assignments against each other.
    await store.setOwner(pool, 1, null, "test");
    await store.setOwner(pool, 2, null, "test");
    const [first, second] = await Promise.all([
      assignTicket(env, 1, "test"),
      assignTicket(env, 2, "test"),
    ]);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).not.toBe(second);
  });
});

describe("malformed mail (T014)", () => {
  it("logs an unparseable sender instead of opening a ticket", async () => {
    await anchor();
    mailbox.uidNext = 2;
    mailbox.messages = [mail(1, { from: "Ananya Rao (no address at all)" })];
    const summary = await ingest(env);
    expect(summary.created).toBe(0);
    const log = await pool.query<{ outcome: string }>(
      `SELECT outcome FROM ingest_log WHERE uid = 1`,
    );
    // Rejected before parsing: a header with no address does not match the
    // approved domain either, which is the earlier and stricter gate.
    expect(["rejected_sender", "error"]).toContain(log.rows[0]?.outcome);
  });

  /**
   * A message with nothing in it is still a message. Opening a ticket with an
   * empty body is right: somebody wrote in, IT should see it, and inventing a
   * placeholder would put words in the employee's mouth.
   */
  it("opens a ticket for an empty body and a missing subject", async () => {
    await anchor();
    mailbox.uidNext = 2;
    mailbox.messages = [mail(1, { body: "", subject: "" })];
    expect((await ingest(env)).created).toBe(1);
    const detail = await store.getTicket(pool, 1);
    expect(detail?.messages[0]?.body).toBe("");
  });

  // A message with no Message-ID cannot be threaded onto and cannot collide:
  // the unique index on messages.message_id is partial for exactly this.
  it("accepts a message with no Message-ID, twice over", async () => {
    await anchor();
    mailbox.uidNext = 3;
    mailbox.messages = [
      mail(1, { messageId: null }),
      mail(2, { messageId: null, subject: "Another" }),
    ];
    expect((await ingest(env)).created).toBe(2);
  });

  it("survives a References header that is only punctuation", async () => {
    await anchor();
    mailbox.uidNext = 2;
    mailbox.messages = [mail(1, { references: "<<<>>> , ; <>", inReplyTo: "not-an-id" })];
    expect((await ingest(env)).created).toBe(1);
  });
});
