# Local replatform: Cloudflare Workers + D1 → Node + PostgreSQL + local disk

**Date:** 17 September 2026
**Status:** implemented
**Supersedes:** the Cloudflare sections of `AGENTS.md` and `CLAUDE.md` as they stood
on 17 September 2026

## Why

The question that started this was "why are we using Cloudflare?", and there was no good
answer. It was chosen before anything was tested, and the record in this repository is a
list of what it cost:

| Recorded problem | On Node + PostgreSQL |
| --- | --- |
| Cron triggers never fire on this account — proved with a probe worker that had no HTTP surface at all | `setInterval`, in one process |
| WebCrypto caps PBKDF2 at 100,000 iterations against guidance of 600,000; reached by chaining six rounds | `node:crypto` scrypt, memory-hard, no cap |
| Fetching a **UID range** over IMAP stalls under `nodejs_compat`; a single UID does not | imapflow is a Node library; ranges work |
| `Buffer` does not resolve (`@types/node` deliberately absent), so imapflow's `headers` is error-typed | `Buffer` is simply there |
| `Date.now()` is frozen during synchronous execution, so in-request timing reads zero | real timers; a login measures 252 ms |
| `cloudflare:sockets` cannot be imported under vitest, forcing `smtp.ts` / `smtp-transport.ts` apart | one file, `node:tls` |
| `store.ts` could only run against Cloudflare's hosted database, so it had no tests | 59 integration tests against real PostgreSQL |
| Every change needs a deploy, and a schedule change takes 15 minutes to propagate | restart a process |
| D1 free tier gives 7 days of Time Travel against an agreed 30-day backup window | `pg_dump`, retention is whatever the disk holds |
| The dashboard needed `VITE_ADMIN_TOKEN` compiled into the browser bundle | same-origin session cookie; no token in the bundle |

Nine of those ten are not incidental difficulties. They are the platform.

## Decision

Build and run locally: **Node 24 + PostgreSQL 18 + the local filesystem**, in one
process. Production hosting is deliberately a separate, later decision — a plain Node
application deploys to an office server, a VM or a PaaS unchanged, so deferring costs
nothing.

Cloudflare stayed deployed and untouched until the local build was proven against the same
mail. That happened on 17 September 2026. The `simpletickets-api` Worker and the
`simpletickets` D1 database were then deleted, and `worker/` was removed from the
repository — it is in git history if it is ever needed. **No cloud resource remains.**

## Approach: port, not rewrite

Three options were weighed.

**Port first, features after** — chosen. Each phase ends provable and the existing tests
keep passing throughout, so a regression is obvious and local.

**Greenfield `server/`** — rejected. It would throw away behaviour that cost real
debugging: the folded `References` continuation bug, read-only mailbox opening, the
acknowledgement enqueued in the *same* transaction as the ingest log. Each of those is a
one-line detail that does not survive a rewrite, and each one is a production incident.

**Strangler, both live** — rejected. That is for systems that cannot be taken down. This
one had two tickets and no users; the dual-write complexity buys nothing.

The coupling turned out to be shallower than the file count suggested. Of 42 files, seven
referenced a Cloudflare API, and two of those were **comments only**. `pipeline.ts`
needed two lines changed. The real work was `store.ts`.

## What was built

### Phase 1 — the port

- `store.ts`: 47 `prepare().bind().all()` call sites became `pool.query(sql, [args])`, by
  hand. A D1-shaped shim over `pg` was considered and rejected: it is the kind of clever
  someone decodes at 3am, and it would keep the `?` → `$n` mismatch alive forever.
- `db.batch()` → real transactions. This **strengthens** R28 rather than preserving it: a
  D1 batch was atomic but not isolated.
- `claimNextIntent` → `SELECT … FOR UPDATE SKIP LOCKED`, the lock D1 never had. The
  compare-and-swap it replaced was correct, but only because there was exactly one poller.
- `ticker.ts`: the Durable Object deleted, replaced by `setInterval` plus a `#running`
  flag. That flag is not incidental — it preserves the mutual exclusion the Durable Object
  gave by being single-threaded, without which two polls can claim the same outbox row and
  send the same message twice.
- `smtp.ts`: rewritten on `node:tls` and merged back with the parsing half.
- `password.ts`: scrypt (N=2¹⁶, r=8, p=2 — OWASP-listed, 64 MB peak, same total work as
  the more commonly quoted N=2¹⁷/r=8/p=1 at half the peak memory). The chained-PBKDF2
  *verifier* stays, because passwords written under it must keep working.
- Timestamps stay `TEXT` ISO-8601 rather than becoming `timestamptz`. Every domain module
  parses these strings, `toISOString()` is fixed width, so lexicographic comparison is
  still chronological and every `WHERE next_attempt_at <= $1` keeps working. Converting
  would have rewritten `store.ts`'s contracts for no Phase 1 benefit.
- One `001_baseline.sql` rather than four ported migrations: the SQLite ones existed to
  reshape a database that will never exist here.
- Raw RFC822 source archived to disk on every ingest. Three lines, and it makes attachment
  extraction a reparse rather than a re-fetch from a mailbox the message may have left.

### Phase 2 — the dashboard connected

- The server serves the built dashboard, so `/api` is same-origin. The session cookie
  works with no CORS, and `cors.ts` was deleted.
