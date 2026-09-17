/**
 * The PostgreSQL connection, and the two shapes the rest of the code talks to.
 *
 * `Db` is deliberately the smallest interface store.ts needs — one `query`
 * method. Both a Pool and a pooled client satisfy it, which is what lets every
 * store function be called either standalone or inside a transaction without
 * two versions of itself.
 */
import pg from "pg";
import type { QueryResult, QueryResultRow } from "pg";

export interface Db {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString });
}

/**
 * Run `fn` inside a real transaction.
 *
 * This is what replaced D1's `batch()`. A batch was atomic but not isolated;
 * this is both, which strengthens R28 rather than merely preserving it: the
 * status change and the delivery-acceptance record are invisible to any other
 * reader until they commit together.
 */
export async function withTransaction<T>(pool: pg.Pool, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    // Rollback failure must not mask the original error - that is the one
    // that says what actually went wrong.
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
