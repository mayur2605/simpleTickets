-- Migration 004: staff sign-in (R06).
--
--   wrangler d1 execute simpletickets --remote --file migrations/004_auth.sql
--
-- Until now the API had one shared admin token, so it could not tell one staff
-- member from another, and `messages.author` was whatever the client claimed.
-- The ticket history said "staff1 replied" no matter who replied - an audit
-- trail that looked authoritative and was invented.

-- Passwords are admin-provisioned (R06): there is no self-registration. A NULL
-- hash means the account cannot sign in yet, which is the correct state for a
-- staff row created before a password was set.
ALTER TABLE staff ADD COLUMN password_hash TEXT;
ALTER TABLE staff ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

-- The session token is stored HASHED. Anyone who reads this table - a backup, a
-- stray export - must not come away with something they can log in with.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  staff_name TEXT NOT NULL REFERENCES staff (name),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_staff ON sessions (staff_name);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at);

-- Failed sign-ins, for throttling. Recorded per account rather than per IP:
-- Workers sees Cloudflare's edge addresses and an attacker can rotate source
-- addresses freely, but they cannot avoid naming the account they are guessing.
CREATE TABLE IF NOT EXISTS login_failures (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_name TEXT NOT NULL,
  at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS login_failures_lookup ON login_failures (staff_name, at);

-- staff1 is the admin (as chosen). It still has no password, so it cannot sign
-- in until one is set.
UPDATE staff SET is_admin = 1 WHERE name = 'staff1';
