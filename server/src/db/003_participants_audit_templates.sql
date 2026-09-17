-- Migration 003: the four modelling gaps T007 left open.
--
-- Audit events, account access, CC participants and reply templates. They
-- arrive together because three of the four are the same requirement seen from
-- different sides: disabling an account has to redistribute work AND be
-- recorded, adding a participant has to be recorded, and a template that moves
-- a ticket has to be recorded like any other transition.

-- Who did what, when (R08, R24, R25).
--
-- The message history was the only record, which meant assignment changes,
-- availability changes and participant edits left no trace at all - the actions
-- most likely to be asked about after the fact.
--
-- ticket_id is nullable because account-level events belong to nobody's ticket.
-- actor is a staff name, or 'system' for something no person pressed; it is NOT
-- a foreign key, because the audit record must survive the account it names.
CREATE TABLE IF NOT EXISTS audit_events (
  id        INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id INTEGER REFERENCES tickets (id),
  actor     TEXT NOT NULL,
  action    TEXT NOT NULL,
  detail    TEXT,
  at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_events_ticket ON audit_events (ticket_id, id);
CREATE INDEX IF NOT EXISTS audit_events_at ON audit_events (at);

-- Account access, which is NOT availability (R24).
--
-- `available` says "not taking new work this week" and revokes nothing.
-- `enabled` says "this person no longer works here": sign-in is refused, live
-- sessions are deleted and their open tickets are redistributed. Conflating the
-- two is how someone on leave loses their login, or how a leaver keeps one.
ALTER TABLE staff ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- CC participants (R25).
--
-- Rows are never deleted on absence. R25 is explicit that omitting an existing
-- participant from a later email does not remove them, so removal is a
-- deliberate act with a timestamp - which also keeps the record of who could
-- see the conversation while they could see it.
--
-- address is stored lower-cased; the primary key is what makes "add the same
-- person twice" a no-op rather than a duplicate recipient.
CREATE TABLE IF NOT EXISTS ticket_participants (
  ticket_id  INTEGER NOT NULL REFERENCES tickets (id),
  address    TEXT    NOT NULL,
  -- 'requester', a staff name, or 'system'. Only the first two are legitimate
  -- ways in (R25): other CC participants cannot add participants by email.
  added_by   TEXT    NOT NULL,
  added_at   TEXT    NOT NULL,
  removed_at TEXT,
  PRIMARY KEY (ticket_id, address)
);

CREATE INDEX IF NOT EXISTS ticket_participants_active
  ON ticket_participants (ticket_id) WHERE removed_at IS NULL;

-- Reply templates (R24).
--
-- maps_to is the status sending this template requests, or NULL for no change,
-- which is the default for anything the admin creates. Closure is deliberately
-- absent: R24 says closure is not a template action, and a CHECK is a better
-- guarantee of that than a comment.
CREATE TABLE IF NOT EXISTS reply_templates (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  body       TEXT NOT NULL,
  maps_to    TEXT CHECK (maps_to IN ('In Progress', 'Waiting for Employee', 'Resolved')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Two more things ingestion can decide about a message.
--
-- 'not_a_participant': someone on the approved domain replied into a ticket
-- they are not part of. Approved-domain is authorisation to open a ticket, not
-- authorisation to join somebody else's - and the reply is recorded rather than
-- dropped so IT can add them if it was legitimate.
--
-- 'oversized': the email carried more than the R12 budget. The ticket is still
-- created; this outcome is for the log line that says why a file is missing.
ALTER TABLE ingest_log DROP CONSTRAINT IF EXISTS ingest_log_outcome_check;
ALTER TABLE ingest_log ADD CONSTRAINT ingest_log_outcome_check
  CHECK (outcome IN ('ticket', 'rejected_sender', 'auto_reply', 'bounce', 'error',
                     'notification_reply', 'not_a_participant'));

-- Attachments that did not fit (R12). The employee is told once, per message,
-- which is what `notified_at` remembers.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS oversized_notified_at TEXT;
