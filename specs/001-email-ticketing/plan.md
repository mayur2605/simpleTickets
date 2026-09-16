# Provisional Technical Plan

Status: proposal, subject to feasibility tests and remaining product clarifications.

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

Match replies using stored Message-ID, In-Reply-To and References plus participant authorization. Use per-ticket routing identifiers if supported. Suppress autoresponder/bounce loops. Establish trusted Zimbra authentication evidence; do not trust a user-supplied From domain or forged Authentication-Results header on its own.

In one atomic database operation, update ticket/message state and enqueue outbound email intents. Use separate delivery processing with retries and a stable identifier. SMTP disconnect after acceptance can create delivery ambiguity; surface that state rather than claiming exactly-once mail delivery. Keep received and relayed messages distinguishable.

Serialize assignment selection with workload changes and tie-break cursor updates. When an admin marks a staff member unavailable, redistribute their open tickets through the same assignment operation, recalculating workload for every move. Preserve deadlines and status; make tickets unassigned and alert admin if no recipient is available. When staff become available, assign unassigned open tickets using the same operation; leave existing assignments to available staff intact. Ensure retries do not duplicate assignment audit events or notification intents. Use conditional transitions/version checks for reassignment, resolution, auto-close and reopening.

Store a response episode anchored to first unanswered employee message, next reminder due, and response completion state. Evaluate business time centrally in Asia/Kolkata; persist UTC timestamps. Resolve the PRD's transition ambiguities before finalizing the state machine.

## Security and operations

Separate staff login from Zimbra. Secure password hashing, hashed single-use email challenges, throttled attempts, secure HttpOnly cookies, CSRF protection, session invalidation and account recovery need implementation. Store mailbox secrets outside source control. Private attachments require server-side authorization, safe names and download headers. Audit security/admin events in addition to required ticket changes.

Expose last successful mailbox poll, failed outgoing mail, unassigned tickets and storage usage to admin. Run backups daily at 02:00 IST with 30-day recovery-point retention. Back up the database and actual attachment bytes with a verified manifest. Use incremental immutable attachment copies to avoid storing 30 full duplicates while preserving every retained recovery point. Keep backups separately protected from production deletion permissions; storage provider and cost remain unverified. Alert admin on failure and preserve the last usable recovery point. Document restoration and test a full database-and-attachment restore before launch. Target at most 24 hours of data loss under successful daily operation; measure recovery time before committing to a restore-time target. Indefinite retention applies to production records, not an unlimited count of backup copies.

## Sources checked 16 September 2026

- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/): free 100,000 requests/day, 10 ms CPU/invocation.
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/): free 5 GB total account storage; check separate per-database limits.
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/): standard free tier 10 GB-month storage, with operation allowances; overages billable.
- [TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/): outbound port 25 blocked.
- [Spec Kit](https://github.com/github/spec-kit): specification-driven project workflow.

Local unauthenticated Zimbra connectivity checks have run: TLS verification passed on ports 993 and 465. The user subsequently reported PASS for the local IMAP/SMTP authentication checker. No message sending or Cloudflare account tests have run. See [validation evidence](../../docs/stack-validation.md). D1 Free is limited to 500 MB per database and seven days of native Time Travel; separate exports are required for the agreed 30-day backup window.
