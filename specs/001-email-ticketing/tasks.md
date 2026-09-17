# Implementation Tasks

Status, 17 September 2026: **the application is built and runs locally.** The stack moved
off Cloudflare the same day — read
`docs/superpowers/specs/2026-09-17-local-replatform-design.md` first, because it replaces
every earlier architecture note in this document. One Node process now serves the API,
serves the dashboard, polls the mailbox, sends queued mail, assigns tickets, notifies
staff, reminds on overdue responses, closes resolved tickets, stores attachments and backs
the database up nightly. All eight decisions approved on 16 September 2026 are implemented.

**What "built" does and does not mean here.** The server gate passes with 258 unit tests
and 176 integration tests against real PostgreSQL; the prototype gate passes 19 unit tests,
a browser smoke run and a production build. Ingestion is measured on this stack, not
inherited: on 17 September 2026 an empty database pointed at the live mailbox independently
rebuilt the same tickets, including the threaded reply, and logged three unapproved senders
(`docs/stack-validation.md`).

**Operating instructions now exist:** `docs/operations.md` covers running it, what to
watch, what to do when each thing goes wrong, the verified restore procedure, and
deployment and rollback.

**Cloudflare is deleted.** The Worker, the D1 database and the `worker/` source tree were
removed on 17 September 2026 once ingestion was proved locally against the same mailbox.
There is no deployment to fall back to, and no cloud resource of any kind remains.

**Sending is still inherited.** `MAIL_SEND` has never been on here, so every claim below
about a message reaching a person comes from the Cloudflare deployment. The outbox composes
and queues correctly and reports `held: true`; no SMTP connection has been opened from this
machine.

A local prototype privacy regression was fixed and verified; see
[takeover review](../../docs/takeover-review.md).

## Phase 0 — Foundation and feasibility

- [~] T001 Resolve open product questions from the PRD one at a time; update acceptance examples.
  Five of the nine are resolved and recorded: backup storage and restore (1), sender
  authentication and delivery (2), how mail reaches the mailbox (5), the sending transport
  (6) and password hashing (8). **Four are still open and each needs a decision rather than
  an implementation** — they are listed here so they can be answered one at a time:
  - **Open point 3.** What an employee reply should do to a transition whose required email
    has not yet been accepted. Today the reply reopens the ticket and the queued message
    goes out anyway, so an employee can receive "we are closing this" moments after writing
    in. The two answers are cancel the pending transition, or apply it and let the reply
    reopen. Both are defensible; the code cannot choose.
  - **Open point 4.** How to detect SMTP acceptance ambiguity. The `ambiguous` state and the
    resend path are built; what is missing is a rule for when a disconnect after DATA counts
    as acceptance.
  - **Open point 7.** The DMARC policy. Deliberately not recorded in this public repository.
  - **Open point 9.** Where backups go off this machine. Blocked on hosting (T005), which is
    deliberately deferred — and worth saying plainly: backups currently sit on the same disk
    as the database, which is not a backup against losing that disk.
- [ ] T002 Install and initialize official GitHub Spec Kit with a supported agent integration, preserving authored documents; verify CLI/runtime and record version.
  Not done, and worth re-examining rather than doing. The structure Spec Kit would provide
  already exists and is authored by hand: `.specify/memory/constitution.md`, this spec
  directory with `spec.md`, `plan.md` and `tasks.md`, and traceable requirement IDs running
  through all of them. Installing the tool now would reformat documents that are working in
  order to gain a generator nobody has asked for. This needs a decision on whether it is
  still wanted before it needs an installation.
- [~] T003 Prove test-mailbox IMAP/SMTP round trip from candidate runtime; record TLS, routing and compatibility findings without secrets.
  **IMAP is proved on this runtime.** An empty database pointed at the live mailbox on
  17 September rebuilt the same tickets, threaded the reply and rejected three unapproved
  senders. TLS, routing and compatibility findings are in `docs/stack-validation.md`, with
  no secrets — the credential is prompted for or read from a git-ignored `.env`, never
  passed as an argument.
  **SMTP is not.** `MAIL_SEND` has never been on here, so no message composed by this server
  has reached the wire. This is the same blocker as T025 and needs the same thing: explicit
  authorisation naming the sender and the recipients, against a test mailbox rather than the
  live support address.
  Worth doing first: re-run `scripts/check-mail-tls.mjs`. Zimbra IMAP was ruled out because
  the mail host dropped Cloudflare's traffic, and that constraint died with Cloudflare. If
  Zimbra is reachable from this machine the Gmail hop disappears and PRD open point 5 goes
  with it.
