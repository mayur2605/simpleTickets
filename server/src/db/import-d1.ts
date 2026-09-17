/**
 * One-time cutover from the Cloudflare D1 database.
 *
 * Exists mainly for the ingestion checkpoint. The tickets themselves could be
 * rebuilt by simply pointing this server at the mailbox — ingestion is
 * idempotent and the mail is still there — but the checkpoint cannot: a fresh
 * database adopts the mailbox's *current* uidNext and imports nothing before it
 * (R27's launch cutoff), so anything the deployed system already turned into a
 * ticket would be skipped here and never appear.
 *
 * Export the tables first, one file per table:
 *
 *   cd worker
 *   for t in tickets messages ingest_log outbox mailbox_state; do
 *     npx wrangler d1 execute simpletickets --remote --command "SELECT * FROM $t;" --json \
 *       | python3 -c "import sys,json;print(json.dumps(json.load(sys.stdin)[0]['results']))" \
 *       > ../server/var/d1/$t.json
 *   done
 *
 *   npm run db:import -- var/d1
 *
 * Idempotent: every insert is ON CONFLICT DO NOTHING, so a re-run after a
 * partial import finishes the job rather than failing on what is already there.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Pool } from "pg";
import { createPool } from "./pool.ts";
import { config } from "../config.ts";

type Row = Record<string, unknown>;

async function load(dir: string, table: string): Promise<Row[]> {
  const raw: unknown = JSON.parse(await readFile(join(dir, `${table}.json`), "utf8"));
  if (!Array.isArray(raw)) throw new Error(`${table}.json is not an array`);
  return raw as Row[];
}

/**
 * Insert rows by their own column names.
 *
 * Built from the exported keys rather than a hard-coded column list, so a
 * column added to the schema after this was written does not get silently
 * dropped on the way across.
 */
async function insert(pool: Pool, table: string, rows: Row[], conflict: string): Promise<number> {
  let written = 0;
  for (const row of rows) {
    const columns = Object.keys(row);
    if (columns.length === 0) continue;
    const placeholders = columns.map((_, index) => `$${String(index + 1)}`);
    // OVERRIDING SYSTEM VALUE because the id columns are GENERATED ALWAYS,
    // which refuses an explicit id. That strictness is wanted everywhere else -
    // it stops application code writing its own ids - and this import is the
    // one place that legitimately needs to keep the ids it was given, because
    // the exported messages and log entries reference them.
    const result = await pool.query(
      `INSERT INTO ${table} (${columns.join(", ")})
       OVERRIDING SYSTEM VALUE VALUES (${placeholders.join(", ")})
       ON CONFLICT (${conflict}) DO NOTHING`,
      columns.map((column) => row[column]),
    );
    written += result.rowCount ?? 0;
  }
  return written;
}

export async function importFromD1(
  connectionString: string,
  dir: string,
): Promise<Record<string, number>> {
  const pool = createPool(connectionString);
  try {
    const counts: Record<string, number> = {};
    // Order matters: messages and ingest_log reference tickets.
    counts["tickets"] = await insert(pool, "tickets", await load(dir, "tickets"), "id");
    counts["messages"] = await insert(pool, "messages", await load(dir, "messages"), "id");
    counts["outbox"] = await insert(pool, "outbox", await load(dir, "outbox"), "id");
    counts["ingest_log"] = await insert(pool, "ingest_log", await load(dir, "ingest_log"), "uid");
    counts["mailbox_state"] = await insert(
      pool,
      "mailbox_state",
      await load(dir, "mailbox_state"),
      "id",
    );

    // Identity sequences do not know about ids that arrived with explicit
    // values. Without this the next locally-created ticket collides with an
    // imported one and the insert fails.
    for (const table of ["tickets", "messages", "outbox"]) {
      await pool.query(
        `SELECT setval(pg_get_serial_sequence('${table}', 'id'),
                       GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${table}), 1))`,
      );
    }
    return counts;
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (dir === undefined) throw new Error("Usage: npm run db:import -- <directory of D1 JSON>");
  const counts = await importFromD1(config.databaseUrl, resolve(dir));
  console.log(
    Object.entries(counts)
      .map(([table, n]) => `${table}: ${String(n)}`)
      .join(", "),
  );
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.filename === resolve(invoked)) {
  await main();
}
