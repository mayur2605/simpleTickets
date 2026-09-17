# Technical Plan

> **Status, 17 September 2026: implemented.** This was a proposal subject to a feasibility
> gate. The gate has been run, it failed on Cloudflare, and the stack moved. The
> processing, threading, idempotency and delivery-gating design below is unchanged and is
> what `server/` implements — that design was never the problem. Only the runtime changed.
>
> Read `docs/superpowers/specs/2026-09-17-local-replatform-design.md` for why, and
> `docs/stack-validation.md` for the measurements.

## Architecture, as built

- **Frontend:** React 19 + TypeScript + Vite + Fluent UI v9. Built output is served by the
  server itself, so the API is same-origin: the session cookie works with no CORS and the
  browser bundle carries no credential.
- **Backend:** one Node 24 process. HTTP via Hono, the two-minute mail loop via
  `setInterval`, both sharing one connection pool.
- **Database:** PostgreSQL 18 for tickets, messages, accounts, sessions, mail checkpoints,
  deadlines, the outbox and the attachment index.
- **Files:** the local filesystem under `STORAGE_DIR` for attachments and for the raw
  RFC822 source of every message examined; `BACKUP_DIR` for nightly `pg_dump` output.
- **Mail:** Gmail IMAP and SMTP with an App Password, reaching
  `simpleticketssupport@gmail.com`, which `support@allcheckservices.com` forwards to.

No cloud dependency of any kind. Production hosting is deliberately undecided — a plain
Node application deploys anywhere, so nothing is lost by deferring it.

## How the feasibility gate resolved

Each item was a real question. All six are now answered with evidence.

1. **TLS IMAP and SMTP from the runtime.** Failed on Cloudflare for Zimbra — the mail host
   dropped Workers traffic on 993, 465 and 587, while `imap.gmail.com:993` connected from
   the same Worker in 68 ms. Passed for Gmail, which is what shipped. Worth retesting
   Zimbra from this machine: the constraint was Cloudflare's origin, and it is gone.
2. **Client compatibility, parsing, attachment limits, CPU.** The 10 ms CPU allowance and
   the `nodejs_compat` quirks (stalled UID ranges, absent `Buffer`) are moot. Attachment
   CPU and memory for 5 MB messages is still **not measured** — it is the one item here
   that remains genuinely open.
3. **Benchmark password verification, without weakening hashing.** Answered twice. On
   Workers the cap forced chained PBKDF2 at ~124 ms. On Node it is scrypt — memory-hard,
   64 MB per guess, 252 ms measured. The hashing was strengthened, not weakened.
4. **Two-minute scheduling, overlapping-run exclusion, retries.** Cloudflare cron never
   fired on this account at all. `setInterval` plus the `Ticker`'s `#running` flag gives
   the schedule and the mutual exclusion; `FOR UPDATE SKIP LOCKED` gives the outbox the
   lock D1 could not.
5. **R2/D1 limits, backup and recovery.** Moot. `pg_dump` nightly with 30-day retention,
   and a test that restores a real dump into an emptied database. **Still open:** the
   backups sit on the same disk as the database.
6. **Compare alternatives rather than silently adding infrastructure.** This is what
   happened: four mail transports were tried and closed with evidence, and the runtime was
   replaced rather than worked around further.

## Processing design

At initial activation, persist the launch time, mailbox UIDVALIDITY and UIDNEXT boundary before processing; skip earlier mailbox messages without changing them. Persist the cutoff across restarts, catch up after downtime, and explicitly reconcile UIDVALIDITY changes without importing pre-launch mail. Use server arrival identity rather than the sender-controlled Date header for the launch boundary. Use mailbox UIDVALIDITY and UID plus stable message identity to deduplicate; persist checkpoints only after durable processing. Do not mark mail as handled before database and attachment results are durable. Bound message size before parsing. Quarantine malformed mail with a visible error for IT.

Match replies using stored Message-ID, In-Reply-To and References plus participant authorization. **Implemented, with one addition the plan did not anticipate:** threading deliberately ignores a notification's own Message-ID. IT staff are on the approved sender domain, so a staff member replying to a one-way notification produces a message indistinguishable from the employee's, and it would otherwise be appended to the ticket — restarting the response clock and reopening a resolved ticket. Use per-ticket routing identifiers if supported. Suppress autoresponder/bounce loops. Establish trusted Zimbra authentication evidence; do not trust a user-supplied From domain or forged Authentication-Results header on its own. Ingestion accepts employee and eligible CC participant mail only: there is no staff-mail path, so a staff member's own message to the support mailbox is handled like any other unauthorized sender, and a reply to an IT notification produces no ticket message. Send IT notifications from an address that does not feed ingestion, or with a reply-to that makes the dead end obvious, and suppress loops either way.