- [~] T004 Benchmark representative mail, maximum permitted attachments and secure password verification against free runtime limits.
  Measured on this stack, in the gate rather than by hand, so the numbers cannot go stale
  silently. A 5 MB attachment — the R12 maximum — stores in about 6 ms and reads back in
  about 2 ms. scrypt at N=2¹⁶, r=8, p=2 hashes and verifies in about 245 ms with a 64 MB
  peak. Memory for attachments is deliberately not measured: a heap delta around a garbage
  collection is noise, and the bound that matters is structural — the download loop stops at
  the budget on bytes actually read, so peak is one buffer of at most 5 MB per attachment
  whatever the sender's structure claims.
  **The "free runtime limits" this task was written against no longer exist.** They were
  Cloudflare's: a 100,000-iteration PBKDF2 cap, a CPU budget per request, and a frozen
  `Date.now()` that made any in-request timing read zero. All three died with Cloudflare, and
  the remaining limits are the machine's.
  **Not done:** representative mail end to end, which is the same thing T025 is waiting on.
- [~] T005 Confirm hosting, storage, backup/restore design and cost assumptions; finalize plan.
  Storage and backup/restore are confirmed and tested: local disk under `STORAGE_DIR`,
  `pg_dump` plus a `tar` of the attachment bytes at 02:00 IST, 30-day retention that keeps
  the newest recovery point however old, and a restore exercised by the gate rather than
  described in a runbook.
  **Hosting is deliberately still open**, which is a standing decision rather than an
  omission: a plain Node application deploys to an office server, a VM or a PaaS unchanged,
  so nothing is lost by deferring it and a choice made now would be made without usage
  figures. What any host must provide, and the limitations that constrain the choice, are
  in `docs/operations.md`. Costs stay unstated until a host is chosen — naming a figure
  would be inventing one.