- `VITE_ADMIN_TOKEN` is gone. The built bundle contains no credential — verified by
  grepping the output.
- `author` comes from the session, server-side. A request claiming `author: "staff5"` is
  recorded as whoever is actually signed in; verified against the running server.
- The dashboard decides it is live by asking `/api/me`, not by reading a build-time
  variable — the honest question is "is a server there", not "was one configured".

### Phase 3 — assignment and notifications

- Assignment on ingest, on request, and redistribution when somebody is marked unavailable
  (R08), re-reading workloads after each move so one person does not absorb a whole queue.
- One-way staff notifications (R15) on assignment, employee reply, overdue and delivery
  failure, each linking to the ticket in the dashboard.
- Overdue reminders every four **working** hours (R18), with `last_reminder_at` as the
  memory — without it every two-minute tick would send another.

### Phase 4 — attachments and backups

- Attachments to local disk (R12), 5 MB per email, enforced on bytes actually read rather
  than on the sizes the sender's MIME structure claims.
- `pg_dump` at 02:00 Asia/Kolkata with 30-day retention (R21), with a test that takes a
  real dump, empties the database, restores and checks the rows came back.

## Two hazards closed that the port surfaced

**A staff member replying to a notification.** IT staff are on the approved sender domain,
so their reply to a one-way notification arrives looking exactly like the employee's. It
would have been threaded onto the ticket — restarting the response clock and reopening a
resolved ticket. R15 forbids this. `store.findTicketByMessageIds` now refuses to thread on
a notification's Message-ID, ingestion records such a reply as `notification_reply`, and
the message carries `Reply-To: no-reply@` and says so in the text.

**Reminders that reached one person.** An overdue reminder goes to the assignee and every
admin, all built in the same millisecond for the same ticket and kind — so a
timestamp-based Message-ID produced identical values and `outbox`'s UNIQUE constraint
silently dropped everyone after the first. Found by an integration test asserting two
recipients. Message-IDs now carry a random component, and `enqueueIntent` returns whether
it actually inserted, so a suppressed duplicate can no longer be counted as a delivery.

## Accepted trade-offs

- **Username enumeration by timing at login.** An unknown account returns without running
  the KDF. Hashing a dummy value would even the timing and turn an expensive KDF on an
  unauthenticated endpoint into a denial-of-service amplifier, which the per-account
  throttle cannot catch. Accounts are named `staff1`–`staff5` and are guessable anyway.
  Revisit if names ever become non-obvious. Recorded in `docs/stack-validation.md` and at
  the code site.
- **TypeScript 6.0.3, not 7.0.2.** `typescript-eslint` declares `typescript <6.1.0`.
  Taking 7 would silently disable the type-aware lint rules that are the gate. Every other
  dependency is at its latest version.
- **`TEXT` timestamps.** Correct for ordering and comparison; the upgrade path to
  `timestamptz` is recorded at the schema.

## Evidence

- Server gate: 219 unit tests, 59 integration tests against real PostgreSQL, zero
  TypeScript errors, zero ESLint errors and warnings, Prettier clean.
- Prototype gate: 19 unit tests, browser smoke PASS, build clean, no token in the bundle.
- Local PostgreSQL holds byte-identical content to live D1: same two tickets, same four
  messages, same SHA-256 over the message rows.
- Login, session, authorship, the send gate, attachment storage and download all exercised
  against the running server.

## Acceptance test: passed

Run 17 September 2026, 10:30 IST, once the App Password was supplied.

An empty database, checkpoint anchored at `lastUid 5` — below the first employee email, so
R27's launch cutoff could not skip the history — pointed at the live mailbox:

```
examined 7, created 3, appended 1, rejected 3, lastUid 12
```

It rebuilt the tickets the previous deployment held, body for body, including the reply
that threads through `outbox` rather than `messages`. Two differences, both correct: one
extra ticket, because D1's cutoff had sat after that message and this run was anchored
below it; and one fewer message on "New test ticket", because the third was an internal
note typed into the dashboard and no mailbox can produce it.

Same mail in, same tickets out, on a different runtime and a different database.

## Still not proven

**Sending from this stack.** `MAIL_SEND` has never been on here — the outbox composes,
queues and reports `held: true` without opening a socket. The SMTP module is ported and
unit tested, and the Cloudflare build had real acknowledgements accepted with Gmail queue
ids, but no message has left this machine. Turning it on means real employees receive mail
and needs explicit authorization.

---

## Afterwards, the same day

The port was deliberately a port: same behaviour, different runtime, so a new failure could
be told from a new feature. With that proved, the requirements the Cloudflare build had
never reached were built on top — CC participants, an audit trail, account access separate
from availability, reply templates, backups that include the attachment bytes, and the
dashboard for all of it.

That work is recorded where it belongs rather than here: `specs/001-email-ticketing/tasks.md`
task by task, and `docs/requirements-review.md` requirement by requirement. This document
stays what it was, an account of the move itself, because rewriting it to describe a larger
system would lose the one thing it is evidence of — that the same mail in produced the same
tickets out, on a different runtime and a different database.

The gate has since grown from 219 + 59 to 245 + 130. **Sending is still not proven**, for
exactly the reason above.
