/**
 * Daily backups (PRD: 02:00 Asia/Kolkata, 30-day retention).
 *
 * This requirement was previously unmeetable. D1's free tier gives seven days
 * of Time Travel against an agreed thirty-day window, and there was no way to
 * take a real export on a schedule. `pg_dump` is that export, and the retention
 * window is now whatever the disk will hold.
 *
 * A backup that has never been restored is a hope, not a backup — so the
 * restore path is a function here, exercised by the test suite against a
 * scratch database, rather than a paragraph in a runbook.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";

const run = promisify(execFile);

/**
 * Locate a PostgreSQL client binary.
 *
 * PG_BIN wins when set. Otherwise the common Homebrew keg-only locations are
 * tried before falling back to PATH, because that fallback is what silently
 * turns the nightly backup into a no-op on a stock macOS install.
 */
function tool(pgBin: string, name: string): string {
  if (pgBin !== "") return join(pgBin, name);
  for (const dir of ["/opt/homebrew/opt/postgresql@18/bin", "/usr/local/opt/postgresql@18/bin"]) {
    if (existsSync(join(dir, name))) return join(dir, name);
  }
  return name;
}

/** PRD: thirty days. */
export const RETENTION_DAYS = 30;

/**
 * 02:00 Asia/Kolkata expressed in UTC.
 *
 * India does not observe daylight saving, so this offset is a constant rather
 * than something to recompute — which is exactly why it is written down here
 * instead of being assumed at the call site.
 */
const IST_OFFSET_MINUTES = 5 * 60 + 30;
const BACKUP_HOUR_IST = 2;

/** Milliseconds from `now` until the next 02:00 IST. */
export function msUntilNextBackup(now: Date): number {
  const istNow = new Date(now.getTime() + IST_OFFSET_MINUTES * 60_000);
  const istTarget = new Date(istNow);
  istTarget.setUTCHours(BACKUP_HOUR_IST, 0, 0, 0);
  if (istTarget <= istNow) istTarget.setUTCDate(istTarget.getUTCDate() + 1);
  return istTarget.getTime() - istNow.getTime();
}

export function backupName(now: Date): string {
  const ist = new Date(now.getTime() + IST_OFFSET_MINUTES * 60_000);
  return `simpletickets-${ist.toISOString().slice(0, 10)}.dump`;
}

/**
 * Take one backup. Custom format (`-Fc`), which is compressed and lets
 * `pg_restore` select individual tables — a plain SQL dump can only be replayed
 * whole, which is the wrong tool when one table needs recovering.
 */
export async function runBackup(config: Config, now: Date = new Date()): Promise<string> {
  await mkdir(config.backupDir, { recursive: true });
  const path = join(config.backupDir, backupName(now));
  await run(tool(config.pgBin, "pg_dump"), [
    "--format=custom",
    "--no-owner",
    "--file",
    path,
    config.databaseUrl,
  ]);
  return path;
}

/** Delete backups older than the retention window. Returns what it removed. */
export async function pruneBackups(
  config: Config,
  now: Date = new Date(),
  retentionDays = RETENTION_DAYS,
): Promise<string[]> {
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60_000;
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(config.backupDir);
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".dump")) continue;
    const full = join(config.backupDir, entry);
    const info = await stat(full);
    if (info.mtimeMs < cutoff) {
      await unlink(full);
      removed.push(entry);
    }
  }
  return removed;
}

/**
 * Restore a dump into a database. Used by the backup test, which is the only
 * way to know a backup is restorable rather than merely present.
 *
 * `--clean` drops what it replaces, so this is destructive by design and must
 * only ever be pointed at a database intended to be overwritten.
 */
export async function restoreBackup(
  dumpPath: string,
  connectionString: string,
  pgBin = "",
): Promise<void> {
  await run(tool(pgBin, "pg_restore"), [
    "--clean",
    "--if-exists",
    "--no-owner",
    "--dbname",
    connectionString,
    dumpPath,
  ]);
}

/**
 * Schedule daily backups.
 *
 * Failures are logged, never thrown: a backup that cannot run must not stop the
 * server that is serving tickets. The next day's attempt is scheduled either
 * way, so one bad night does not end the schedule.
 */
export function startBackups(config: Config): void {
  const schedule = (): void => {
    const timer = setTimeout(() => {
      void (async (): Promise<void> => {
        try {
          const path = await runBackup(config);
          const pruned = await pruneBackups(config);
          console.log(JSON.stringify({ event: "backup", path, pruned: pruned.length }));
        } catch (error) {
          console.error(JSON.stringify({ event: "backup_failed", error: String(error) }));
        }
        schedule();
      })();
    }, msUntilNextBackup(new Date()));
    timer.unref();
  };
  schedule();
}
