import { defineConfig } from "vitest/config";

/**
 * Unit tests: pure logic, no database, no network. Fast enough to run on every
 * save. The database suites are excluded here and run under
 * vitest.db.config.ts, so a missing Postgres fails the right thing.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.db.test.ts"],
    environment: "node",
  },
});
