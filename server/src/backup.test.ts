import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, utimes, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { msUntilNextBackup, backupName, pruneBackups, RETENTION_DAYS } from "./backup.ts";
import { config } from "./config.ts";

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
