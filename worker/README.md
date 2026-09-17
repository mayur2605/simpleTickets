# worker/ — frozen

**Do not develop here.** This is the Cloudflare Workers + D1 build, kept only as a fallback
until local ingestion is proved. The application is `server/`.

## Why it is still here

The replatform plan was explicit that this stays deployable until the local build has
independently rebuilt the same tickets from the same mailbox. That has **not happened
yet** — it needs `GMAIL_APP_PASSWORD` in `server/.env`, and Cloudflare secrets are
write-only, so the value cannot be read back from here.

Deleting this before the replacement is verified would remove the fallback before there is
anything to fall back from.

## What it is doing right now

Nothing. It still answers HTTP, but **the last ingestion was 16 September 2026 at
21:36 UTC** — the `Ticker` Durable Object's alarm chain has ended and nothing restarted it.

That is precisely the failure mode recorded in `docs/stack-validation.md`: an alarm chain
has no safety net, an evicted object or a lost alarm stops everything silently, and silence
is the only symptom. `.github/workflows/ticker-watchdog.yml` existed to catch exactly this
and did not. The chain is gone, so no mail is becoming tickets on this deployment.

One consequence worth knowing: because nothing here is running, there is currently **no
risk of duplicate mail** if local ingestion is switched on. If this deployment is ever
restarted while the local server is also polling with `MAIL_SEND=on`, both would send an
acknowledgement for the same email and a real employee would receive two. Reading the
mailbox from both is harmless — IMAP is opened read-only at every call site — but sending
from both is not.

## Deleting it

Delete this whole directory once the local server has:

1. Ingested from the real mailbox into an empty database, and
2. Produced the same tickets, messages and ingest-log rows the D1 export holds.

Before deleting, take a final D1 export (`server/src/db/import-d1.ts` documents the
commands) so the ingestion checkpoint can be carried across. Without that checkpoint a
fresh database adopts the mailbox's current `uidNext` and never sees anything earlier — the
R27 launch cutoff working exactly as designed, against you.

Then also remove the Cloudflare Worker, its D1 database and its Workers Builds connection
from the dashboard, so nothing can restart on its own.

## What was learned here

Everything worth keeping was carried into `server/` or written down:

- `docs/superpowers/specs/2026-09-17-local-replatform-design.md` — what this platform cost
  and what replaced it
- `docs/stack-validation.md` — every measurement, including the probe worker that proved
  cron triggers never fire on this account
- `AGENTS.md` — the four mail transports tried and closed, and the IMAP behaviours that
  cost real debugging time
