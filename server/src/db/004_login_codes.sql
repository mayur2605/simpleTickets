-- Migration 004: emailed sign-in codes (R06).
--
-- R06 asks for "separate account passwords plus emailed verification codes".
-- The password half has been there since the beginning; this is the other one.
--
-- Codes are stored HASHED, for the same reason session tokens and passwords
-- are: reading this table must not yield anything usable to sign in with. SHA-256
-- is enough and a slow KDF is not, for the same reason it is not needed for
-- session tokens - the code is generated here rather than chosen by a person,
-- so there is no weak-password space to grind. What protects a six-digit code is
-- that it expires in ten minutes and dies after five wrong guesses, and both of
-- those are columns below.
--
-- One row per account at a time: requesting a new code replaces the old one, so
-- a stolen code cannot be held while its owner keeps signing in.
CREATE TABLE IF NOT EXISTS login_codes (
  staff_name TEXT    PRIMARY KEY REFERENCES staff (name),
  code_hash  TEXT    NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS login_codes_expiry ON login_codes (expires_at);
