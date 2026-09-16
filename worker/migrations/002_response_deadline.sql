-- Migration 002: give tickets a response deadline (R03, R04).
--
--   wrangler d1 execute simpletickets --remote --file migrations/002_response_deadline.sql
--
-- ALTER TABLE ADD COLUMN is safe here: SQLite appends the column and fills
-- existing rows with NULL, without rewriting the table. A NULL deadline means
-- "opened before deadlines existed" and is deliberately NOT treated as overdue -
-- inventing a deadline for an old ticket would show it as breached the moment
-- this ran.
ALTER TABLE tickets ADD COLUMN response_due TEXT;

-- Overdue lookups scan on this.
CREATE INDEX IF NOT EXISTS tickets_response_due ON tickets (response_due);
