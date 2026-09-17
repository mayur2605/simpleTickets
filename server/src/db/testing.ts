/**
 * Scratch database for the integration suites.
 *
 * Points at TEST_DATABASE_URL (default: the local `simpletickets_test`),
 * migrates it once, and truncates between tests. Never the development
 * database: the name is checked, because a truncate aimed at the wrong URL
 * deletes real tickets.
 */
import type { Pool } from "pg";
import { createPool } from "./pool.ts";
import { migrate } from "./migrate.ts";

export const TEST_DATABASE_URL =
  process.env["TEST_DATABASE_URL"] ?? "postgresql://localhost:5432/simpletickets_test";

if (!/_test(\?|$)/.test(TEST_DATABASE_URL)) {
  throw new Error(
    `Refusing to run destructive tests against ${TEST_DATABASE_URL}: the database name must end in _test.`,
  );
}

let migrated = false;

export async function testPool(): Promise<Pool> {
  if (!migrated) {
    await migrate(TEST_DATABASE_URL);
    migrated = true;
  }
  return createPool(TEST_DATABASE_URL);
}

/** Empty every table, restarting identity so ticket ids are predictable. */
export async function truncate(pool: Pool): Promise<void> {
  await pool.query(
    `TRUNCATE tickets, messages, ingest_log, outbox, staff, sessions,
              login_failures, mailbox_state, attachments,
              audit_events, ticket_participants, reply_templates
     RESTART IDENTITY CASCADE`,
  );
}
