-- Migration 003: IT staff and their availability (R07, R24).
--
--   wrangler d1 execute simpletickets --remote --file migrations/003_staff.sql
--
-- Deliberately seeded with NOBODY. The prototype's five names are sample data,
-- and inserting them here would assign real employee tickets to people who do
-- not exist - which looks handled while nothing happens. With no staff rows,
-- chooseAssignee returns null, tickets stay visibly unassigned, and that is the
-- correct state until real staff are added.
--
-- `available` is admin-controlled and separate from account access: marking
-- someone unavailable stops new work reaching them without revoking anything
-- (R24). Disabling an account is a different action, not modelled yet.
CREATE TABLE IF NOT EXISTS staff (
  name       TEXT PRIMARY KEY,
  email      TEXT,
  available  INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS tickets_owner ON tickets (owner, status);
