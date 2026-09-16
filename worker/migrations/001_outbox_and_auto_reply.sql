-- Migration 001: add the outbox, and allow 'auto_reply' as an ingest outcome.
--
-- Run once against each database:
--   wrangler d1 execute simpletickets --remote --file migrations/001_outbox_and_auto_reply.sql
--
-- WHY THE REBUILD: SQLite cannot alter a CHECK constraint in place, and
-- ingest_log's CHECK did not allow 'auto_reply'. The only way to widen it is to
-- rebuild the table. That is why this should run BEFORE real mail arrives -
-- it is trivial while the table is small and increasingly unpleasant later.
--
-- SAFETY: the rebuild copies every existing row before dropping anything, and
-- the new CHECK is strictly wider than the old one, so no existing row can fail
-- it. D1 runs the statements in a file as a single transaction, so a failure
-- part-way leaves the original table untouched.

-- 1. The outbox (T013, R28). See schema.sql for the full commentary.
CREATE TABLE IF NOT EXISTS outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id       INTEGER NOT NULL REFERENCES tickets (id),
  intent          TEXT    NOT NULL CHECK (intent IN
                    ('acknowledgement', 'reply', 'resolution', 'closure', 'notification')),
  recipient       TEXT    NOT NULL,
  message_id      TEXT    NOT NULL,
  payload         TEXT    NOT NULL,
  state           TEXT    NOT NULL DEFAULT 'pending' CHECK (state IN
                    ('pending', 'sending', 'accepted', 'failed', 'ambiguous', 'bounced')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT    NOT NULL,
  sending_since   TEXT,
  accepted_at     TEXT,
  smtp_reply      TEXT,
  last_error      TEXT,
  pending_status  TEXT,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS outbox_message_id ON outbox (message_id);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox (state, next_attempt_at);

-- 2. Widen ingest_log.outcome to include 'auto_reply'.
CREATE TABLE ingest_log_rebuilt (
  uid        INTEGER PRIMARY KEY,
  outcome    TEXT NOT NULL CHECK (outcome IN
               ('ticket', 'rejected_sender', 'auto_reply', 'bounce', 'error')),
  ticket_id  INTEGER REFERENCES tickets (id),
  detail     TEXT,
  at         TEXT NOT NULL
);

INSERT INTO ingest_log_rebuilt (uid, outcome, ticket_id, detail, at)
  SELECT uid, outcome, ticket_id, detail, at FROM ingest_log;

DROP TABLE ingest_log;

ALTER TABLE ingest_log_rebuilt RENAME TO ingest_log;
