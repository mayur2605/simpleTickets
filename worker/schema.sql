-- SimpleTickets schema. Timestamps are UTC ISO-8601 strings; business time is
-- evaluated in Asia/Kolkata by the calendar module, never stored that way.

-- Mailbox ingestion checkpoint. Exactly one row, enforced by the CHECK.
CREATE TABLE IF NOT EXISTS mailbox_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  uid_validity  TEXT    NOT NULL,
  last_uid      INTEGER NOT NULL,
  updated_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  subject     TEXT NOT NULL,
  requester   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'New',
  priority    TEXT NOT NULL DEFAULT 'Normal',
  owner       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id   INTEGER NOT NULL REFERENCES tickets(id),
  direction   TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'note')),
  author      TEXT NOT NULL,
  body        TEXT NOT NULL,
  message_id  TEXT,
  created_at  TEXT NOT NULL
);

-- Threading and duplicate suppression both key on Message-ID.
CREATE UNIQUE INDEX IF NOT EXISTS messages_message_id
  ON messages (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_ticket ON messages (ticket_id);

-- Every UID the poller has considered, whether or not it became a ticket.
-- The primary key is what makes ingestion idempotent: a retried or overlapping
-- run inserts nothing the second time, so one email can never open two tickets.
-- Rejections are recorded rather than dropped, so a blocked sender is visible
-- to IT instead of vanishing silently.
CREATE TABLE IF NOT EXISTS ingest_log (
  uid        INTEGER PRIMARY KEY,
  outcome    TEXT NOT NULL CHECK (outcome IN ('ticket', 'rejected_sender', 'error')),
  ticket_id  INTEGER REFERENCES tickets (id),
  detail     TEXT,
  at         TEXT NOT NULL
);
