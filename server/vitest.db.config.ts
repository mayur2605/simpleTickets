import { defineConfig } from "vitest/config";

/**
 * Integration tests against a real PostgreSQL database.
 *
 * `store.ts` had no tests at all under D1 — it could only be exercised against
 * Cloudflare's hosted database, so the compare-and-swap, the batches and the
 * R28 ordering were verified by reading them. They run here instead.
 *
 * Single-threaded and single-file: these suites share one scratch database and
 * truncate between tests, so running them in parallel would have them deleting
 * each other's rows.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.db.test.ts"],
    environment: "node",
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
  },
});
