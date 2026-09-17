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
import { mkdir, readdir, stat, unlink, statfs } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config, type Config } from "./config.ts";

const run = promisify(execFile);

/**
 * Locate a PostgreSQL client binary.
 *
 * PG_BIN wins when set. Otherwise the known per-version install locations are
 * tried before falling back to PATH, and the fallback is the dangerous one on
 * both platforms this has run on:
 *
 *   Homebrew installs PostgreSQL keg-only, so nothing is on PATH at all and the
 *   nightly backup fails with "command not found" - which nobody notices until
 *   they need the backup.
 *
 *   Debian and Ubuntu are worse, because they fail later. `apt install
 *   postgresql-client-18` installs into /usr/lib/postgresql/18/bin but leaves
 *   /usr/bin/pg_dump pointing at the distro's older version, so the install
 *   step reports success and pg_dump then refuses the newer server with
 *   "aborting because of server version mismatch". CI hit exactly this.
 */
const CLIENT_DIRS = [
  "/opt/homebrew/opt/postgresql@18/bin",
  "/usr/local/opt/postgresql@18/bin",
  "/usr/lib/postgresql/18/bin",
];

function tool(pgBin: string, name: string): string {
  if (pgBin !== "") return join(pgBin, name);
  for (const dir of CLIENT_DIRS) {
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

/** The IST calendar day a backup belongs to. Both halves share it. */
export function backupDay(now: Date): string {
  return new Date(now.getTime() + IST_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
}

export function backupName(now: Date): string {
  return `simpletickets-${backupDay(now)}.dump`;
}

/**
 * The attachment archive for the same day.
 *
 * Attachments live on disk, not in the database, so a `pg_dump` alone restores
 * an `attachments` table whose every row points at a file that is not there -
 * a backup that looks complete and is not. The two are taken together and
 * pruned together for that reason.
 */
export function filesName(now: Date): string {
  return `simpletickets-${backupDay(now)}-files.tgz`;
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

/**
 * Archive the attachment and raw-message bytes (R23).
 *
 * `tar` rather than a library: it ships with macOS and every Linux this will
 * run on, it streams, and adding a dependency to copy a directory is the kind
 * of thing that needs justifying rather than assuming.
 *
 * Returns null when there is nothing to archive — a fresh install has no
 * storage directory, and an empty tarball every night is noise that makes a
 * real failure harder to see.
 */
export async function runFileBackup(
  config: Config,
  now: Date = new Date(),
): Promise<string | null> {
  if (!existsSync(config.storageDir)) return null;
  await mkdir(config.backupDir, { recursive: true });
  const path = join(config.backupDir, filesName(now));
  // -C so the archive holds relative paths: an archive of absolute paths
  // restores to wherever the machine that made it kept its files, which is
  // rarely where the machine restoring it wants them.
  await run("tar", ["-czf", path, "-C", config.storageDir, "."]);
  return path;
}

/** Unpack an attachment archive. Destructive in the same way restoreBackup is. */
export async function restoreFiles(archivePath: string, storageDir: string): Promise<void> {
  await mkdir(storageDir, { recursive: true });
  await run("tar", ["-xzf", archivePath, "-C", storageDir]);
}

/**
 * How much room is left where the data lives (R23).
 *
 * Reported rather than acted on: this system cannot decide what to delete, and
 * a backup that quietly stops because the disk filled is the failure this
 * exists to make visible before it happens.
 */
export interface StorageUsage {
  path: string;
  bytesUsed: number;
  files: number;
  freeBytes: number;
  totalBytes: number;
}

async function directorySize(path: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return { bytes, files };
  }
  for (const entry of entries) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) {
      const nested = await directorySize(full);
      bytes += nested.bytes;
      files += nested.files;
    } else if (entry.isFile()) {
      bytes += (await stat(full)).size;
      files += 1;
    }
  }
  return { bytes, files };
}

export async function storageUsage(path: string): Promise<StorageUsage> {
  const { bytes, files } = await directorySize(path);
  let freeBytes = 0;
  let totalBytes = 0;
  try {
    const fs = await statfs(existsSync(path) ? path : ".");
    freeBytes = fs.bavail * fs.bsize;
    totalBytes = fs.blocks * fs.bsize;
  } catch {
    // A platform without statfs reports zeroes rather than failing /status.
  }
  return { path, bytesUsed: bytes, files, freeBytes, totalBytes };
}

/**
 * Delete backups older than the retention window. Returns what it removed.
 *
 * Two things it deliberately will not do (R23: "safe pruning that preserves
 * dependencies and the last usable backup"):
 *
 *   It never deletes the newest database dump, however old. A server that has
 *   been off for two months would otherwise wake up, find everything past
 *   retention, and delete the only copy it has.
 *
 *   It never deletes a file archive whose database dump it is keeping. The two
 *   are one recovery point: pruning the attachments out from under a dump
 *   leaves rows pointing at files that no longer exist anywhere.
 */
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

  const dumps = entries.filter((entry) => entry.endsWith(".dump")).sort();
  const newest = dumps[dumps.length - 1];
  const keptDays = new Set<string>();

  for (const entry of dumps) {
    const full = join(config.backupDir, entry);
    const info = await stat(full);
    if (entry === newest || info.mtimeMs >= cutoff) {
      keptDays.add(entry.slice(0, -".dump".length));
      continue;
    }
    await unlink(full);
    removed.push(entry);
  }

  for (const entry of entries) {
    if (!entry.endsWith("-files.tgz")) continue;
    // "simpletickets-2026-09-17-files.tgz" belongs to "simpletickets-2026-09-17".
    if (keptDays.has(entry.slice(0, -"-files.tgz".length))) continue;
    await unlink(join(config.backupDir, entry));
    removed.push(entry);
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
  pgBin = config.pgBin,
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
 * The result of the most recent attempt (R23).
 *
 * Held here and reported by /health and /status, because a backup that started
 * failing silently looks exactly like one that is working. A log line is not an
 * alert: nobody reads yesterday's logs to find out whether last night worked.
 */
export interface BackupState {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastPath: string | null;
  lastFilesPath: string | null;
  lastError: string | null;
  /** True once an attempt has failed and no later one has succeeded. */
  failing: boolean;
}

const state: BackupState = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastPath: null,
  lastFilesPath: null,
  lastError: null,
  failing: false,
};

export function backupState(): BackupState {
  return { ...state };
}

/** Take both halves of a recovery point and prune. Records what happened. */
export async function backupNow(
  config: Config,
  onFailure?: (error: string) => Promise<void> | void,
): Promise<BackupState> {
  state.lastAttemptAt = new Date().toISOString();
  try {
    const path = await runBackup(config);
    const filesPath = await runFileBackup(config);
    const pruned = await pruneBackups(config);
    state.lastPath = path;
    state.lastFilesPath = filesPath;
    state.lastSuccessAt = state.lastAttemptAt;
    state.lastError = null;
    state.failing = false;
    console.log(JSON.stringify({ event: "backup", path, files: filesPath, pruned: pruned.length }));
  } catch (error) {
    state.lastError = String(error);
    state.failing = true;
    console.error(JSON.stringify({ event: "backup_failed", error: state.lastError }));
    // Never rethrown: a backup that cannot run must not stop the server that is
    // serving tickets. The caller decides how to raise it.
    try {
      await onFailure?.(state.lastError);
    } catch (alertError) {
      console.error(JSON.stringify({ event: "backup_alert_failed", error: String(alertError) }));
    }
  }
  return backupState();
}

/**
 * Schedule daily backups.
 *
 * The next day's attempt is scheduled whether or not this one worked, so one
 * bad night does not end the schedule.
 */
export function startBackups(
  config: Config,
  onFailure?: (error: string) => Promise<void> | void,
): void {
  const schedule = (): void => {
    const timer = setTimeout(() => {
      void (async (): Promise<void> => {
        await backupNow(config, onFailure);
        schedule();
      })();
    }, msUntilNextBackup(new Date()));
    timer.unref();
  };
  schedule();
}
