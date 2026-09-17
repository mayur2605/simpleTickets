import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, utimes, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  msUntilNextBackup,
  backupName,
  filesName,
  pruneBackups,
  RETENTION_DAYS,
} from "./backup.ts";
import { config, type Config } from "./config.ts";

const dir = await mkdtemp(join(tmpdir(), "simpletickets-backup-"));
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("backup schedule", () => {
  /**
   * The PRD says 02:00 Asia/Kolkata. IST is UTC+5:30 with no daylight saving,
   * so 02:00 IST is 20:30 UTC the previous day — which is exactly the sort of
   * arithmetic that is wrong by five and a half hours in production and
   * nowhere else.
   */
  it("fires at 02:00 IST, which is 20:30 UTC", () => {
    const ms = msUntilNextBackup(new Date("2026-09-17T20:00:00.000Z"));
    expect(ms).toBe(30 * 60_000);
  });

  it("waits for tomorrow when today's time has passed", () => {
    const ms = msUntilNextBackup(new Date("2026-09-17T21:00:00.000Z"));
    expect(ms).toBe((24 * 60 - 30) * 60_000);
  });

  it("never returns a negative or zero delay", () => {
    for (const hour of [0, 6, 12, 20, 23]) {
      const at = new Date(`2026-09-17T${String(hour).padStart(2, "0")}:30:00.000Z`);
      expect(msUntilNextBackup(at)).toBeGreaterThan(0);
      expect(msUntilNextBackup(at)).toBeLessThanOrEqual(24 * 60 * 60_000);
    }
  });

  // Named for the Indian calendar day, not the UTC one: a backup taken at
  // 02:00 IST on the 18th is the 18th's backup, though UTC still says the 17th.
  it("names the file for the IST date", () => {
    expect(backupName(new Date("2026-09-17T20:30:00.000Z"))).toBe("simpletickets-2026-09-18.dump");
  });
});

describe("retention", () => {
  it("keeps thirty days", () => {
    expect(RETENTION_DAYS).toBe(30);
  });

  it("deletes dumps past the window and keeps the rest", async () => {
    const now = new Date("2026-09-17T00:00:00.000Z");
    const old = join(dir, "simpletickets-2026-08-01.dump");
    const recent = join(dir, "simpletickets-2026-09-16.dump");
    const other = join(dir, "notes.txt");
    await writeFile(old, "x");
    await writeFile(recent, "x");
    await writeFile(other, "x");
    const ancient = new Date("2026-08-01T00:00:00.000Z");
    await utimes(old, ancient, ancient);
    await utimes(
      recent,
      new Date("2026-09-16T00:00:00.000Z"),
      new Date("2026-09-16T00:00:00.000Z"),
    );

    const removed = await pruneBackups({ ...config, backupDir: dir }, now);
    expect(removed).toEqual(["simpletickets-2026-08-01.dump"]);

    const left = await readdir(dir);
    expect(left).toContain("simpletickets-2026-09-16.dump");
    // Only .dump files are ever deleted: this directory is not ours alone.
    expect(left).toContain("notes.txt");
  });

  it("does nothing when the backup directory does not exist yet", async () => {
    expect(await pruneBackups({ ...config, backupDir: join(dir, "missing") })).toEqual([]);
  });
});

/**
 * R23: "safe pruning that preserves dependencies and the last usable backup."
 *
 * Both halves of that sentence are a specific way a retention sweep destroys
 * the thing it is looking after, and neither is theoretical: one loses every
 * backup on a machine that was switched off, the other leaves a database dump
 * whose attachment rows all point at files that no longer exist.
 */
describe("pruneBackups dependencies", () => {
  const old = new Date(Date.now() - (RETENTION_DAYS + 5) * 24 * 60 * 60_000);

  async function seed(root: string, files: { name: string; age: Date }[]): Promise<Config> {
    for (const file of files) {
      const path = join(root, file.name);
      await writeFile(path, "x");
      await utimes(path, file.age, file.age);
    }
    return { ...config, backupDir: root, storageDir: join(root, "storage") };
  }

  it("keeps the newest dump even when it is past retention", async () => {
    const root = await mkdtemp(join(tmpdir(), "simpletickets-prune-last-"));
    const only = await seed(root, [{ name: "simpletickets-2026-01-01.dump", age: old }]);
    expect(await pruneBackups(only)).toEqual([]);
    expect(await readdir(root)).toContain("simpletickets-2026-01-01.dump");
    await rm(root, { recursive: true, force: true });
  });

  /**
   * A database dump and its file archive are one recovery point. Pruning the
   * attachments out from under a dump that is being kept produces a backup
   * that restores cleanly and is missing every file.
   */
  it("never orphans a kept dump from its attachments", async () => {
    const root = await mkdtemp(join(tmpdir(), "simpletickets-prune-pair-"));
    const now = new Date();
    const paired = await seed(root, [
      { name: "simpletickets-2026-01-01.dump", age: old },
      { name: "simpletickets-2026-01-01-files.tgz", age: old },
      { name: "simpletickets-2026-09-17.dump", age: now },
      { name: "simpletickets-2026-09-17-files.tgz", age: now },
    ]);
    const removed = await pruneBackups(paired);
    // The old pair goes together; the current pair stays together.
    expect(removed.sort()).toEqual([
      "simpletickets-2026-01-01-files.tgz",
      "simpletickets-2026-01-01.dump",
    ]);
    const left = await readdir(root);
    expect(left).toContain("simpletickets-2026-09-17.dump");
    expect(left).toContain("simpletickets-2026-09-17-files.tgz");
    await rm(root, { recursive: true, force: true });
  });

  it("names both halves of a recovery point for the same IST day", () => {
    const at = new Date("2026-09-17T20:30:00.000Z");
    expect(backupName(at)).toBe("simpletickets-2026-09-18.dump");
    expect(filesName(at)).toBe("simpletickets-2026-09-18-files.tgz");
  });
});
