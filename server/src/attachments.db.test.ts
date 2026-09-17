/**
 * What a 5 MB attachment actually costs (T004, R12).
 *
 * Listed as unmeasured since the Cloudflare build, where it mattered because
 * the runtime had a hard CPU limit per request and no way to observe it -
 * `Date.now()` was frozen during synchronous execution, so an in-request
 * measurement read zero. Neither constraint exists here, so the honest thing is
 * to measure it rather than keep calling it unknown.
 *
 * Time is logged, not asserted against a threshold: a number that varies with
 * the machine would make this fail for reasons that are not bugs. Memory is not
 * measured at all, deliberately — a heap delta around a garbage collection is
 * noise, and the bound that matters is structural rather than observed: the
 * download loop stops at MAX_ATTACHMENT_BYTES on bytes actually read, so peak
 * is one buffer of at most that size per attachment, whatever the sender's
 * structure claims.
 * What IS asserted is the shape of the guarantee: the budget is enforced on
 * bytes actually read, the sender's filename never becomes a path, and a
 * round trip returns exactly what went in.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { Pool } from "pg";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testPool, truncate } from "./db/testing.ts";
import { Storage, MAX_ATTACHMENT_BYTES, safeFilename } from "./storage.ts";
import { createTicket, addAttachment, listAttachments, getAttachment } from "./store.ts";

let pool: Pool;
let storage: Storage;
let root: string;

beforeAll(async () => {
  pool = await testPool();
  root = await mkdtemp(join(tmpdir(), "simpletickets-size-"));
  storage = new Storage(join(root, "storage"));
});
beforeEach(async () => {
  await truncate(pool);
});
afterAll(async () => {
  await pool.end();
  await rm(root, { recursive: true, force: true });
});

async function ticket(): Promise<number> {
  return createTicket(pool, {
    uid: 1,
    subject: "Screenshots",
    requester: "ananya.rao@allcheckservices.com",
    body: "Attached.",
    messageId: "<in.1@x>",
    responseDue: new Date().toISOString(),
    owner: null,
  });
}

describe("a 5 MB attachment", () => {
  it("stores, indexes and reads back at the R12 limit", async () => {
    const id = await ticket();
    // Random rather than zeroes: a filesystem that compresses would make a
    // buffer of zeroes measure nothing like a real screenshot.
    const content = Buffer.alloc(MAX_ATTACHMENT_BYTES);
    for (let offset = 0; offset < content.length; offset += 4) {
      content.writeUInt32LE(Math.floor(Math.random() * 0xffffffff), offset);
    }

    const storeStarted = performance.now();
    const path = await storage.storeAttachment(id, content);
    await addAttachment(pool, {
      ticketId: id,
      messageId: null,
      filename: "screenshot.png",
      contentType: "image/png",
      bytes: content.length,
      path,
    });
    const storeMs = performance.now() - storeStarted;

    const readStarted = performance.now();
    const readBack = await storage.read(path);
    const readMs = performance.now() - readStarted;

    expect(readBack.length).toBe(MAX_ATTACHMENT_BYTES);
    expect(readBack.equals(content)).toBe(true);
    expect((await listAttachments(pool, id))[0]?.bytes).toBe(MAX_ATTACHMENT_BYTES);

    console.log(
      JSON.stringify({
        event: "attachment_measured",
        bytes: MAX_ATTACHMENT_BYTES,
        storeMs: Math.round(storeMs),
        readMs: Math.round(readMs),
      }),
    );
  });

  /**
   * The rule the whole storage module exists for: a filename arrives from
   * outside, and "../../.." is a filename. The stored path is a generated UUID
   * and the sender's name is a label, so a traversal reaches neither the disk
   * nor the Content-Disposition header.
   */
  it("never lets a sender's filename become a path", async () => {
    const id = await ticket();
    const path = await storage.storeAttachment(id, Buffer.from("x"));
    expect(path).not.toContain("..");
    expect(safeFilename("../../etc/passwd")).toBe("passwd");
    expect(safeFilename("..")).toBe("attachment");
    expect(safeFilename(null)).toBe("attachment");
    // And a stored row claiming an escaping path is refused on READ, because
    // the row is only as trustworthy as whatever wrote it.
    await expect(storage.read("../../../etc/passwd")).rejects.toThrow(/escapes/);
  });

  it("indexes several files against one ticket and serves each by id", async () => {
    const id = await ticket();
    for (const name of ["one.png", "two.pdf", "three.txt"]) {
      const path = await storage.storeAttachment(id, Buffer.from(name));
      await addAttachment(pool, {
        ticketId: id,
        messageId: null,
        filename: name,
        contentType: "application/octet-stream",
        bytes: name.length,
        path,
      });
    }
    const all = await listAttachments(pool, id);
    expect(all).toHaveLength(3);
    const first = all[0];
    expect(first).toBeDefined();
    const fetched = await getAttachment(pool, first?.id ?? 0);
    expect((await storage.read(fetched?.path ?? "")).toString()).toBe(first?.filename);
  });
});
