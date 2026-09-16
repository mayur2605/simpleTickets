# Implementation Tasks

Status: production implementation tasks remain open. A local prototype privacy regression was fixed and verified; see [takeover review](../../docs/takeover-review.md). The [runtime acceptance plan](../../docs/runtime-feasibility.md) is prepared, but T003/T004 remain unimplemented and unverified.

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
- [ ] T007 Model accounts, tickets, messages, attachments, audit events, inbox deduplication, outbox, deadlines and sessions; add integrity constraints.
- [ ] T008 Implement admin-provisioned accounts, password plus email-code sign-in, authorization and recovery; test expiry, reuse, brute-force limits and disabled accounts.
- [x] T009 Implement shared business calendar and deadline calculation; test all spec boundary examples and Sunday new-ticket/reply behavior and preservation of earlier pending deadlines.
  Done: `prototype/src/domain/business-calendar.ts`, 19 passing Vitest cases covering the four spec examples, the working-window boundaries at 09:00/18:00, Saturday-to-Monday carry, and the no-postponement rule. Domain rule only — no ticket store consumes it yet; wiring belongs to T007/T016.

## Phase 2 — Employee email flow

- [ ] T010 Implement two-minute mailbox polling, lease/checkpoint recovery and idempotency. Persist a one-time launch cutoff that excludes existing read/unread mail without modifying it. Test mail arriving during activation, restarts, downtime catch-up and UIDVALIDITY changes without resetting the cutoff.
- [ ] T011 Implement sender validation, safe body parsing, participant-aware threading and loop suppression. Preserve eligible employee CC recipients for public replies, deduplicate recipients and exclude the support mailbox; restrict CC recipients to the exact allcheckservices.com domain and accept threaded replies from those authorized CC participants. Test external addresses, mixed-case domains, lookalike suffixes, authorized CC replies and unrelated same-domain senders. Implement requester-only email CC additions and IT dashboard participant management, preserve participants omitted from later email headers, and audit explicit additions/removals. Test unauthorized additions, removed-participant replies and future-only notifications to new participants. Verify CC replies reopen Resolved/Closed tickets and follow the same response-timer and Sunday rules as requester replies without postponing existing deadlines.
- [ ] T012 Implement private attachments and 5 MB aggregate limit with body preservation and oversized-file notices.
- [ ] T013 Implement durable outgoing mail intents, acknowledgement, delivery retries and visible failure states.
- [ ] T014 Test duplicate processing, malicious/unknown participants, malformed emails, oversized files and mid-processing failures.

## Phase 3 — IT workflow

- [ ] T015 Implement atomic least-open assignment, tie rotation, admin-only availability management, unassigned alerts and manual reassignment. Automatically redistribute an unavailable owner’s New/In Progress/Waiting tickets using recalculated workloads; if no staff are available, unassign affected open tickets and alert admin. On availability restoration, automatically assign unassigned open tickets using the same rule without rebalancing existing assignments to available staff. Preserve deadlines/status, audit moves and notify new owners. Verify retries, concurrent changes, regular-staff UI/API restrictions and separation of availability from account access.
- [ ] T016 Build shared ticket list/detail with All Tickets as the default, a My Tickets filter scoped to the signed-in assignee, search, composable filters, workload and overdue summaries.
- [ ] T017 Implement public dashboard replies, staff email relay, private internal notes and audit history.
- [ ] T018 Implement assignment/employee-reply notifications and verify reply routing without loops or private-note disclosure.
- [ ] T019 Test assignment concurrency, all-staff-unavailable, staff email authorization and attachment access.

- [ ] T027 Add an admin-only Reply Templates section with reusable name/body records, seed the four agreed starter templates, and implement template selection/send for all staff using the normal public-reply flow. Allow staff to edit the selected message before sending without changing the saved template. Add the agreed send-time status mappings, preview the intended status, and allow admin-selected custom mappings with no-change as default. Verify admin authorization, draft/template isolation, transition/message validation, atomic outgoing intent and status updates, visible delivery failures, and that template changes preserve previously sent messages.

## Phase 4 — Lifecycle and reminders

- [ ] T020 Require an emailed information request before entering Waiting for Employee; implement response episodes, repeated reminders, waiting behavior and admin/assignee recipient deduplication.
- [ ] T021 Require a non-empty public resolution message when resolving, reject missing-message attempts, and implement resolution/closure emails, 72-hour closure and reopening with owner retention/reassignment.
- [ ] T022 Test reminder job retries, unresolved clock transitions, weekends, repeated follow-ups and closure/reply races, and verify employee email text never invokes closure.

## Phase 5 — Release preparation

- [ ] T023 Add mail health, error visibility, storage monitoring, daily 02:00 IST backup jobs with 30-day recovery-point retention, admin failure alerts and operating documentation. Include restorable attachment bytes, private backup storage and safe pruning that preserves dependencies and the last usable backup.
- [ ] T024 Restore database and attachments from a retained recovery point in a test environment; verify message/attachment consistency, measure restore time and record evidence. Test backup failure alerts and retention without deleting production records.
- [ ] T025 Run end-to-end acceptance with test accounts and mailbox; review all PRD requirements against results.
- [ ] T026 Prepare deployment and rollback instructions with concrete hosting costs and limitations for review.

External test messages require explicit authorization identifying test recipients/mailbox. This document does not send messages or deploy resources.
