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
  -- When a first response is due (R03: 4 working hours; Sunday arrivals are due
  -- Monday noon). NULL means the ticket predates deadlines, never "overdue".
  response_due TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS tickets_response_due ON tickets (response_due);

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
  outcome    TEXT NOT NULL CHECK (outcome IN
               ('ticket', 'rejected_sender', 'auto_reply', 'bounce', 'error')),
  ticket_id  INTEGER REFERENCES tickets (id),
  detail     TEXT,
  at         TEXT NOT NULL
);

-- Durable outgoing mail intents (T013, R28).
--
-- message_id is UNIQUE and is the idempotency key: enqueueing the same intent
-- twice inserts once, so an overlapping or retried run cannot make an employee
-- receive the same automatic message twice. Same guarantee ingest_log.uid gives
-- on the way in.
--
-- pending_status carries R28: a status change that requires an email takes
-- effect only when the mail server accepts that message, and the transition is
-- applied in the same batch as the acceptance record, never before.
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

-- IT staff and availability (R07, R24). Seeded with nobody on purpose: see
-- migrations/003_staff.sql.
CREATE TABLE IF NOT EXISTS staff (
  name       TEXT PRIMARY KEY,
  email      TEXT,
  available  INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS tickets_owner ON tickets (owner, status);
