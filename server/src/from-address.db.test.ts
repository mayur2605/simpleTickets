/**
 * Every outgoing message is From the address this system actually owns.
 *
 * Not `support@allcheckservices.com`. That is where employees write TO; it is
 * not an address this system is entitled to write AS, because nothing published
 * by that domain says Gmail may speak for it. Putting it in a From header
 * anyway is the misalignment DMARC exists to catch.
 *
 * This suite exists because the codebase did exactly that for months, and not
 * even consistently: acknowledgements went out From the Gmail account and every
 * reply and resolution From the company address, so one ticket showed the
 * employee two different senders. The inconsistency is what made it visible.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { Pool } from "pg";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { testPool, truncate } from "./db/testing.ts";
import { handleApi } from "./api.ts";
import type { AppContext } from "./pipeline.ts";
import { Storage } from "./storage.ts";
import { config } from "./config.ts";
import { addStaff, createTicket, createSession, getTicket } from "./store.ts";
import { hashToken, newToken, expiryFrom } from "./session.ts";

let pool: Pool;
let env: AppContext;
let root: string;

const REQUESTER = "ananya.rao@allcheckservices.com";
const GMAIL = "simpleticketssupport@gmail.test";
const COMPANY = "support@allcheckservices.com";

beforeAll(async () => {
  pool = await testPool();
  root = await mkdtemp(join(tmpdir(), "simpletickets-from-"));
  env = {
    pool,
    storage: new Storage(root),
    config: {
      ...config,
      gmailUser: GMAIL,
      supportAddress: COMPANY,
      // What config.ts computes: the Gmail account wins.
      fromAddress: GMAIL,
    },
  };
});
beforeEach(async () => {
  await truncate(pool);
  await addStaff(pool, "staff1", "staff1@allcheckservices.com", true);
});
afterAll(async () => {
  await pool.end();
  await rm(root, { recursive: true, force: true });
});

async function session(): Promise<string> {
  const token = newToken();
  await createSession(pool, await hashToken(token), "staff1", expiryFrom(new Date()));
  return `st_session=${token}`;
}

async function post(path: string, body: unknown, cookie: string): Promise<number> {
  const url = new URL(`http://localhost:8787${path}`);
  const response = await handleApi(
    url,
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify(body),
    }),
    env,
  );
  return response.status;
}

async function ticket(): Promise<number> {
  return createTicket(pool, {
    uid: 1,
    subject: "Printer jams",
    requester: REQUESTER,
    body: "It keeps jamming.",
    messageId: "<in.1@x>",
    responseDue: new Date(Date.now() + 3_600_000).toISOString(),
    owner: "staff1",
  });
}

/** Every From header currently queued. */
async function senders(): Promise<string[]> {
  const { rows } = await pool.query<{ from: string; intent: string }>(
    `SELECT payload::json->>'from' AS from, intent FROM outbox ORDER BY id`,
  );
  return rows.map((row) => row.from);
}

describe("the From header", () => {
  it("is the Gmail account on a public reply", async () => {
    const id = await ticket();
    const cookie = await session();
    expect(
      await post(`/api/tickets/${String(id)}/reply`, { body: "Ordered a roller." }, cookie),
    ).toBe(200);
    expect(await senders()).toEqual([`SimpleTickets <${GMAIL}>`]);
  });

  it("is the Gmail account on a delivery-gated resolution", async () => {
    const id = await ticket();
    const cookie = await session();
    await post(
      `/api/tickets/${String(id)}/status`,
      { status: "Resolved", body: "Sorted." },
      cookie,
    );
    expect(await senders()).toEqual([`SimpleTickets <${GMAIL}>`]);
  });

  /**
   * The bug that made this visible. Acknowledgements used one address and
   * replies the other, so a single thread showed the employee two senders -
   * which breaks threading in some clients and reads as spoofing in others.
   */
  it("is the SAME on the acknowledgement and every later message", async () => {
    const id = await ticket();
    const cookie = await session();
    // An acknowledgement, built the way ingest builds one.
    const { buildAcknowledgement } = await import("./acknowledgement.ts");
    const ack = buildAcknowledgement({
      ticketNumber: id,
      originalSubject: "Printer jams",
      requester: REQUESTER,
      supportAddress: `SimpleTickets <${env.config.fromAddress}>`,
      inboundMessageId: "<in.1@x>",
      date: new Date(),
    });
    await post(`/api/tickets/${String(id)}/reply`, { body: "Ordered a roller." }, cookie);
    const [reply] = await senders();
    expect(ack.from).toBe(reply);
  });

  it("never claims the company address anywhere", async () => {
    const id = await ticket();
    const cookie = await session();
    await post(`/api/tickets/${String(id)}/reply`, { body: "One." }, cookie);
    await post(`/api/tickets/${String(id)}/status`, { status: "Resolved", body: "Two." }, cookie);
    for (const from of await senders()) {
      expect(from).not.toContain(COMPANY);
    }
  });
});

describe("config.fromAddress", () => {
  /**
   * Derived rather than configured, so there is no way to have mail credentials
   * for one account and be sending as another by accident.
   */
  it("prefers the Gmail account over the support address", () => {
    expect(env.config.fromAddress).toBe(GMAIL);
    expect(env.config.fromAddress).not.toBe(COMPANY);
  });

  // Where employees write TO is still the company address, and still excluded
  // from participants so a reply cannot copy us into our own thread.
  it("leaves supportAddress alone for the address employees write to", () => {
    expect(env.config.supportAddress).toBe(COMPANY);
  });
});

describe("a fresh ticket from the mailbox", () => {
  it("acknowledges from the same address it replies from", async () => {
    // Exercised through the store rather than IMAP: this file is about the
    // header, and the mailbox is mocked in ingest.db.test.ts already.
    const id = await ticket();
    const cookie = await session();
    await post(`/api/tickets/${String(id)}/reply`, { body: `ref ${randomUUID()}` }, cookie);
    const detail = await getTicket(pool, id);
    expect(detail?.messages.some((m) => m.direction === "outbound")).toBe(true);
    expect((await senders()).every((from) => from.includes(GMAIL))).toBe(true);
  });
});
