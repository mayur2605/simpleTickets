# Implementation Tasks

Status: the ingestion half of Phase 2 is now partly built and deployed (T010); everything
else remains open. Mail transport was changed on 17 September 2026 to Gmail IMAP polling —
read the "Architecture decision" section of `AGENTS.md` first, because it **reverses** the
Resend decision recorded earlier that day and makes this document's polling design current
again rather than superseded. The eight decisions approved on 16 September 2026 (PRD, “Approved 16 September 2026 — not implemented”) are folded into the tasks below; no task has started on any of them. A local prototype privacy regression was fixed and verified; see [takeover review](../../docs/takeover-review.md). The [runtime acceptance plan](../../docs/runtime-feasibility.md) is prepared, but T003/T004 remain unimplemented and unverified.

## Phase 0 — Foundation and feasibility

- [ ] T001 Resolve open product questions from the PRD one at a time; update acceptance examples.
- [ ] T002 Install and initialize official GitHub Spec Kit with a supported agent integration, preserving authored documents; verify CLI/runtime and record version.
- [ ] T003 Prove test-mailbox IMAP/SMTP round trip from candidate runtime; record TLS, routing and compatibility findings without secrets.
- [ ] T004 Benchmark representative mail, maximum permitted attachments and secure password verification against free runtime limits.
- [ ] T005 Confirm hosting, storage, backup/restore design and cost assumptions; finalize plan.

- [ ] T028 Extend strict type/lint/format/CI gates to the production backend, add test-first domain and integration suites, and migrate prototype CSS to mobile-first with accessibility and cross-browser validation. See docs/engineering-standards.md.
  Progress: domain unit suite added to the gate (T009). Name/role/value fixed for the sidebar nav, queue filter tabs and the ticket table's scroll region, asserted in the browser smoke test. Still open: desktop-first CSS migration, full keyboard journeys, 200% zoom, screen-reader passes, forced colours, touch targets, and Firefox/WebKit.

## Phase 1 — Shared foundation

- [ ] T006 Scaffold selected application, local configuration, secret handling, migrations and development instructions.
- [ ] T007 Model accounts (with an enabled/disabled state), tickets, messages, attachments, audit events, inbox deduplication, outbox with per-intent delivery state and acceptance time, requested-but-unapplied transitions, deadlines, the auto-close anchor and its bounce pause, and sessions; add integrity constraints.
- [ ] T008 Implement admin-provisioned accounts, password plus email-code sign-in, authorization and recovery; test expiry, reuse, brute-force limits and disabled accounts. Disabling an account must revoke sessions and sign-in and trigger the T015 redistribution in the same operation.
- [x] T009 Implement shared business calendar and deadline calculation; test all spec boundary examples and Sunday new-ticket/reply behavior and preservation of earlier pending deadlines.
  Done: `prototype/src/domain/business-calendar.ts`, 19 passing Vitest cases covering the four spec examples, the working-window boundaries at 09:00/18:00, Saturday-to-Monday carry, and the no-postponement rule. Domain rule only — no ticket store consumes it yet; wiring belongs to T007/T016.

## Phase 2 — Employee email flow

- [~] T010 Implement two-minute mailbox polling, lease/checkpoint recovery and idempotency. Persist a one-time launch cutoff that excludes existing read/unread mail without modifying it. Test mail arriving during activation, restarts, downtime catch-up and UIDVALIDITY changes without resetting the cutoff.
  Partly done, deployed in `worker/`. Built and proved against the real mailbox: IMAP polling of `simpleticketssupport@gmail.com` via `imapflow` under `nodejs_compat`; a UIDVALIDITY/UID checkpoint in `mailbox_state`; idempotency by `ingest_log.uid` as primary key, written in the same D1 batch as the ticket and message so they commit together; the R27 launch cutoff as `uidNext - 1` adopted on first run; sender validation against the exact `allcheckservices.com` domain; and HTML-to-text body extraction. Real emails have become real tickets.
  **Not done, and T010 cannot be closed until they are:** the two-minute cron has never been observed firing — every ticket so far came from a manual `POST /poll`, and the trigger is under measurement (see `docs/stack-validation.md`, "Cron trigger"). There is no lease, so two overlapping runs are only safe by idempotency, not by exclusion. Downtime catch-up, restart and UIDVALIDITY-change behaviour are reasoned about but **untested**: `worker/` has 17 passing Vitest cases, but they cover `domain.ts` only — sender authorisation, address extraction and HTML-to-text. There is no test of `imap.ts`, `store.ts` or `index.ts`, so checkpoint recovery, idempotency under overlap and the launch cutoff are proved by reasoning and one manual run, not by a suite. `worker/` also has its own `npm run verify` that no CI workflow runs, so T028's gate does not yet cover the backend. Nothing consumes the tickets: the dashboard is still in-memory and unconnected.
