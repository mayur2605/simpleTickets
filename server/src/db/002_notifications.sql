-- Migration 002: staff notifications and overdue reminders (R15, R18).

-- When the last overdue reminder went out for this ticket. NULL means none has.
-- R18 repeats every four working hours until IT replies, so the schedule needs
-- a memory: without this, every tick would send another reminder.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS last_reminder_at TEXT;

-- An IT staff member replying to a one-way notification. They are on the
-- approved sender domain, so the reply arrives looking like any other - but
-- R15 says it must not reach the ticket. It is recorded rather than dropped,
-- because somebody replied to something and silently binning it is how a real
-- request disappears.
ALTER TABLE ingest_log DROP CONSTRAINT IF EXISTS ingest_log_outcome_check;
ALTER TABLE ingest_log ADD CONSTRAINT ingest_log_outcome_check
  CHECK (outcome IN ('ticket', 'rejected_sender', 'auto_reply', 'bounce', 'error',
                     'notification_reply'));
