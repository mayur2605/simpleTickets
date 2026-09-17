# Implementation Tasks

Status, 17 September 2026: **the application is built and runs locally.** The stack moved
off Cloudflare the same day — read
`docs/superpowers/specs/2026-09-17-local-replatform-design.md` first, because it replaces
every earlier architecture note in this document. One Node process now serves the API,
serves the dashboard, polls the mailbox, sends queued mail, assigns tickets, notifies
staff, reminds on overdue responses, closes resolved tickets, stores attachments and backs
the database up nightly. All eight decisions approved on 16 September 2026 are implemented.

**What "built" does and does not mean here.** The server gate passes with 219 unit tests
and 59 integration tests against real PostgreSQL. Ingestion is measured on this stack, not
inherited: on 17 September 2026 an empty database pointed at the live mailbox independently
rebuilt the same tickets, including the threaded reply, and logged three unapproved senders
(`docs/stack-validation.md`).

**Sending is still inherited.** `MAIL_SEND` has never been on here, so every claim below
about a message reaching a person comes from the Cloudflare deployment. The outbox composes
and queues correctly and reports `held: true`; no SMTP connection has been opened from this
machine.

A local prototype privacy regression was fixed and verified; see
[takeover review](../../docs/takeover-review.md).

## Phase 0 — Foundation and feasibility

- [ ] T001 Resolve open product questions from the PRD one at a time; update acceptance examples.
- [ ] T002 Install and initialize official GitHub Spec Kit with a supported agent integration, preserving authored documents; verify CLI/runtime and record version.
- [ ] T003 Prove test-mailbox IMAP/SMTP round trip from candidate runtime; record TLS, routing and compatibility findings without secrets.
- [ ] T004 Benchmark representative mail, maximum permitted attachments and secure password verification against free runtime limits.
- [ ] T005 Confirm hosting, storage, backup/restore design and cost assumptions; finalize plan.