In one atomic database operation, record the ticket/message change and enqueue its outbound email intents. Use separate delivery processing with retries and a stable identifier. SMTP disconnect after acceptance can create delivery ambiguity; surface that state rather than claiming exactly-once mail delivery. Keep inbound employee messages, outgoing public replies and outbound IT notifications distinguishable.

A transition that R28 gates on delivery is stored as a requested transition against the outgoing intent, not as an applied status. The ticket keeps its current status, deadline and reminder schedule; the delivery worker applies the transition in one atomic step with the acceptance record, stamping the acceptance time. Resolution acceptance stamps the anchor the 72-hour auto-close clock counts from, so the clock lives on the accepted message, not on the button press. Closure, manual or automatic, follows the same path: Resolved until its closure email is accepted. Make applying a requested transition idempotent and conditional on the ticket still being in the status the request assumed, so retries and a concurrent employee reply cannot apply it twice or apply it to a ticket that has moved on. A permanent failure leaves the request unapplied and visible to IT.

Asynchronous bounces arrive after acceptance and must be matched back to the delivered message by its stable identifier plus DSN correlation. A bounce on an accepted resolution alerts assignee and admin and sets a pause flag the auto-close job checks; closure stays paused until IT resends and that message is accepted, which re-anchors the 72 hours. The pause must fail closed — an unmatched or malformed bounce should raise an IT-visible problem rather than silently letting closure proceed.

Serialize assignment selection with workload changes and tie-break cursor updates. When an admin marks a staff member unavailable, or disables their account, redistribute their open tickets through the same assignment operation, recalculating workload for every move. Account disabling additionally revokes sessions and sign-in; keep that revocation in the same transaction as the redistribution so a disabled account can neither work nor hold tickets. Preserve deadlines and status; make tickets unassigned and alert admin if no recipient is available. When staff become available, assign unassigned open tickets using the same operation; leave existing assignments to available staff intact. Ensure retries do not duplicate assignment audit events or notification intents. Use conditional transitions/version checks for reassignment, resolution, auto-close and reopening.

Store a response episode anchored to first unanswered employee message, next reminder due, and response completion state. A response counts as given at SMTP acceptance of a public reply, so the episode closes on the same event R28 gates transitions on. Evaluate business time centrally in Asia/Kolkata; persist UTC timestamps. The 72-hour auto-close window is elapsed time, not business time, and is the one clock that ignores the calendar. Settle PRD open points 3 and 4 before finalizing the state machine.

## Security and operations

Separate staff login from Zimbra. **Built:** scrypt password hashing with parameters recorded in each stored value, per-account throttling with a lockout window, HttpOnly/Secure/SameSite=Strict cookies whose tokens are stored hashed, expiry swept on each new session, and sign-out that deletes the session row. SameSite=Strict is the CSRF defence. **Not built:** hashed single-use email challenges and account recovery — an admin resets a password, and the first one is set from the command line because no API path may mint the first credential. Store mailbox secrets outside source control — `server/.env`, git-ignored, and the pre-commit hook refuses to stage any `.env` file. Private attachments require server-side authorization, safe names and download headers. Audit security/admin events in addition to required ticket changes.

Notification emails to IT carry a dashboard deep link to the ticket and no internal-note content; the link lands on authentication, never on ticket content, when the recipient has no session. Expose last successful mailbox poll, failed outgoing mail, pending transitions blocked on delivery, bounce-paused closures, unassigned tickets and storage usage to admin. Run backups daily at 02:00 IST with 30-day recovery-point retention. **Built for the database** (`pg_dump --format=custom`, pruned by age, restore exercised by a test). **Not built for attachment bytes:** they live on disk under `STORAGE_DIR` and are not yet copied anywhere, so a disk loss takes them. Attachment backup and an off-machine copy of both are the remaining work here. Use incremental immutable attachment copies to avoid storing 30 full duplicates while preserving every retained recovery point. Keep backups separately protected from production deletion permissions; storage provider and cost remain unverified. Alert admin on failure and preserve the last usable recovery point. Document restoration and test a full database-and-attachment restore before launch. Target at most 24 hours of data loss under successful daily operation; measure recovery time before committing to a restore-time target. Indefinite retention applies to production records, not an unlimited count of backup copies.

## Sources checked 16 September 2026

These describe the Cloudflare stack and are retained as the record of why it was rejected,
not as current architecture.

- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/): free 100,000 requests/day, 10 ms CPU/invocation.
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/): free 5 GB total account storage; check separate per-database limits.
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/): standard free tier 10 GB-month storage, with operation allowances; overages billable.
- [TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/): outbound port 25 blocked.
- [Spec Kit](https://github.com/github/spec-kit): specification-driven project workflow.

See [validation evidence](../../docs/stack-validation.md) for the full measurement
history, including everything Cloudflare cost and what replacing it fixed.
