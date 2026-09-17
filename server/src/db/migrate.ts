/**
 * Migration runner. Applies every .sql file in this directory in name order,
 * once, recording what it applied.
 *
 * Each file runs inside a transaction, so a migration that fails half way
 * leaves nothing behind and can be fixed and re-run.
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createPool } from "./pool.ts";
import { config } from "../config.ts";

const here = dirname(fileURLToPath(import.meta.url));

export async function migrate(connectionString: string, reset = false): Promise<string[]> {
  const pool = createPool(connectionString);
  const applied: string[] = [];
  try {
    if (reset) {
      // Only ever reached through `npm run db:reset`, which refuses to run
      // against anything but a local database - see the guard in main().
      await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    }
    await pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name       TEXT PRIMARY KEY,
         applied_at TEXT NOT NULL
       )`,
    );
    const files = (await readdir(here)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const done = await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
      if (done.rowCount !== 0) continue;
      const sql = await readFile(join(here, file), "utf8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)", [
          file,
          new Date().toISOString(),
        ]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new Error(`Migration ${file} failed.`, { cause: error });
      } finally {
        client.release();
      }
    }
    return applied;
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const reset = process.argv.includes("--reset");
  // A reset drops every table. Refusing anything but a local host is the
  // difference between resetting a scratch database and destroying live
  // tickets because DATABASE_URL was pointing somewhere else.
  if (reset && !/@(localhost|127\.0\.0\.1|\/)/.test(config.databaseUrl)) {
    throw new Error(`Refusing --reset against a non-local database: ${config.databaseUrl}`);
  }
  const applied = await migrate(config.databaseUrl, reset);
  console.log(applied.length === 0 ? "migrations: up to date" : `applied: ${applied.join(", ")}`);
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.filename === resolve(invoked)) {
  await main();
}
