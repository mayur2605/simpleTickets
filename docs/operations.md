# Operating SimpleTickets

What to run, what to watch, and what to do when something is wrong. Written for
whoever is holding the pager, which for now is the person who deployed it.

The system is one Node process, one PostgreSQL database and one directory of
files. There is no cloud dependency, no queue service and no second machine —
which is the whole reason this document is short.

---

## Running it

```bash
cd server && npm ci
cp env.example .env          # then fill it in; see below
npm run db:migrate
npm run db:seed              # staff1..staff5, staff1 as admin, four templates
npm run db:seed -- --password staff1   # prompts; never pass a password as an argument
cd ../prototype && npm ci && npm run build
cd ../server && npm start
```

The dashboard is then at `http://localhost:8787`, serving the built bundle from
the same origin as the API — so the session cookie works with no CORS and the
browser bundle holds no token.

### What must be in `.env`

| Variable | Needed for | If it is missing |
| --- | --- | --- |
| `DATABASE_URL` | everything | defaults to `postgresql://localhost:5432/simpletickets` |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | the mail loop | the server runs, the API and dashboard work, ingestion does not start and says so |
| `ADMIN_TOKEN` | `/status`, `/poll`, `/flush`, `/backup` | those routes answer 404 to everyone |
| `MAIL_SEND` | sending | off unless exactly `on`; intents are composed and queued but nothing reaches the wire |
| `STORAGE_DIR`, `BACKUP_DIR` | attachments, backups | default to `./var/storage` and `./var/backups` |
| `PG_BIN` | backups | probed from the known install locations; set it if `pg_dump` is somewhere else |
| `LOGIN_CODES` | the second sign-in factor (R06) | off unless exactly `on`; **needs `MAIL_SEND=on` and credentials, or the server refuses to start** |
| `DASHBOARD_URL` | notification links | defaults to `http://localhost:PORT`, which is wrong for anyone but you |

`.env` is git-ignored and the pre-commit hook refuses to stage one. Node reads
it natively via `--env-file-if-exists`, so there is no `dotenv` dependency.

### Turning sending on

`MAIL_SEND=on` means real email to real employees. Before setting it:

1. Confirm nothing else is polling the same mailbox and answering the same
   tickets. Two systems both sending acknowledgements is visible to everyone who
   writes in.
2. Confirm `DASHBOARD_URL` points at where staff actually read tickets. Every
   notification links there, and a link to `localhost` is a link to nowhere.
3. Get explicit authorisation naming the sender and the recipients. This is a
   project rule, not a technical one, and it exists because the recipients are
   colleagues rather than test addresses.

Off is the default on purpose. The usual reason to run this locally is to
develop against the real mailbox, and a second acknowledgement for a ticket
another system already answered lands in a real person's inbox.

### Turning sign-in codes on

`LOGIN_CODES=on` makes every sign-in require a six-digit code emailed to the
staff member as well as their password (R06). It is off by default, and that
default is the safe one rather than the lax one: the code goes out over SMTP, so
turning it on while `MAIL_SEND` is off leaves every staff member waiting for an
email that will never arrive, with no way for the system to tell them why.

**The server refuses to start** with `LOGIN_CODES=on` and no way to send. That
failure is loud, immediate, and lands on whoever changed the setting rather than
on five people the next morning.

Before turning it on, check every account has an `email` — an account without
one cannot receive a code and cannot sign in. `GET /api/staff` shows it.

If somebody is locked out: codes expire in ten minutes and die after five wrong
guesses, and the per-account throttle locks the account for fifteen minutes after
five failures of either kind. Waiting is the fix. If mail itself is broken, set
`LOGIN_CODES=off` and restart — that is the documented escape hatch, and it is
why the setting exists rather than the behaviour being unconditional.

---

## What to watch

### `/health` — unauthenticated, poll this

```json
{ "ok": true, "mail": "enabled", "ticker": { ... }, "backup": { ... } }
```

