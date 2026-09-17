/**
 * Proves a backup can actually be restored.
 *
 * The constitution asks for evidence before release, and names backup restore
 * specifically. A dump file existing is not that evidence: it proves something
 * was written, not that anything can be read back. This takes a real dump of a
 * database with real rows, drops those rows, restores, and checks they came
 * back — which is the only form of the claim worth making.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testPool, truncate, TEST_DATABASE_URL } from "./db/testing.ts";
import { runBackup, restoreBackup, runFileBackup, restoreFiles } from "./backup.ts";
import { config } from "./config.ts";
import {
  createTicket,
  listTickets,
  addStaff,
  getTicket,
  addAttachment,
  getAttachment,
} from "./store.ts";
import { Storage } from "./storage.ts";

let pool: Pool;
let dir: string;

beforeAll(async () => {
  pool = await testPool();
  dir = await mkdtemp(join(tmpdir(), "simpletickets-restore-"));
  await truncate(pool);
});

afterAll(async () => {
  await pool.end();
  await rm(dir, { recursive: true, force: true });
});

describe("backup and restore", () => {
  it("restores tickets, messages and staff after the database is emptied", async () => {
    await addStaff(pool, "staff1", "staff1@allcheckservices.com", true);
    const id = await createTicket(
      pool,
      {
        owner: "staff1",
        responseDue: "2026-09-18T12:00:00.000Z",
        uid: 900,
        subject: "Printer jammed",
        requester: "ananya.rao@allcheckservices.com",
        body: "Paper is stuck in tray 2.",
        messageId: "<backup-test@allcheckservices.com>",
      },
      (ticketId) => ({
        ticketId,
        intent: "acknowledgement" as const,
        recipient: "ananya.rao@allcheckservices.com",
        messageId: `<ack.${String(ticketId)}@simpletickets>`,
        payload: "{}",
      }),
    );

    const dump = await runBackup({ ...config, databaseUrl: TEST_DATABASE_URL, backupDir: dir });

    // Lose everything.
    await truncate(pool);
    expect(await listTickets(pool)).toHaveLength(0);

    await restoreBackup(dump, TEST_DATABASE_URL);

    const restored = await getTicket(pool, id);
    expect(restored?.ticket.subject).toBe("Printer jammed");
    expect(restored?.ticket.owner).toBe("staff1");
    expect(restored?.messages).toHaveLength(1);
    expect(restored?.messages[0]?.body).toBe("Paper is stuck in tray 2.");
  });

  /**
   * A restored database must still be writable. Identity sequences are the
   * usual casualty: restore the rows without their sequence state and the next
   * insert collides with an id that already exists.
   */
  it("leaves the restored database able to accept new tickets", async () => {
    const next = await createTicket(
      pool,
      {
        owner: null,
        responseDue: "2026-09-18T12:00:00.000Z",
        uid: 901,
        subject: "After the restore",
        requester: "ananya.rao@allcheckservices.com",
        body: "Still working.",
        messageId: "<after-restore@allcheckservices.com>",
      },
      undefined,
    );
    expect(next).toBeGreaterThan(0);
    expect(await listTickets(pool)).toHaveLength(2);
  });
});

/**
 * R24 asks for a restore that proves "message/attachment consistency". A
 * pg_dump alone cannot: attachments live on disk, so restoring the database on
 * its own produces an `attachments` table whose every row points at a file that
 * is not there — a backup that looks complete and is not.
 */
describe("restoring attachments with the database", () => {
  it("brings the bytes back, and the rows still point at them", async () => {
    const root = await mkdtemp(join(tmpdir(), "simpletickets-files-"));
    const storageDir = join(root, "storage");
    const backupDir = join(root, "backups");
    const storage = new Storage(storageDir);
    const settings = { ...config, databaseUrl: TEST_DATABASE_URL, storageDir, backupDir };

    const ticketId = await createTicket(pool, {
      uid: 1,
      subject: "Printer jams",
      requester: "ananya.rao@allcheckservices.com",
      body: "See the photo.",
      messageId: "<in.1@mail.test>",
      responseDue: new Date().toISOString(),
      owner: null,
    });
    const path = await storage.storeAttachment(ticketId, Buffer.from("PNG-BYTES"));
    await addAttachment(pool, {
      ticketId,
      messageId: null,
      filename: "jam.png",
      contentType: "image/png",
      bytes: 9,
      path,
    });

    const started = Date.now();
    const dump = await runBackup(settings);
    const archive = await runFileBackup(settings);
    expect(archive).not.toBeNull();

    // Lose both halves, exactly as a disk failure would.
    await truncate(pool);
    await rm(storageDir, { recursive: true, force: true });
    expect(await storage.exists(path)).toBe(false);

    await restoreBackup(dump, TEST_DATABASE_URL, config.pgBin);
    await restoreFiles(archive ?? "", storageDir);
    const restoreMs = Date.now() - started;

    // The row is back, and so is the file it names - which is the whole point.
    const row = await getAttachment(pool, 1);
    expect(row?.filename).toBe("jam.png");
    expect((await storage.read(row?.path ?? "")).toString()).toBe("PNG-BYTES");
    // Recorded rather than asserted against a threshold: a number that varies
    // with the machine would make this test fail for reasons that are not bugs.
    console.log(JSON.stringify({ event: "restore_measured", restoreMs }));

    await rm(root, { recursive: true, force: true });
  });
});