- [~] T028 Extend strict type/lint/format/CI gates to the production backend, add test-first domain and integration suites, and migrate prototype CSS to mobile-first with accessibility and cross-browser validation. See docs/engineering-standards.md.
  Backend: the same gate as the prototype - strict type-aware ESLint at zero warnings,
  Prettier, typecheck, **258 unit tests and 176 integration tests** against real PostgreSQL,
  wired into `server`'s `npm run verify`. The integration suites are new and were the
  standing gap: under D1 `store.ts` could only run against Cloudflare's hosted database, so
  the batches, the claim and the R28 ordering were verified by reading them.
  Two suites were added on 17 September that reach further than the store:
  `ingest.db.test.ts` drives the whole pipeline against a mocked mailbox and a real
  database, and `api.db.test.ts` calls `handleApi` with real Request objects - which is
  where the authorisation lives, and where the participants route was found answering 400
  to every call.
  The two documented ESLint exceptions are **gone**, not suppressed - both existed at
  Cloudflare type boundaries (`cloudflare:sockets`' `any`-parameterised streams, and
  imapflow's Node stream with `@types/node` deliberately absent) and neither boundary exists
  now. `eslint.config.mjs` was deliberately not widened during the port: a migration is the
  wrong moment to change what "green" means, because then a new failure cannot be told from
  a new rule.
  Frontend: domain unit suite in the gate (T009); name/role/value fixed for the sidebar nav,
  queue filter tabs and the ticket table's scroll region, asserted in the smoke test.
  Accessibility, 17 September: the smoke test now walks the queue by keyboard, opens a
  ticket with Enter and asserts the focused element has a visible indicator; checks no
  horizontal overflow at 200% zoom (emulated by halving the viewport, per WCAG 1.4.4); and
  checks navigation touch targets against the rendered box on a 390 px phone, not against
  the CSS rule. A forced-colours layer gives the status pills, note stripes and focus ring
  borders that survive Windows high-contrast mode, where a background colour does not.
  **Still open:** the inherited stylesheets are still desktop-first. New CSS is written
  mobile-first and says so where it starts, but `style.css` is 1651 lines of append-only
  design iterations and `brand.css` overrides them - inverting that cascade is a rewrite
  with real regression risk and no behavioural gain, since responsiveness is already
  asserted at 360, 390, 640, 768, 960 and 1440 px. Also still open: screen-reader passes
  with an actual screen reader, and Firefox/WebKit runs.

## Phase 1 — Shared foundation

- [x] T006 Scaffold selected application, local configuration, secret handling, migrations and development instructions.
  Done: `server/` is a Node package with `.env.example`, a migration runner applying
  `src/db/*.sql` once each inside a transaction, a seed command, and setup instructions in
  CLAUDE.md. Secrets live in `server/.env`, which is git-ignored and which the pre-commit
  hook refuses to stage. `node --env-file-if-exists` reads it natively, so there is no
  dotenv dependency and no import-order trap.
- [x] T007 Model accounts (with an enabled/disabled state), tickets, messages, attachments, audit events, inbox deduplication, outbox with per-intent delivery state and acceptance time, requested-but-unapplied transitions, deadlines, the auto-close anchor and its bounce pause, and sessions; add integrity constraints.
  Done: `src/db/001_baseline.sql`, `002_notifications.sql` and `003_participants_audit_templates.sql` model tickets,
  messages, attachments, inbox deduplication (`ingest_log.uid` as primary key), the outbox
  with per-intent delivery state and `accepted_at`, requested-but-unapplied transitions
  (`outbox.pending_status`), deadlines, the reminder cursor and sessions. The auto-close
  anchor is `outbox.accepted_at` on the resolution row and its bounce pause is the
  `bounced` state, so neither needed a column of its own.
  **Closed on 17 September** by `003_participants_audit_templates.sql`: `audit_events`
  records who did what (assignment, status, availability, account access, participants,
  templates, resends, backup failures), with a nullable `ticket_id` because account-level
  events belong to nobody's ticket and no foreign key on `actor` because the record must
  survive the account it names. `ticket_participants` models CC participants with a
  `removed_at` rather than a DELETE, because R25 says omitting somebody from a later email
  does not remove them. `staff.enabled` is account access, distinct from `available`.
  `reply_templates` holds the shared wording with a CHECK that refuses to map one to
  Closed.
- [~] T008 Implement admin-provisioned accounts, password plus email-code sign-in, authorization and recovery; test expiry, reuse, brute-force limits and disabled accounts. Disabling an account must revoke sessions and sign-in and trigger the T015 redistribution in the same operation.
  Mostly done: admin-provisioned passwords with no self-registration, scrypt hashing with
  parameters recorded per stored value, per-account throttling with a 15-minute lockout,
  HttpOnly/Secure/SameSite=Strict cookies whose tokens are stored hashed, expiry swept on
  each new sign-in, and sign-out that deletes the row. The first password is set from the
  command line because no API path may mint the first credential — a deliberate deadlock,
  broken from the machine rather than by a back door.
  **The enabled/disabled account state landed on 17 September.** `setEnabled` sets the
  flag and deletes that account's sessions in one transaction - an account that is disabled
  and still holds a live cookie is not disabled - and the API redistributes their open
  tickets in the same call. Sign-in refuses a disabled account with the *same* message as a
  wrong password, because "this account is disabled" confirms the name exists and that it
  used to work. `identify` re-checks on every request, covering a DELETE racing a request
  already in flight. An admin cannot disable their own account: only an admin may re-enable
  one, and only from a session that call would have just deleted.
  **Email-code sign-in landed on 17 September** (R06). Six digits, because a person reads
  them out of an email and types them in, and a code nobody can transcribe gets pasted
  around. What makes six digits safe is not the code: it is the ten-minute expiry and the
  five-guess limit, which together give an attacker five tries at one in a million. Stored
  hashed, single use, one outstanding per account - asking for a new code destroys the old
  one, so an intercepted code cannot be held in reserve.
  The password step grants NO session: it accepts the password and emails a code, nothing
  more. The code step re-reads the account rather than trusting the first step, because ten
  minutes is long enough for an admin to disable it. Every failure returns the same message,
  including "no code was ever issued" - distinguishing them confirms which accounts have had
  one sent, which is to say which passwords are already known.
  Both races are asserted against the real database: two wrong guesses arriving together
  count as two, and two correct ones let exactly one through.
  **Off by default**, and the server refuses to start with it on and no way to send. A code
  that goes over SMTP while `MAIL_SEND` is off locks every staff member out of a system that
  cannot tell them why; failing at startup puts that in front of whoever changed the setting
  instead of in front of five people the next morning.
  The code email carries no link, deliberately: a sign-in email with a clickable link is the
  shape of every credential phishing message ever sent, and training staff to click one is
  worse than the inconvenience of typing six digits.
  **Account recovery is deliberately not self-service**, and that is a judgement worth
  stating rather than leaving as an unticked box. With five people who share an office, "ask
  the admin" solves what an emailed reset link would solve, and an emailed reset link means
  anyone who can read a mailbox can take an account. An admin resets a password from the
  dashboard; if the ADMIN forgets theirs, the escape hatch is
  `npm run db:seed -- --password staff1` from the machine, which is the same deliberate
  deadlock that bootstraps the first password. Documented in `docs/operations.md`. Revisit if
  the team stops sharing a room.
  Expiry and reuse are now exercised against a real database and a supplied clock rather
  than unit tested alone.
- [x] T009 Implement shared business calendar and deadline calculation; test all spec boundary examples and Sunday new-ticket/reply behavior and preservation of earlier pending deadlines.
  Done: `prototype/src/domain/business-calendar.ts`, 19 passing Vitest cases covering the four spec examples, the working-window boundaries at 09:00/18:00, Saturday-to-Monday carry, and the no-postponement rule. Domain rule only — no ticket store consumes it yet; wiring belongs to T007/T016.

## Phase 2 — Employee email flow

- [x] T010 Implement two-minute mailbox polling, lease/checkpoint recovery and idempotency. Persist a one-time launch cutoff that excludes existing read/unread mail without modifying it. Test mail arriving during activation, restarts, downtime catch-up and UIDVALIDITY changes without resetting the cutoff.
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
  **Closed on 17 September.** `ingest.db.test.ts` mocks `imap.ts` and nothing else - the
  database, the store, the threading, the domain rules and the outbox are all real - so the
  mailbox can be made to misbehave on demand. It proves the launch cutoff imports nothing
  and anchors below `uidNext`; that five messages arriving while the server was off all
  become tickets; that running the same poll twice creates nothing the second time and
  queues exactly one acknowledgement each; and that a UIDVALIDITY change re-anchors instead
  of re-importing a mailbox that still holds every message already ticketed.
- [x] T011 Implement sender validation, safe body parsing, participant-aware threading and loop suppression. Preserve eligible employee CC recipients for public replies, deduplicate recipients and exclude the support mailbox; restrict CC recipients to the exact allcheckservices.com domain and accept threaded replies from those authorized CC participants. Test external addresses, mixed-case domains, lookalike suffixes, authorized CC replies and unrelated same-domain senders. Implement requester-only email CC additions and IT dashboard participant management, preserve participants omitted from later email headers, and audit explicit additions/removals. Test unauthorized additions, removed-participant replies and future-only notifications to new participants. Verify CC replies reopen Resolved/Closed tickets and follow the same response-timer and Sunday rules as requester replies without postponing existing deadlines.
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
  **CC participants landed on 17 September (R25).** `eligibleParticipants` filters a Cc
  header to the exact approved domain - the lookalike cases the specification names are
  asserted, including `allcheckservices.com.example.org`, `mail.allcheckservices.com` and a
  display name spoofing the domain - excludes our own addresses, lower-cases and
  deduplicates. Its list splitter respects quoted display names, because a comma inside
  `"Rao, Ananya" <...>` is not a separator and splitting on it silently drops the
  colleague.
  The authorisation half is the point of the requirement. Everybody in the company is on
  the approved domain, so nothing about the ADDRESS stops a stranger threading onto a
  colleague's ticket - only membership does. `isTicketParticipant` admits the requester and
  current participants and nobody else; an unrelated same-domain sender is recorded
  `not_a_participant` with an audit entry rather than dropped, so IT can add them if they
  were right to try. A removed participant stops being admitted.
  Only the requester may add colleagues by email; a participant who tries is ignored and
  audited. Omitting somebody from a later Cc header never removes them. Participants are
  copied on every public reply - header and envelope both, since a colleague in the Cc line
  but missing from RCPT TO sees their own name on a message they never received - and never
  on an internal note. A participant's reply reopens a Resolved ticket without moving its
  deadline, asserted directly.
  IT manages the list from the ticket page; additions and removals are both audited.
  **Not done:** a new participant gets future replies and not the history, which is what
  R25 asks for - but there is no way to send them the history deliberately if IT wants to.

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
  **The oversized-file notice landed on 17 September.** `readAttachments` now names what
  the budget refused instead of stopping at the first one - a 6 MB video followed by a 40 KB
  screenshot delivers the screenshot - and the employee is told which files did not arrive
  and what the limit is. Queued with no `messages` row, deliberately: `first_response_at` is
  the earliest outbound message, so recording it would have an automatic size notice satisfy
  the four-hour response deadline. Sent once per ticket, claimed by a conditional UPDATE so
  two refused files in one email produce one email back.
- [x] T013 Implement durable outgoing mail intents, acknowledgement, delivery retries and visible failure states. Record SMTP acceptance with its timestamp, hold requested status transitions against the intent until acceptance, and apply each transition atomically with the acceptance record (R28). Match asynchronous bounces back to the accepted message and expose pending and bounce-paused states to IT. Test acceptance, permanent failure, retry idempotency and a bounce arriving after acceptance.
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
  **Both closed on 17 September.** `bouncedMessageIds` is now given the complete raw source
  rather than the extracted body, skips the report's OWN header block - its Message-ID
  belongs to the report and can never be in the outbox, so returning it first spent the
  caller's best guess on a guaranteed miss - and scans everything after it, which is where
  the `message/rfc822` part quoting the original lives.
  `POST /api/outbox/:id/resend` puts a bounced, failed or ambiguous row back in the queue
  and clears `accepted_at` with it. That is what re-anchors auto-close: a resolution that
  bounced and is resent counts its 72 hours from the delivery that arrived rather than the
  one that did not. Ambiguous rows are included deliberately - only a person can decide
  whether a send whose outcome was never learned should be tried again (PRD open point 4).
  The dashboard shows each stuck message with a Send again button.

- [~] T014 Test duplicate processing, malicious/unknown participants, malformed emails, oversized files and mid-processing failures.
  Covered: duplicate processing, twice over - `alreadyIngested` and the re-run of a whole
  poll, both asserted against a real database. Malicious and unknown participants - an
  unrelated same-domain sender refused, a removed participant refused, four lookalike
  domains refused, a display name spoofing the domain refused, and header injection through
  a Cc address refused by `mime.ts`. Oversized files, including that the notice fires once.
  Mid-processing failure, for the case that matters: a failed acknowledgement rolls the
  ticket back rather than leaving one nothing will ever acknowledge.
  Malformed messages are now driven through the pipeline: a From header with no address at
  all, an empty body with no subject, two messages with no Message-ID (the partial unique
  index exists for exactly that), and a References header that is only punctuation. Each
  produces the right outcome rather than an exception.
  **Not done:** malformed MIME specifically. The fake mailbox hands over already-parsed
  messages, so a broken multipart structure would need the IMAP layer itself faked rather
  than mocked - a fake IMAP server, not a module mock.

## Phase 3 — IT workflow

- [x] T015 Implement atomic least-open assignment, tie rotation, admin-only availability management, unassigned alerts and manual reassignment. Automatically redistribute the New/In Progress/Waiting tickets of an owner who is marked unavailable or whose account is disabled, using recalculated workloads; if no staff are available, unassign affected open tickets and alert admin. On availability restoration, automatically assign unassigned open tickets using the same rule without rebalancing existing assignments to available staff. Preserve deadlines/status, audit moves and notify new owners. Verify retries, concurrent changes, regular-staff UI/API restrictions, and the separation of availability from account access — including that disabling revokes access and redistributes while marking unavailable does not, that Resolved/Closed tickets keep their historical owner, and that re-enabling an account returns no redistributed tickets.
  Mostly done: fewest-open-tickets with round-robin tie-break, applied on ingest and
  through `POST /api/tickets/:id/assign`. Availability is admin-only, and marking someone
  unavailable redistributes their New/In Progress/Waiting tickets one at a time, re-reading
  workloads after each move — assigning them in one pass would dump the whole queue on
  whoever happened to be least loaded at the start. Deadlines and status are preserved, and
  new owners are notified. Resolved and Closed tickets keep their historical owner because
  only open statuses are selected.
  **Closed on 17 September**, except the last item. Account disabling revokes sessions and
  redistributes in one call, and is distinct from availability - which is the whole of R24's
  second half. Restoring availability assigns unowned open tickets and ONLY those: a ticket
  somebody else has started stays with them, because rebalancing mid-conversation is how two
  people answer the same employee. A ticket nobody can be assigned emails every admin, since
  an unassigned ticket has no assignee to remind and would otherwise sit silently until its
  deadline. Every move is audited, with the actor taken from the session. `assignable` ANDs
  availability with account access in one place, so no caller can forget the second half and
  hand work to a disabled account.
  **Assignment is now serialised**, by a transaction-scoped PostgreSQL advisory lock around
  the read-workloads / choose / assign sequence. Without it two assignments deciding at once
  both read the same workloads and both pick the same least-loaded person, who ends up with
  two tickets while somebody else gets none - the same hazard the outbox claim solves with
  FOR UPDATE SKIP LOCKED, which assignment had no equivalent of. An advisory lock rather
  than row locks because what is protected is a decision made from several tables, not any
  one row. Asserted by racing two assignments against two idle staff and requiring one each.
- [x] T016 Build shared ticket list/detail with All Tickets as the default, a My Tickets filter scoped to the signed-in assignee, search, composable filters, workload and overdue summaries. Include a manual Close action on Resolved tickets and a visible indicator for a transition still waiting on delivery.
  Done. All Tickets is the default page; My Tickets filters to the signed-in name, taken
  from the session rather than a picker. Search, status filter and a Needs-attention toggle
  compose. The queue header carries the counts that answer "what needs attention" - total,
  overdue, unassigned, awaiting a first response, and a breakdown by status - computed
  server-side, because counting rows in a UI is how that gets answered wrongly.
  The two specific items this task names were the ones missing. **Manual closure** of a
  Resolved ticket opens the composer rather than flipping a status: R19 wants the employee
  told and R28 wants the ticket to stay Resolved until that message is accepted, so it goes
  through the same machinery automatic closure uses. **The pending indicator** now says
  which status the ticket is waiting to become and that it changes on acceptance, not
  before - without it, pressing Resolve and seeing "New" reads as a fault, and the obvious
  response is to press it again. Failed, ambiguous and bounced messages each say so and
  offer Send again.
- [x] T017 Implement public dashboard replies, private internal notes and audit history. The dashboard is the only place IT composes a ticket message; there is no staff email relay.
  Mostly done: `POST /api/tickets/:id/reply` and `/note`. The reply is written to
  `messages` and queued in the outbox in one transaction — a reply shown in the dashboard
  that was never queued would have IT believing they answered. `addNote` contains no
  outbox statement at all, which is the structural guarantee that an internal note cannot
  reach employee email. There is no staff email relay: the only inbound path rejects staff
  mail like any other unauthorised sender.
  `author` comes from the session, never from the request body — verified by posting a
  reply claiming `author: "staff5"` and finding `staff1` recorded.
  **The audit history landed on 17 September**, as its own table rather than as messages.
  The two are different questions: `messages` is what was said, `audit_events` is who did
  what. It is shown beside the conversation on the ticket page, and includes assignment,
  status requests and applications, participant changes and resends.
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
- [x] T019 Test assignment concurrency, all-staff-unavailable, account disabling during active work, rejection of staff-authored inbound mail, and attachment access.
  Covered: all-staff-unavailable end to end, including that the ticket is left visibly
  unassigned and every admin is emailed. Account disabling during active work - the session
  is revoked, a request already in flight is refused, the open ticket has moved, and
  re-enabling returns nothing. Rejection of staff-authored inbound mail, both shapes: an
  unapproved sender and a reply to a one-way notification, which is the hard one because
  staff are on the approved domain. Attachment access requires a session and the stored
  filename is sanitised again on the way out.
  **Assignment concurrency is now covered too**: two assignments raced against two idle
  staff must hand out one each, which is what the advisory lock added in T015 guarantees.

- [x] T027 Add an admin-only Reply Templates section with reusable name/body records, seed the four agreed starter templates, and implement template selection/send for all staff using the normal public-reply flow. Allow staff to edit the selected message before sending without changing the saved template. Add the agreed send-time status mappings, preview the intended status, and allow admin-selected custom mappings with no-change as default. Verify admin authorization, draft/template isolation, transition/message validation, atomic outgoing intent and status updates, visible delivery failures, and that template changes preserve previously sent messages. A template-mapped transition is delivery-gated like any other and takes effect only on SMTP acceptance (R28).
  Done. `reply_templates` holds name, body and `maps_to`, with a CHECK that refuses Closed -
  R24 says closure is not a template action, and a constraint is a better guarantee of that
  than a comment. The four starter templates are seeded by name, so re-seeding refreshes
  their wording without duplicating them or touching anything the admin has added.
  "Troubleshooting steps" is deliberately left incomplete: the steps are issue-specific, and
  shipping plausible generic ones is how they get sent unedited. The composer refuses to
  send while the placeholder is still there.
  Reading templates is open to all five staff; writing is admin-only, enforced server-side
  and hidden in the UI - a button that exists and refuses reads as a fault.
  **The isolation R24 asks for is structural.** The body sent is always what is on screen,
  never the stored row: only the template's `maps_to` is read server-side. So editing a
  selected reply reaches the employee and leaves the shared wording alone, and editing the
  shared template afterwards cannot rewrite what has already been sent - the text was copied
  into `messages` and into the outbox payload at send time. Both directions are asserted.
  Sending "Working on it" applies In Progress at once, because that transition needs no
  email of its own. The other three are delivery-gated exactly like a manual transition:
  the ticket stays where it is, the outbox row carries `pending_status`, and
  `recordAcceptance` applies both in one transaction. The intended status is previewed
  before sending and selecting a template alone changes nothing.

## Phase 4 — Lifecycle and reminders

- [x] T020 Require an emailed information request before entering Waiting for Employee, and apply the transition only on SMTP acceptance of that message (R28), preserving status, deadline and reminders until then. Implement response episodes, repeated reminders, waiting behavior and admin/assignee recipient deduplication. Test that a pending or failed information request keeps reminders running.
  Done: Waiting for Employee is delivery-gated - `transitionRule` returns a `reply` intent
  for it, the API refuses an empty body, and the status does not move until the mail server
  accepts. Reminders repeat every four WORKING hours to the assignee and every admin, with
  the recipients deduplicated through a Set so an admin who is also the assignee is told
  once. A ticket whose information request is still pending or has failed keeps its status,
  its deadline and therefore its reminders, because none of them move until acceptance -
  that follows from the gating rather than from a separate rule.
  **Response episodes landed on 17 September.** "Answered" is now per episode rather than
  per ticket: the earliest outbound message AFTER the most recent inbound one. The obvious
  version - the earliest outbound message, full stop - answered the wrong question, because
  a ticket IT had ever replied to read as answered forever, so an employee who wrote back a
  week later was owed nothing and appeared on no overdue list.
  R16's two halves are one statement: a new employee message sets a new deadline only when
  IT has replied since the last one. A follow-up while a response is already owed leaves the
  existing deadline where it is - otherwise an anxious employee writing three times before
  anyone looks pushes their own deadline out each time, and the ticket needing attention most
  sinks down the overdue list. Reminders use the same definition. Twelve tests.
- [x] T021 Require a non-empty public resolution message when resolving, reject missing-message attempts, and implement resolution/closure emails, manual closure of Resolved tickets, automatic closure and reopening with owner retention/reassignment. Apply Resolved only on acceptance of the resolution email, anchor the 72 elapsed hours to that acceptance, keep the ticket Resolved after either closure route until the closure email is accepted, and pause automatic closure on a later resolution bounce until a resend is accepted (R19, R28).
  Mostly done: resolving requires a non-empty body (the API rejects an empty one), and the
  status moves only when the mail server accepts that message. The 72 elapsed hours are
  anchored to `outbox.accepted_at` on the resolution row, not to the button press —
  `ticketsReadyToClose` joins on it. Manual and automatic closure use the same machinery:
  both queue a `closure` intent carrying `pendingStatus`, so both leave the ticket Resolved
  until that email is accepted. A bounced resolution excludes the ticket from auto-close,
  and the assignee is notified. Reopening on an employee reply retains the owner.
  **Re-anchoring landed on 17 September**: resending clears `accepted_at`, so the 72 hours
  run from the delivery that arrived. Asserted directly - accepted long ago, ready to close;
  bounced, not ready; requeued, still not ready; accepted again now, not ready.
  **Reassignment on reopening landed on 17 September.** A reply reopens the ticket and keeps
  its owner, as R10 asks - but only if that owner can still work it. An account disabled
  since the ticket was resolved would otherwise own a live conversation nobody is reading,
  which is the failure redistribution exists to prevent arriving through a door
  redistribution does not watch. If nobody can take it, every admin is told.
- [~] T022 Test reminder job retries, unresolved clock transitions, weekends, repeated follow-ups and closure/reply races, and verify employee email text never invokes closure. Cover the delivery-gated cases: a resolution accepted late, a resolution that never sends, manual closure racing an employee reply, and a bounce-paused ticket that must not auto-close until a resend is accepted.
  Covered: repeated follow-ups on the four-working-hour schedule, including that a weekend
  pushes the next one to Monday rather than firing four times overnight; a resolution
  accepted late (the clock runs from acceptance, not the button press); a resolution that
  never sends (no acceptance, no anchor, no closure); a bounce-paused ticket, and now the
  resend that un-pauses it. Employee-facing text is asserted not to instruct closure by
  replying - the auto-close message says the opposite, that replying reopens the ticket.
  **Not done:** manual closure racing an employee reply. The reply reopens the ticket and
  the closure email may already be queued, so the employee can receive "we are closing this"
  immediately after writing in. This is PRD open point 3 and needs a decision before it
  needs a test.

## Phase 5 — Release preparation

- [x] T023 Add mail health, error visibility, storage monitoring, daily 02:00 IST backup jobs with 30-day recovery-point retention, admin failure alerts and operating documentation. Include restorable attachment bytes, private backup storage and safe pruning that preserves dependencies and the last usable backup.
  Mostly done: `/health` reports whether the mail loop is beating and distinguishes
  "switched off" from "died" — a watchdog that cannot tell those apart is one that gets
  ignored. `/status` exposes the checkpoint, row counts and outbox state by state, with
  every state reported as a number so a missing key cannot read as a healthy queue.
  `GET /api/outbox` surfaces everything needing a human: failed, ambiguous and bounced.
  Backups run at 02:00 IST with 30-day retention and prune only `.dump` files.
  **Closed on 17 September.** A recovery point is now two files taken together: the
  `pg_dump` and a `tar` of `STORAGE_DIR`. Both, because restoring the database alone gives
  an `attachments` table whose every row points at a file that is not there - a backup that
  looks complete and is not. Pruning keeps them together and keeps the newest dump however
  old it is, so a machine that was switched off for two months does not wake up and delete
  the only copy it has.
  `/status` reports bytes, file counts and free space for both directories, so a full disk
  is visible before it is a failed backup.
  Backup failure is recorded in the audit trail and reported by `/health`, which returns 503
  - deliberately NOT emailed. The alert channel for "the database could not be backed up"
  should not be the mail queue that lives in that database, and an outbox row needs a ticket
  to hang off.
  Operating documentation is `docs/operations.md`: what to run, what to watch, what to do
  when each thing goes wrong, the restore procedure, and deployment and rollback.
- [x] T024 Restore database and attachments from a retained recovery point in a test environment; verify message/attachment consistency, measure restore time and record evidence. Test backup failure alerts and retention without deleting production records.
  Mostly done for the database: `backup.db.test.ts` takes a real `pg_dump`, empties the
  database, restores it and checks the rows came back — and then checks the restored
  database can still accept a new ticket, because identity sequences are where a restore
  usually looks fine and is not. Runs in the gate, so it cannot quietly stop working.
  **Attachment consistency is now proved.** A test stores a real attachment, takes both
  halves of a recovery point, destroys the database AND the storage directory, restores
  both, and checks the row came back pointing at a file whose bytes are still there. Restore
  time is measured and logged rather than asserted against a threshold - a number that
  varies with the machine would make the test fail for reasons that are not bugs.
  **Not done:** backup failure alerting is not tested end to end. The failure path records
  an audit entry and flips `/health`, and both are exercised by hand, but nothing forces a
  failure in the gate.
- [~] T025 Run end-to-end acceptance with test accounts and mailbox; review all PRD requirements R01–R28 against results, including the delivery-gated transitions and the dashboard-only IT workflow.
  **The requirement review is written:** `docs/requirements-review.md` puts every requirement
  against its evidence, and distinguishes three things the word "done" hides — proved on this
  stack, asserted by the suite, and inherited from the Cloudflare deployment. It ends with the
  seven requirements that are not fully met, in one place.
  **The acceptance run has not happened**, and cannot until `MAIL_SEND` is turned on against a
  test mailbox that is not the live support address, with explicit authorisation naming the
  sender and the recipients. Every "Tested" rather than "Proved here" in that document for
  anything outbound is limited by exactly that. Inbound is proved.
- [~] T026 Prepare deployment and rollback instructions with concrete hosting costs and limitations for review.
  Written: `docs/operations.md` has what it needs (Node 24, PostgreSQL 18 with matching
  client binaries, outbound 993 and 465, TLS because the session cookie is Secure, process
  supervision), the limitations that matter before choosing a host (run ONE process - the
  ticker's mutual exclusion is in-process; storage must be persistent disk; sending is
  unproved on this stack), how to deploy a change, and how to roll code and database back.
  Rollback is honest about the asymmetry: migrations are forward-only by design, additive
  migrations are safe to leave in place while the code rolls back, and anything else means a
  restore from a recovery point taken BEFORE migrating.
  **Not done:** concrete hosting costs. The load is a mailbox poll every two minutes and
  five people on a dashboard, so this is one small VM and one small managed database - but a
  monthly figure depends entirely on the host, and no host has been chosen. Naming one would
  be inventing it. This stays open until hosting is decided, which is a standing deliberate
  deferral rather than an oversight.

External test messages require explicit authorization identifying test recipients/mailbox. This document does not send messages or deploy resources.