`ok` is false, and the status code 503, when either:

- the mail loop is **running but stalled** — no tick for more than three
  intervals. A loop that was never started is *not* counted as unhealthy: a
  server deliberately brought up without mail credentials is not broken, and a
  watchdog that cannot tell "switched off" from "died" is one that gets ignored.
- the **last backup failed** and none has succeeded since.

Everything else — an empty queue, a bounced message, a ticket nobody owns — is
visible through the dashboard and is a person's problem rather than a process's.

### `/status` — needs `x-admin-token`

Checkpoint, row counts, outbox by state, ticker, backup state, and disk usage
for both the attachment and backup directories. Every outbox state is reported
as a number even when it is zero, so a missing key cannot read as a healthy
queue.

### The dashboard

`GET /api/outbox` and the ticket detail surface anything needing a human:
permanently failed sends, sends whose outcome was never learned, and messages
that bounced after being accepted. A ticket waiting on a delivery says so on its
own page, with a **Send again** button.

---

## When something is wrong

### The mail loop has stalled

`/health` says `ok: false` with `ticker.health.stalled`. Look at
`ticker.lastError` first — an IMAP authentication failure and a network timeout
need different answers.

```bash
curl -H "x-admin-token: $ADMIN_TOKEN" localhost:8787/ticker         # what it thinks
curl -X POST -H "x-admin-token: $ADMIN_TOKEN" localhost:8787/poll   # one tick, now
```

`/poll` runs a full tick including a flush, so it *can* send. `/peek` and `/diag`
read the mailbox and send nothing — use those to check the credentials.

Nothing is lost while it is stalled. Ingestion is idempotent by UID and the
checkpoint only advances after processing, so a restart re-examines rather than
skips.

### A message will not send

Look at its state:

- **`pending`** with a future `next_attempt_at` — backing off. Leave it.
- **`failed`** — permanent (a 5xx), or five attempts exhausted. Fix the cause,
  then **Send again** from the ticket.
- **`ambiguous`** — the send went out and the outcome was never learned. This is
  parked for a person deliberately: resending risks a duplicate to a real
  employee, dropping it risks silence. Check the mailbox's Sent folder, then
  either resend or leave it.
- **`bounced`** — accepted and then rejected. Auto-close is paused for that
  ticket until a resend is accepted, and the assignee has been notified.

Resending clears the acceptance timestamp, which is what re-anchors the 72-hour
auto-close clock to the delivery that actually arrived.

### A ticket has no owner

Every admin was emailed when it happened. It means nobody was both available and
had an account at the time. Mark somebody available on the Team page and the
unassigned open tickets are shared out immediately; tickets already being worked
are left alone.

### The backup failed

`/health` reports `backup.failing` with the error, and the audit trail has a
`backup_failed` entry. The usual cause is `pg_dump` not being found or being the
wrong version — set `PG_BIN` to the directory holding the version-18 binaries.

```bash
curl -X POST -H "x-admin-token: $ADMIN_TOKEN" localhost:8787/backup
```

---

## Backups and restore

A recovery point is **two files** taken together:

- `simpletickets-YYYY-MM-DD.dump` — `pg_dump --format=custom`
- `simpletickets-YYYY-MM-DD-files.tgz` — everything under `STORAGE_DIR`

Both, because attachments live on disk. Restoring the database alone gives you
an `attachments` table whose every row points at a file that is not there — a
backup that looks complete and is not.

Taken at 02:00 IST daily. Retention is 30 days, with two deliberate exceptions:
the newest dump is never deleted however old it is, and a file archive is never
deleted while its dump is being kept.

### Restoring

```bash
createdb simpletickets_restored
pg_restore --clean --if-exists --no-owner \
  --dbname postgresql://localhost:5432/simpletickets_restored \
  var/backups/simpletickets-2026-09-17.dump
tar -xzf var/backups/simpletickets-2026-09-17-files.tgz -C /path/to/restored/storage
```

