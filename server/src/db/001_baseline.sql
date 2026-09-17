-- SimpleTickets baseline schema (PostgreSQL).
--
-- This replaces the four SQLite migrations the Cloudflare D1 build accumulated.
-- Those existed to reshape a database that will never exist here - 001 rebuilt a
-- whole table just to widen a CHECK constraint, which Postgres does with ALTER.
-- `schema.sql` already described the end state, so the end state is the
-- baseline and new migrations go forward from it.
--
-- Timestamps are UTC ISO-8601 TEXT, not timestamptz. Every domain module -
-- deadlines, outbox backoff, session expiry - parses these strings today, and
-- toISOString() is fixed width, so lexicographic comparison is still
-- chronological and every `WHERE next_attempt_at <= $1` keeps working.
-- ponytail: TEXT timestamps, move to timestamptz if reporting ever needs date
-- arithmetic in SQL.

CREATE TABLE IF NOT EXISTS mailbox_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  uid_validity  TEXT    NOT NULL,
  last_uid      INTEGER NOT NULL,
  updated_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject      TEXT NOT NULL,
  requester    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'New',
  priority     TEXT NOT NULL DEFAULT 'Normal',
  owner        TEXT,
  -- When a first response is due (R03: 4 working hours; Sunday arrivals are due
  -- Monday noon). NULL means the ticket predates deadlines, never "overdue".
  response_due TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS tickets_response_due ON tickets (response_due);
CREATE INDEX IF NOT EXISTS tickets_owner ON tickets (owner, status);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id  INTEGER NOT NULL REFERENCES tickets (id),
  direction  TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'note')),
  author     TEXT NOT NULL,
  body       TEXT NOT NULL,
  message_id TEXT,
  created_at TEXT NOT NULL
);

-- Threading and duplicate suppression both key on Message-ID. Partial unique
-- index: Postgres supports this exactly as SQLite did, so notes (which have no
-- Message-ID) do not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS messages_message_id
  ON messages (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_ticket ON messages (ticket_id);

-- Every UID the poller has considered, whether or not it became a ticket.
-- The primary key is what makes ingestion idempotent: a retried or overlapping
-- run inserts nothing the second time, so one email can never open two tickets.
-- Rejections are recorded rather than dropped, so a blocked sender is visible
-- to IT instead of vanishing silently.
CREATE TABLE IF NOT EXISTS ingest_log (
  uid       INTEGER PRIMARY KEY,
  outcome   TEXT NOT NULL CHECK (outcome IN
              ('ticket', 'rejected_sender', 'auto_reply', 'bounce', 'error')),
  ticket_id INTEGER REFERENCES tickets (id),
  detail    TEXT,
  -- Where the raw RFC822 message was archived, relative to STORAGE_DIR.
  -- Written on every ingest so attachment extraction and any future reparse
  -- read from disk instead of going back to IMAP - the mailbox is not a
  -- database and a message can be deleted from it.
  raw_path  TEXT,
  at        TEXT NOT NULL
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
-- applied in the same transaction as the acceptance record, never before.
CREATE TABLE IF NOT EXISTS outbox (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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

-- IT staff and availability (R07, R24).
--
-- `available` and `is_admin` are real BOOLEANs here, not the 0/1 integers
-- SQLite forced. is_admin decides who may provision passwords and change
-- availability; an integer flag in Postgres invites a truthy accident on a
-- column where being wrong grants administrative access.
CREATE TABLE IF NOT EXISTS staff (
  name          TEXT PRIMARY KEY,
  email         TEXT,
  available     BOOLEAN NOT NULL DEFAULT TRUE,
  -- Admin-provisioned (R06); no self-registration. NULL means the account
  -- exists but cannot sign in yet.
  password_hash TEXT,
  is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TEXT NOT NULL
);

-- Session tokens are stored hashed: reading this table must not yield anything
-- usable to log in with.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  staff_name TEXT NOT NULL REFERENCES staff (name),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_staff ON sessions (staff_name);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at);

-- Failed sign-ins, for throttling. Per account, not per IP: an attacker can
-- rotate source addresses freely but cannot avoid naming the account being
-- guessed.
CREATE TABLE IF NOT EXISTS login_failures (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  staff_name TEXT NOT NULL,
  at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS login_failures_lookup ON login_failures (staff_name, at);

-- Attachments (R12). The bytes live on disk under STORAGE_DIR; this table is
-- the index. Keeping them out of the database keeps backups of the ticket data
-- small enough to be taken often, and a 5 MB blob in a row is a slow query
-- waiting to happen.
CREATE TABLE IF NOT EXISTS attachments (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id    INTEGER NOT NULL REFERENCES tickets (id),
  message_id   INTEGER REFERENCES messages (id),
  filename     TEXT    NOT NULL,
  content_type TEXT    NOT NULL,
  bytes        INTEGER NOT NULL,
  -- Path relative to STORAGE_DIR. Relative so the storage root can move
  -- without rewriting every row.
  path         TEXT    NOT NULL,
  created_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS attachments_ticket ON attachments (ticket_id);