- [~] T028 Extend strict type/lint/format/CI gates to the production backend, add test-first domain and integration suites, and migrate prototype CSS to mobile-first with accessibility and cross-browser validation. See docs/engineering-standards.md.
  Backend: the same gate as the prototype - strict type-aware ESLint at zero warnings,
  Prettier, typecheck, **219 unit tests and 59 integration tests** against real PostgreSQL,
  wired into `server`'s `npm run verify`. The integration suites are new and were the
  standing gap: under D1 `store.ts` could only run against Cloudflare's hosted database, so
  the batches, the claim and the R28 ordering were verified by reading them.
  The two documented ESLint exceptions are **gone**, not suppressed - both existed at
  Cloudflare type boundaries (`cloudflare:sockets`' `any`-parameterised streams, and
  imapflow's Node stream with `@types/node` deliberately absent) and neither boundary exists
  now. `eslint.config.mjs` was deliberately not widened during the port: a migration is the
  wrong moment to change what "green" means, because then a new failure cannot be told from
  a new rule.
  Frontend: domain unit suite in the gate (T009); name/role/value fixed for the sidebar nav,
  queue filter tabs and the ticket table's scroll region, asserted in the smoke test.
  **Still open:** desktop-first CSS migration, full keyboard journeys, 200% zoom,
  screen-reader passes, forced colours, touch targets, and Firefox/WebKit.

## Phase 1 — Shared foundation

- [x] T006 Scaffold selected application, local configuration, secret handling, migrations and development instructions.
  Done: `server/` is a Node package with `.env.example`, a migration runner applying
  `src/db/*.sql` once each inside a transaction, a seed command, and setup instructions in
  CLAUDE.md. Secrets live in `server/.env`, which is git-ignored and which the pre-commit
  hook refuses to stage. `node --env-file-if-exists` reads it natively, so there is no
  dotenv dependency and no import-order trap.
- [~] T007 Model accounts (with an enabled/disabled state), tickets, messages, attachments, audit events, inbox deduplication, outbox with per-intent delivery state and acceptance time, requested-but-unapplied transitions, deadlines, the auto-close anchor and its bounce pause, and sessions; add integrity constraints.
  Mostly done: `src/db/001_baseline.sql` and `002_notifications.sql` model tickets,
  messages, attachments, inbox deduplication (`ingest_log.uid` as primary key), the outbox
  with per-intent delivery state and `accepted_at`, requested-but-unapplied transitions
  (`outbox.pending_status`), deadlines, the reminder cursor and sessions. The auto-close
  anchor is `outbox.accepted_at` on the resolution row and its bounce pause is the
  `bounced` state, so neither needed a column of its own.
  **Not done:** audit events have no table — the message history is the only record of
  who did what, and assignment changes are not recorded at all. CC participants are not
  modelled. Accounts have no enabled/disabled state, only `available`.
- [~] T008 Implement admin-provisioned accounts, password plus email-code sign-in, authorization and recovery; test expiry, reuse, brute-force limits and disabled accounts. Disabling an account must revoke sessions and sign-in and trigger the T015 redistribution in the same operation.
  Mostly done: admin-provisioned passwords with no self-registration, scrypt hashing with
  parameters recorded per stored value, per-account throttling with a 15-minute lockout,
  HttpOnly/Secure/SameSite=Strict cookies whose tokens are stored hashed, expiry swept on
  each new sign-in, and sign-out that deletes the row. The first password is set from the
  command line because no API path may mint the first credential — a deliberate deadlock,
  broken from the machine rather than by a back door.
  **Not done:** email-code sign-in, account recovery, and the enabled/disabled account
  state with its session revocation. Brute-force limits are tested; expiry and reuse are
  unit tested but not exercised against a live clock.
- [x] T009 Implement shared business calendar and deadline calculation; test all spec boundary examples and Sunday new-ticket/reply behavior and preservation of earlier pending deadlines.
  Done: `prototype/src/domain/business-calendar.ts`, 19 passing Vitest cases covering the four spec examples, the working-window boundaries at 09:00/18:00, Saturday-to-Monday carry, and the no-postponement rule. Domain rule only — no ticket store consumes it yet; wiring belongs to T007/T016.

## Phase 2 — Employee email flow

- [~] T010 Implement two-minute mailbox polling, lease/checkpoint recovery and idempotency. Persist a one-time launch cutoff that excludes existing read/unread mail without modifying it. Test mail arriving during activation, restarts, downtime catch-up and UIDVALIDITY changes without resetting the cutoff.
  Built: IMAP polling of `simpleticketssupport@gmail.com` via `imapflow`, a UIDVALIDITY/UID
  checkpoint in `mailbox_state`, idempotency by `ingest_log.uid` as primary key written in
  the same transaction as the ticket and message, the R27 launch cutoff as `uidNext - 1`
  adopted on first run, sender validation against the exact domain, and HTML-to-text body
  extraction. The mailbox is opened **read-only** at every call site, so polling modifies
  nothing - which is also what lets this run beside another system on the same mailbox.
  **The lease this task asks for exists**, and is now the `Ticker`'s `#running` flag. It
  replaced a Durable Object alarm, which replaced a cron trigger that never fired on the
  Cloudflare account at all. All three were attempts at the same property: two ticks must
  never overlap. The flag is the simplest of the three and the only one with tests.
  **Checkpoint recovery is now integration tested** - `store.db.test.ts` proves the
  checkpoint is a single row updated in place, that a repeated UID cannot open a second
  ticket, and that a failed acknowledgement rolls the ticket back rather than leaving one
  that nothing will ever acknowledge. That was impossible under D1, where the only database
  was Cloudflare's.
  **Proved on this stack, 17 September 2026:** an empty database anchored at `lastUid 5`
  and pointed at the live mailbox examined 7 messages, created 3 tickets, appended 1 reply
  and rejected 3 unapproved senders - rebuilding what the previous deployment held, body
  for body. The launch cutoff was exercised in the same run: the one extra ticket is the
  message D1's cutoff had excluded.
  **Not done:** downtime catch-up and UIDVALIDITY-change behaviour are still reasoned about
  rather than tested - both paths need a fake IMAP server, which does not exist yet.
- [~] T011 Implement sender validation, safe body parsing, participant-aware threading and loop suppression. Preserve eligible employee CC recipients for public replies, deduplicate recipients and exclude the support mailbox; restrict CC recipients to the exact allcheckservices.com domain and accept threaded replies from those authorized CC participants. Test external addresses, mixed-case domains, lookalike suffixes, authorized CC replies and unrelated same-domain senders. Implement requester-only email CC additions and IT dashboard participant management, preserve participants omitted from later email headers, and audit explicit additions/removals. Test unauthorized additions, removed-participant replies and future-only notifications to new participants. Verify CC replies reopen Resolved/Closed tickets and follow the same response-timer and Sunday rules as requester replies without postponing existing deadlines.
  Built and unit tested: sender validation against the exact domain; safe body parsing
  including HTML-only mail; threading by `Message-ID`/`In-Reply-To`/`References`, never by
  the `[#42]` in a subject; folded-header parsing, walked line by line after a regex version
  silently dropped every `References` continuation; automatic-message detection (RFC 3834
  plus the older `Precedence` conventions); and reopening a Resolved/Closed ticket on a
  genuine reply without touching its deadlines.
  Proved on real mail while deployed: a reply was appended to its existing ticket (uid 10 to
  ticket 7) with the ticket count unchanged and no second acknowledgement, matching through
  `outbox` because a reply quotes the acknowledgement's Message-ID, which appears nowhere in
  `messages`. A GitHub notification in the same mailbox was recorded `rejected_sender`.
  **Loop suppression now covers the case that mattered.** A staff member replying to an IT
  notification is on the approved domain, so nothing about the address stops it; threading
  refuses to match a notification's Message-ID and the reply is recorded as
  `notification_reply`. That closes what this task calls "a reply to an IT notification
  produces no ticket message".
  **Not done:** CC participants are not modelled at all - no eligible-CC preservation, no
  dashboard participant management, no audit of additions or removals.

- [x] T012 Implement private attachments and 5 MB aggregate limit with body preservation and oversized-file notices.
  Done: attachments are extracted from the MIME structure on ingest, bounded at 5 MB per
  email **on bytes actually read** rather than on the sizes the sender's structure claims,
  written under `STORAGE_DIR` and indexed in `attachments`. Body text is preserved when
  the budget is exhausted. Served through `GET /api/attachments/:id`, which requires a
  session — these are employees' files, not static assets.
  The sender's filename never becomes a path: the stored path is a generated UUID, and the
  name is sanitised again on the way out, so `../../etc/passwd` reaches neither the disk
  nor the `Content-Disposition`. Downloads are served `application/octet-stream` with
  `nosniff`, so an employee's "image/png" that is really HTML cannot run as script on the
  dashboard's origin. Verified against the running server.
  **Not done:** an oversized-file notice to the employee.
- [~] T013 Implement durable outgoing mail intents, acknowledgement, delivery retries and visible failure states. Record SMTP acceptance with its timestamp, hold requested status transitions against the intent until acceptance, and apply each transition atomically with the acceptance record (R28). Match asynchronous bounces back to the accepted message and expose pending and bounce-paused states to IT. Test acceptance, permanent failure, retry idempotency and a bounce arriving after acceptance.
  Built and tested: an `outbox` whose `message_id` is UNIQUE, which is what stops one ticket
  sending two acknowledgements; enqueue in the same transaction as the ingest log entry;
  exponential capped backoff; permanent (5xx) versus transient classification with unknown
  codes treated as transient, so a temporary failure never silently loses mail; acceptance
  recorded with its timestamp and any pending transition applied in the SAME transaction
  (R28); and an `ambiguous` state for a send whose outcome was never learned, parked for IT
  rather than resent or dropped (PRD open point 4).
  Sending was proved on real mail while deployed: two acknowledgements were accepted by
  Gmail on the first attempt, with its queue ids recorded in `smtp_reply`.
  The claim is now `SELECT ... FOR UPDATE SKIP LOCKED`, and an integration test runs two
  claims concurrently against the real database and asserts exactly one wins. The
  compare-and-swap it replaced was correct, but could only ever be tested against a scripted
  fake that supplied its own answers.
  **A bounce now alerts and pauses**: the assignee gets a `delivery_failed` notification, and
  `ticketsReadyToClose` excludes a ticket whose resolution bounced, so auto-close stops.
  `GET /api/outbox` exposes failed, ambiguous and bounced rows to IT.
  **Not done:** bounce *matching* is still unreliable - `readBody` extracts a delivery
  report's human-readable part rather than the `message/rfc822` part that quotes the
  original headers, so a bounce is detected and recorded but often cannot be tied to its
  ticket. Auto-close does not re-anchor when a resend is accepted.

- [ ] T014 Test duplicate processing, malicious/unknown participants, malformed emails, oversized files and mid-processing failures.

## Phase 3 — IT workflow

- [~] T015 Implement atomic least-open assignment, tie rotation, admin-only availability management, unassigned alerts and manual reassignment. Automatically redistribute the New/In Progress/Waiting tickets of an owner who is marked unavailable or whose account is disabled, using recalculated workloads; if no staff are available, unassign affected open tickets and alert admin. On availability restoration, automatically assign unassigned open tickets using the same rule without rebalancing existing assignments to available staff. Preserve deadlines/status, audit moves and notify new owners. Verify retries, concurrent changes, regular-staff UI/API restrictions, and the separation of availability from account access — including that disabling revokes access and redistributes while marking unavailable does not, that Resolved/Closed tickets keep their historical owner, and that re-enabling an account returns no redistributed tickets.
  Mostly done: fewest-open-tickets with round-robin tie-break, applied on ingest and
  through `POST /api/tickets/:id/assign`. Availability is admin-only, and marking someone
  unavailable redistributes their New/In Progress/Waiting tickets one at a time, re-reading
  workloads after each move — assigning them in one pass would dump the whole queue on
  whoever happened to be least loaded at the start. Deadlines and status are preserved, and
  new owners are notified. Resolved and Closed tickets keep their historical owner because
  only open statuses are selected.
  **Not done:** account disabling (there is no disabled state), automatic assignment of
  unassigned tickets when someone becomes available, an unassigned-tickets alert to admin,
  and an audit record of each move. Assignment is not serialised against concurrent
  workload changes — with one poller and five staff this has not mattered, but it is a
  real gap the task asks for.
- [ ] T016 Build shared ticket list/detail with All Tickets as the default, a My Tickets filter scoped to the signed-in assignee, search, composable filters, workload and overdue summaries. Include a manual Close action on Resolved tickets and a visible indicator for a transition still waiting on delivery.
- [~] T017 Implement public dashboard replies, private internal notes and audit history. The dashboard is the only place IT composes a ticket message; there is no staff email relay.
  Mostly done: `POST /api/tickets/:id/reply` and `/note`. The reply is written to
  `messages` and queued in the outbox in one transaction — a reply shown in the dashboard
  that was never queued would have IT believing they answered. `addNote` contains no
  outbox statement at all, which is the structural guarantee that an internal note cannot
  reach employee email. There is no staff email relay: the only inbound path rejects staff
  mail like any other unauthorised sender.
  `author` comes from the session, never from the request body — verified by posting a
  reply claiming `author: "staff5"` and finding `staff1` recorded.
  **Not done:** audit history as a separate record.
- [x] T018 Implement assignment, employee-reply and overdue notifications to IT, each linking to the ticket in the dashboard. Verify they carry no internal-note content, that a reply to one is not ingested and satisfies no response deadline, and that rejecting staff-authored mail to the support mailbox starts no loop.
  Done: `notification.ts` builds one-way messages for assignment, employee reply, overdue
  and delivery failure, each linking to `DASHBOARD_URL/tickets/:id`. They carry no
  internal-note content, and cannot: the builder takes a subject, a requester and a
  recipient, and has no parameter through which note text could arrive.
  **A reply to a notification is not ingested**, and this took more than a Reply-To header
  to arrange. IT staff are on the approved sender domain, so their reply arrives
  indistinguishable from the employee's; `findTicketByMessageIds` therefore refuses to
  thread on a notification's Message-ID, and ingestion records such a message as
  `notification_reply` rather than dropping it. The message also carries
  `Reply-To: no-reply@`, `Auto-Submitted: auto-replied` and says so in its text.
  Overdue reminders go to the assignee and every admin, repeating every four **working**
  hours (R18) with `last_reminder_at` as the memory. 22 tests, pure and integration.
  **Not proved:** no notification has been delivered to a person — `MAIL_SEND` is off.
- [ ] T019 Test assignment concurrency, all-staff-unavailable, account disabling during active work, rejection of staff-authored inbound mail, and attachment access.

- [ ] T027 Add an admin-only Reply Templates section with reusable name/body records, seed the four agreed starter templates, and implement template selection/send for all staff using the normal public-reply flow. Allow staff to edit the selected message before sending without changing the saved template. Add the agreed send-time status mappings, preview the intended status, and allow admin-selected custom mappings with no-change as default. Verify admin authorization, draft/template isolation, transition/message validation, atomic outgoing intent and status updates, visible delivery failures, and that template changes preserve previously sent messages. A template-mapped transition is delivery-gated like any other and takes effect only on SMTP acceptance (R28).

## Phase 4 — Lifecycle and reminders

- [ ] T020 Require an emailed information request before entering Waiting for Employee, and apply the transition only on SMTP acceptance of that message (R28), preserving status, deadline and reminders until then. Implement response episodes, repeated reminders, waiting behavior and admin/assignee recipient deduplication. Test that a pending or failed information request keeps reminders running.
- [~] T021 Require a non-empty public resolution message when resolving, reject missing-message attempts, and implement resolution/closure emails, manual closure of Resolved tickets, automatic closure and reopening with owner retention/reassignment. Apply Resolved only on acceptance of the resolution email, anchor the 72 elapsed hours to that acceptance, keep the ticket Resolved after either closure route until the closure email is accepted, and pause automatic closure on a later resolution bounce until a resend is accepted (R19, R28).
  Mostly done: resolving requires a non-empty body (the API rejects an empty one), and the
  status moves only when the mail server accepts that message. The 72 elapsed hours are
  anchored to `outbox.accepted_at` on the resolution row, not to the button press —
  `ticketsReadyToClose` joins on it. Manual and automatic closure use the same machinery:
  both queue a `closure` intent carrying `pendingStatus`, so both leave the ticket Resolved
  until that email is accepted. A bounced resolution excludes the ticket from auto-close,
  and the assignee is notified. Reopening on an employee reply retains the owner.
  **Not done:** re-anchoring the 72 hours when a resend is accepted after a bounce, and
  reassignment on reopening when the original owner has gone.
- [ ] T022 Test reminder job retries, unresolved clock transitions, weekends, repeated follow-ups and closure/reply races, and verify employee email text never invokes closure. Cover the delivery-gated cases: a resolution accepted late, a resolution that never sends, manual closure racing an employee reply, and a bounce-paused ticket that must not auto-close until a resend is accepted.

## Phase 5 — Release preparation

- [~] T023 Add mail health, error visibility, storage monitoring, daily 02:00 IST backup jobs with 30-day recovery-point retention, admin failure alerts and operating documentation. Include restorable attachment bytes, private backup storage and safe pruning that preserves dependencies and the last usable backup.
  Mostly done: `/health` reports whether the mail loop is beating and distinguishes
  "switched off" from "died" — a watchdog that cannot tell those apart is one that gets
  ignored. `/status` exposes the checkpoint, row counts and outbox state by state, with
  every state reported as a number so a missing key cannot read as a healthy queue.
  `GET /api/outbox` surfaces everything needing a human: failed, ambiguous and bounced.
  Backups run at 02:00 IST with 30-day retention and prune only `.dump` files.
  **Not done:** attachment bytes are not backed up, storage usage is not monitored, there
  is no admin alert on backup failure (it logs), and there is no operating documentation
  beyond CLAUDE.md.
- [~] T024 Restore database and attachments from a retained recovery point in a test environment; verify message/attachment consistency, measure restore time and record evidence. Test backup failure alerts and retention without deleting production records.
  Mostly done for the database: `backup.db.test.ts` takes a real `pg_dump`, empties the
  database, restores it and checks the rows came back — and then checks the restored
  database can still accept a new ticket, because identity sequences are where a restore
  usually looks fine and is not. Runs in the gate, so it cannot quietly stop working.
  **Not done:** attachment bytes are not in the backup, so "message/attachment
  consistency" is unverified; restore time is not measured; failure alerting is not tested.
- [ ] T025 Run end-to-end acceptance with test accounts and mailbox; review all PRD requirements R01–R28 against results, including the delivery-gated transitions and the dashboard-only IT workflow.
- [ ] T026 Prepare deployment and rollback instructions with concrete hosting costs and limitations for review.

External test messages require explicit authorization identifying test recipients/mailbox. This document does not send messages or deploy resources.
