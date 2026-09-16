# Provisional Technical Plan

Status: proposal, subject to feasibility tests and remaining product clarifications. It reflects the decisions approved on 16 September 2026 (PRD, “Approved 16 September 2026 — not implemented”); none of them is built.

## Candidate architecture

- Frontend: React + TypeScript + Vite + Fluent UI, as validated in the interactive prototype. Backend hosting remains subject to feasibility tests.
- Cloudflare Workers for API and scheduled jobs; static assets for dashboard.
- D1 for tickets, messages, accounts, reply templates, audit events, mail checkpoints, deadlines and outbox.
- Private R2 storage for attachments and potentially encrypted backup exports.
- Existing Zimbra mailbox via secure IMAP ingestion and authenticated SMTP submission; local verified TLS connectivity confirmed on IMAP 993 and SMTP 465; user-reported local authentication PASS; delivery and Cloudflare compatibility unverified.

This is a candidate, not a final stack selection. Do not change company mail routing or MX records as part of a prototype.

## Mandatory feasibility gate

1. Validate TLS IMAP and SMTP from the proposed runtime using a test mailbox. Cloudflare blocks outbound SMTP port 25; assess the server's authenticated submission support on 465/587 without assuming either is enabled.
2. Verify IMAP/SMTP client compatibility, polling/reconnection, message parsing, attachment size limits and CPU/memory use on Workers Free. It has a 10 ms CPU allowance per invocation; low daily traffic alone does not prove suitability.
3. Benchmark secure password verification and email parsing. Do not weaken password hashing to meet the free CPU allowance.
4. Verify two-minute scheduling, overlapping-run exclusion, retries and quota consumption.
5. Confirm R2 activation/billing requirements, D1 per-database limits, backup storage and recovery features before quoting a zero-cost deployment.
6. If native mail handling cannot meet requirements, compare a small mail bridge or inexpensive hosted service with the user. Do not silently add infrastructure.

## Processing design

At initial activation, persist the launch time, mailbox UIDVALIDITY and UIDNEXT boundary before processing; skip earlier mailbox messages without changing them. Persist the cutoff across restarts, catch up after downtime, and explicitly reconcile UIDVALIDITY changes without importing pre-launch mail. Use server arrival identity rather than the sender-controlled Date header for the launch boundary. Use mailbox UIDVALIDITY and UID plus stable message identity to deduplicate; persist checkpoints only after durable processing. Do not mark mail as handled before database and attachment results are durable. Bound message size before parsing. Quarantine malformed mail with a visible error for IT.

Match replies using stored Message-ID, In-Reply-To and References plus participant authorization. Use per-ticket routing identifiers if supported. Suppress autoresponder/bounce loops. Establish trusted Zimbra authentication evidence; do not trust a user-supplied From domain or forged Authentication-Results header on its own. Ingestion accepts employee and eligible CC participant mail only: there is no staff-mail path, so a staff member's own message to the support mailbox is handled like any other unauthorized sender, and a reply to an IT notification produces no ticket message. Send IT notifications from an address that does not feed ingestion, or with a reply-to that makes the dead end obvious, and suppress loops either way.

In one atomic database operation, record the ticket/message change and enqueue its outbound email intents. Use separate delivery processing with retries and a stable identifier. SMTP disconnect after acceptance can create delivery ambiguity; surface that state rather than claiming exactly-once mail delivery. Keep inbound employee messages, outgoing public replies and outbound IT notifications distinguishable.

A transition that R28 gates on delivery is stored as a requested transition against the outgoing intent, not as an applied status. The ticket keeps its current status, deadline and reminder schedule; the delivery worker applies the transition in one atomic step with the acceptance record, stamping the acceptance time. Resolution acceptance stamps the anchor the 72-hour auto-close clock counts from, so the clock lives on the accepted message, not on the button press. Closure, manual or automatic, follows the same path: Resolved until its closure email is accepted. Make applying a requested transition idempotent and conditional on the ticket still being in the status the request assumed, so retries and a concurrent employee reply cannot apply it twice or apply it to a ticket that has moved on. A permanent failure leaves the request unapplied and visible to IT.

Asynchronous bounces arrive after acceptance and must be matched back to the delivered message by its stable identifier plus DSN correlation. A bounce on an accepted resolution alerts assignee and admin and sets a pause flag the auto-close job checks; closure stays paused until IT resends and that message is accepted, which re-anchors the 72 hours. The pause must fail closed — an unmatched or malformed bounce should raise an IT-visible problem rather than silently letting closure proceed.

Serialize assignment selection with workload changes and tie-break cursor updates. When an admin marks a staff member unavailable, or disables their account, redistribute their open tickets through the same assignment operation, recalculating workload for every move. Account disabling additionally revokes sessions and sign-in; keep that revocation in the same transaction as the redistribution so a disabled account can neither work nor hold tickets. Preserve deadlines and status; make tickets unassigned and alert admin if no recipient is available. When staff become available, assign unassigned open tickets using the same operation; leave existing assignments to available staff intact. Ensure retries do not duplicate assignment audit events or notification intents. Use conditional transitions/version checks for reassignment, resolution, auto-close and reopening.

Store a response episode anchored to first unanswered employee message, next reminder due, and response completion state. A response counts as given at SMTP acceptance of a public reply, so the episode closes on the same event R28 gates transitions on. Evaluate business time centrally in Asia/Kolkata; persist UTC timestamps. The 72-hour auto-close window is elapsed time, not business time, and is the one clock that ignores the calendar. Settle PRD open points 3 and 4 before finalizing the state machine.

## Security and operations

Separate staff login from Zimbra. Secure password hashing, hashed single-use email challenges, throttled attempts, secure HttpOnly cookies, CSRF protection, session invalidation and account recovery need implementation. Store mailbox secrets outside source control. Private attachments require server-side authorization, safe names and download headers. Audit security/admin events in addition to required ticket changes.

Notification emails to IT carry a dashboard deep link to the ticket and no internal-note content; the link lands on authentication, never on ticket content, when the recipient has no session. Expose last successful mailbox poll, failed outgoing mail, pending transitions blocked on delivery, bounce-paused closures, unassigned tickets and storage usage to admin. Run backups daily at 02:00 IST with 30-day recovery-point retention. Back up the database and actual attachment bytes with a verified manifest. Use incremental immutable attachment copies to avoid storing 30 full duplicates while preserving every retained recovery point. Keep backups separately protected from production deletion permissions; storage provider and cost remain unverified. Alert admin on failure and preserve the last usable recovery point. Document restoration and test a full database-and-attachment restore before launch. Target at most 24 hours of data loss under successful daily operation; measure recovery time before committing to a restore-time target. Indefinite retention applies to production records, not an unlimited count of backup copies.

## Sources checked 16 September 2026

- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/): free 100,000 requests/day, 10 ms CPU/invocation.
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/): free 5 GB total account storage; check separate per-database limits.
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/): standard free tier 10 GB-month storage, with operation allowances; overages billable.
- [TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/): outbound port 25 blocked.
- [Spec Kit](https://github.com/github/spec-kit): specification-driven project workflow.

Local unauthenticated Zimbra connectivity checks have run: TLS verification passed on ports 993 and 465. The user subsequently reported PASS for the local IMAP/SMTP authentication checker. No message sending or Cloudflare account tests have run. See [validation evidence](../../docs/stack-validation.md). D1 Free is limited to 500 MB per database and seven days of native Time Travel; separate exports are required for the agreed 30-day backup window.