Restore into a **new** database first and look at it. `--clean` drops what it
replaces, so pointing it at the live database is destructive and irreversible.

This procedure is not advice — it is the one `backup.db.test.ts` runs on every
gate: a real dump, a real archive, both halves destroyed, both restored, and then
a check that the restored database still accepts a new ticket. Identity sequences
are where a restore usually looks fine and is not.

---

## Deployment and rollback

**Hosting is deliberately undecided** (T026, and a standing decision). A plain
Node application deploys to an office server, a VM or a PaaS unchanged, so
nothing is lost by deferring it and a choice made now would be made without
usage figures. What follows is what any of those need.

### What it needs

| | |
| --- | --- |
| Node | 24 or later — the server runs TypeScript directly by type stripping |
| PostgreSQL | 18, and `pg_dump`/`pg_restore` of the same major version |
| Disk | the database, plus attachments and raw archived mail, plus 30 days of both in backups |
| Network | outbound 993 (IMAP) and 465 (SMTP) to Gmail; inbound only for the dashboard |
| TLS | required — the session cookie is `Secure`, so the dashboard must be served over HTTPS or nobody stays signed in |
| Process supervision | anything that restarts it: systemd, a container runtime, a PaaS |

Cost, honestly: for 100 employees and 5 IT staff this is a single small VM and
a small managed database, or one office machine. The load is a mailbox poll
every two minutes and five people using a dashboard. Naming a monthly figure
would be inventing one, because it depends entirely on the host chosen.

### Limitations worth knowing before deploying

- **One process.** The ticker's mutual exclusion is an in-process flag, so two
  instances would both poll and both claim outbox rows. The claim itself is
  `FOR UPDATE SKIP LOCKED` and is safe against that, but the poll is not. Run one.
- **Storage is local.** `STORAGE_DIR` must be on persistent disk, not a
  container's ephemeral layer, and it must be included in whatever backs the
  machine up — or at minimum `BACKUP_DIR` must be somewhere that survives it.
- **Sending has not been proved on this stack.** See `docs/stack-validation.md`.
- **Replies go out from the Gmail address**, not the company one. PRD open
  point 5.

### Deploying a change

```bash
git pull
cd server && npm ci
cd ../prototype && npm ci && npm run build
cd ../server && npm run verify          # both gates must pass before anything restarts
curl -X POST -H "x-admin-token: $ADMIN_TOKEN" localhost:8787/backup   # a recovery point first
npm run db:migrate
# restart the process
```

Migrations run automatically at startup too; running them by hand first means a
migration failure happens while you are watching.

### Rolling back

Rolling back the **code** is `git checkout` of the previous commit, `npm ci` and
a restart. Nothing is compiled ahead of time and nothing is deployed anywhere
else.

Rolling back the **database** is the part that needs thought, because migrations
are forward-only by design — there are no down-migrations, and writing them for
a system with one database and one operator adds a failure mode rather than
removing one.

- A migration that only **adds** things (a column, a table, an index) is safe to
  leave in place while the code rolls back. Every migration so far is of this
  shape. Prefer this: roll the code back and leave the schema alone.
- A migration that **changes or removes** something needs a restore from the
  most recent recovery point, into a new database, verified, and then swapped
  in. Take the backup *before* migrating, not after.

The ingestion checkpoint is in the database, so a database rollback rolls the
mailbox position back with it. That is safe — `ingest_log` makes re-examination
idempotent — but it will re-read mail and log it as skipped, which is worth
expecting rather than being surprised by.

---

## Things that are not here

- **No alerting beyond `/health` and the audit trail.** A backup failure is
  recorded and reported; it is not emailed. The alert channel for "the database
  could not be backed up" should not be the mail queue that lives in that
  database.
- **No log aggregation.** The process writes one JSON line per tick to stdout,
  with counts only — subjects and addresses stay out of the logs. Whatever
  supervises the process should capture it.
- **No metrics endpoint.** `/status` is the whole of it.