- [ ] T011 Implement sender validation, safe body parsing, participant-aware threading and loop suppression. Preserve eligible employee CC recipients for public replies, deduplicate recipients and exclude the support mailbox; restrict CC recipients to the exact allcheckservices.com domain and accept threaded replies from those authorized CC participants. Test external addresses, mixed-case domains, lookalike suffixes, authorized CC replies and unrelated same-domain senders. Implement requester-only email CC additions and IT dashboard participant management, preserve participants omitted from later email headers, and audit explicit additions/removals. Test unauthorized additions, removed-participant replies and future-only notifications to new participants. Verify CC replies reopen Resolved/Closed tickets and follow the same response-timer and Sunday rules as requester replies without postponing existing deadlines.
- [ ] T012 Implement private attachments and 5 MB aggregate limit with body preservation and oversized-file notices.
- [ ] T013 Implement durable outgoing mail intents, acknowledgement, delivery retries and visible failure states. Record SMTP acceptance with its timestamp, hold requested status transitions against the intent until acceptance, and apply each transition atomically with the acceptance record (R28). Match asynchronous bounces back to the accepted message and expose pending and bounce-paused states to IT. Test acceptance, permanent failure, retry idempotency and a bounce arriving after acceptance.
- [ ] T014 Test duplicate processing, malicious/unknown participants, malformed emails, oversized files and mid-processing failures.

## Phase 3 — IT workflow

- [ ] T015 Implement atomic least-open assignment, tie rotation, admin-only availability management, unassigned alerts and manual reassignment. Automatically redistribute the New/In Progress/Waiting tickets of an owner who is marked unavailable or whose account is disabled, using recalculated workloads; if no staff are available, unassign affected open tickets and alert admin. On availability restoration, automatically assign unassigned open tickets using the same rule without rebalancing existing assignments to available staff. Preserve deadlines/status, audit moves and notify new owners. Verify retries, concurrent changes, regular-staff UI/API restrictions, and the separation of availability from account access — including that disabling revokes access and redistributes while marking unavailable does not, that Resolved/Closed tickets keep their historical owner, and that re-enabling an account returns no redistributed tickets.
- [ ] T016 Build shared ticket list/detail with All Tickets as the default, a My Tickets filter scoped to the signed-in assignee, search, composable filters, workload and overdue summaries. Include a manual Close action on Resolved tickets and a visible indicator for a transition still waiting on delivery.
- [ ] T017 Implement public dashboard replies, private internal notes and audit history. The dashboard is the only place IT composes a ticket message; there is no staff email relay.
- [ ] T018 Implement assignment, employee-reply and overdue notifications to IT, each linking to the ticket in the dashboard. Verify they carry no internal-note content, that a reply to one is not ingested and satisfies no response deadline, and that rejecting staff-authored mail to the support mailbox starts no loop.
- [ ] T019 Test assignment concurrency, all-staff-unavailable, account disabling during active work, rejection of staff-authored inbound mail, and attachment access.

- [ ] T027 Add an admin-only Reply Templates section with reusable name/body records, seed the four agreed starter templates, and implement template selection/send for all staff using the normal public-reply flow. Allow staff to edit the selected message before sending without changing the saved template. Add the agreed send-time status mappings, preview the intended status, and allow admin-selected custom mappings with no-change as default. Verify admin authorization, draft/template isolation, transition/message validation, atomic outgoing intent and status updates, visible delivery failures, and that template changes preserve previously sent messages. A template-mapped transition is delivery-gated like any other and takes effect only on SMTP acceptance (R28).

## Phase 4 — Lifecycle and reminders

- [ ] T020 Require an emailed information request before entering Waiting for Employee, and apply the transition only on SMTP acceptance of that message (R28), preserving status, deadline and reminders until then. Implement response episodes, repeated reminders, waiting behavior and admin/assignee recipient deduplication. Test that a pending or failed information request keeps reminders running.
- [ ] T021 Require a non-empty public resolution message when resolving, reject missing-message attempts, and implement resolution/closure emails, manual closure of Resolved tickets, automatic closure and reopening with owner retention/reassignment. Apply Resolved only on acceptance of the resolution email, anchor the 72 elapsed hours to that acceptance, keep the ticket Resolved after either closure route until the closure email is accepted, and pause automatic closure on a later resolution bounce until a resend is accepted (R19, R28).
- [ ] T022 Test reminder job retries, unresolved clock transitions, weekends, repeated follow-ups and closure/reply races, and verify employee email text never invokes closure. Cover the delivery-gated cases: a resolution accepted late, a resolution that never sends, manual closure racing an employee reply, and a bounce-paused ticket that must not auto-close until a resend is accepted.

## Phase 5 — Release preparation

- [ ] T023 Add mail health, error visibility, storage monitoring, daily 02:00 IST backup jobs with 30-day recovery-point retention, admin failure alerts and operating documentation. Include restorable attachment bytes, private backup storage and safe pruning that preserves dependencies and the last usable backup.
- [ ] T024 Restore database and attachments from a retained recovery point in a test environment; verify message/attachment consistency, measure restore time and record evidence. Test backup failure alerts and retention without deleting production records.
- [ ] T025 Run end-to-end acceptance with test accounts and mailbox; review all PRD requirements R01–R28 against results, including the delivery-gated transitions and the dashboard-only IT workflow.
- [ ] T026 Prepare deployment and rollback instructions with concrete hosting costs and limitations for review.

External test messages require explicit authorization identifying test recipients/mailbox. This document does not send messages or deploy resources.
