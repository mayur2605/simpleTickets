# Feature Specification: Email-based Internal IT Ticketing

Feature: 001-email-ticketing · Status: Draft · 16 September 2026

Canonical requirement IDs and open questions: [PRD](../../docs/PRD.md).

The eight decisions approved on 16 September 2026 (PRD, “Approved 16 September 2026 — not implemented”) are reflected in the scenarios below. None of them is implemented.

## User story 1 — Employee submits and follows up (P1)

An employee emails support and receives a ticket number. Further replies stay in the same conversation.

Acceptance scenarios:

1. A valid new employee message creates one Normal/New ticket and one acknowledgement intent (R01–R03, R11).
2. Reprocessing the same mailbox message does not create a duplicate ticket, comment or acknowledgement intent.
3. A reply with valid thread references and an authorized participant appends to the existing ticket. Merely knowing a ticket number is insufficient.
4. A non-approved sender does not create a ticket. Rejection handling must avoid automatic bounce loops.
5. Attachments within 5 MB total are retained privately. An oversized initial email still creates a ticket with its body and an email request for smaller files (R12).
6. Repeated employee messages do not move an existing unanswered deadline later (R16).
7. Public ticket replies include eligible people CC’d on the employee’s email (R25). Deduplicate recipients and exclude the support mailbox to avoid loops. Internal notes are never sent to CC recipients. Only exact allcheckservices.com-domain CC addresses are eligible; external-domain CC addresses receive no outgoing ticket email. Match domains case-insensitively and reject lookalike suffixes such as allcheckservices.com.example.org. An eligible company-domain CC participant can reply and append a message to the same ticket using validated thread references and participant authorization. A company-domain address not on the ticket is not automatically authorized merely by knowing its number. CC participant replies follow the same lifecycle and response-clock rules as requester replies: reopen Resolved/Closed tickets, require an IT response, preserve an existing earlier unanswered deadline, and apply the Sunday exception to new response episodes. The requester may add company colleagues via CC on later authenticated replies; other CC participants cannot add participants through email. IT can manage participants in the dashboard. Missing CC addresses on a later email do not remove existing participants; removal requires an explicit IT action. Newly added participants receive future public replies without an automatic history export. Removed participants lose future delivery and reply authorization unless re-added. Record participant changes with actor and time.

8. On initial launch, establish a durable mailbox cutoff and process only newly arriving messages. Existing read and unread mail is excluded without deletion or modification. Restarting the service resumes the stored checkpoint and catches up on post-launch mail; it must not establish a new cutoff and skip downtime arrivals. UIDVALIDITY changes require reconciliation preserving the original launch boundary and deduplication.

## User story 2 — IT handles a shared queue (P1)

Any of the five IT staff can handle any ticket in the dashboard. Email is the employee interface; staff never work a ticket from their own mailbox (R04).

Acceptance scenarios:

1. Assignment uses the smallest New/In Progress/Waiting workload among available staff; ties rotate fairly (R07).
2. With all staff unavailable, create an unassigned ticket and alert admin (R08). When the admin marks an owner unavailable, redistribute their New, In Progress and Waiting for Employee tickets to available staff using the normal assignment rule and recalculating workloads after each move. If none are available, make affected open tickets unassigned and alert admin. Preserve status, priority, conversation and existing deadlines. Audit each change and notify each new owner. Resolved/Closed tickets keep their historical owner until normal reopening rules apply. Disabling a staff account redistributes that person's open tickets through the same path with the same preservation, audit and notification behavior, and ends their dashboard access and sessions; Resolved/Closed tickets keep their historical owner, and re-enabling the account does not return redistributed tickets (R05, R08). When a staff member becomes available, automatically assign unassigned open tickets among available staff using the same recalculated-workload rule. Preserve deadlines/status and audit/notify assignments. Do not move tickets already assigned to available staff merely because someone returns.
3. Manual reassignment records actor/time and notifies the new owner (R04, R15, R22).
4. An internal note is visible to IT only and leaves the response clock unsatisfied (R13). Public reply and internal-note drafts remain separate when switching composer modes; sending one does not send or clear the other.
5. A public reply composed in the dashboard is sent to the employee from the support mailbox, signed with the responding staff member's name, and stored on the ticket (R14). There is no path that turns a staff member's own outgoing email into a ticket message.
6. Assignment, employee-reply and overdue notifications reach the assignee (and admin for overdue) with a link to the ticket in the dashboard and no internal-note content (R15, R18). They are one-way: a reply to a notification is not ingested, creates no ticket message, satisfies no response deadline, and must not start a mail loop. Ingestion rejects staff-authored mail to the support mailbox by the same non-participant path as any other unauthorized sender, without an automatic bounce loop.
7. Search and filters support R21; summaries support R20. The default dashboard ticket view is All Tickets. My Tickets filters by the signed-in staff member as assignee and can be combined with the other filters. This filter does not restrict access to other tickets.

## User story 3 — IT receives timely reminders (P1)

The assignee and admin are reminded when the employee waits too long.

Acceptance scenarios:

1. Monday 10:00 arrival is due Monday 14:00, absent an IT response.
2. Monday 16:00 arrival is due Tuesday 11:00.
3. Saturday 16:00 arrival is due Monday 11:00 under working-hour counting.
4. A new Sunday ticket or Sunday employee reply starting a new unanswered response episode is due Monday 12:00 under the explicit exception. If a Saturday message is already due Monday 11:00, a Sunday follow-up preserves Monday 11:00.
5. An unanswered Monday 10:00 ticket gets reminders at Monday 14:00, Monday 18:00 and Tuesday 13:00 (delivery on the next scheduler run is acceptable).
6. Notify both assignee and admin, deduplicating when they are the same person; unassigned tickets notify admin.
7. Entering Waiting for Employee requires an emailed message explaining what information IT needs; reject a transition without that message. The ticket stays in its current status, with its pending deadline and reminder schedule intact, until the outgoing mail server accepts that message; it becomes Waiting for Employee at acceptance (R28). A message that fails permanently leaves the ticket unchanged with the failure visible to IT, and reminders continue in the meantime. No reminders are sent once the ticket is Waiting for Employee. A subsequent employee reply requires a new IT response.
8. Internal notes and automatic messages never satisfy a response; multiple employee follow-ups never postpone a pending deadline.
9. Scheduler retries do not create multiple reminder intents for the same due interval.

The examples are proposed acceptance interpretations. R28 now settles when an email-dependent transition takes effect; the remaining PRD open points must be resolved before coding the delivery mechanics they cover.

## User story 4 — Resolve, close and reopen (P1)

1. Marking a ticket Resolved requires a non-empty resolution message emailed to the employee. Reject attempts without that message; an internal note alone does not qualify. Preserve the resolution message in the public conversation. The ticket becomes Resolved only when the outgoing mail server accepts that message; until then it keeps its current status, response deadline and reminders (R28).
2. A ticket still Resolved 72 elapsed hours after acceptance of its resolution email becomes Closed and sends a notification (R19, R28). The 72 hours run from acceptance, not from the moment IT pressed Resolve.
3. IT may also close a Resolved ticket manually from the dashboard before the 72 hours elapse (R19). Automatic closure remains for tickets nobody closes by hand.
4. Manual and automatic closure both leave the ticket Resolved until the closure email is accepted; the ticket becomes Closed at acceptance, and an unaccepted closure email leaves it Resolved with the failure visible to IT (R28).
5. A bounce or delivery failure reported after the resolution email was accepted alerts the assignee and admin and pauses automatic closure for that ticket until delivery is fixed. Resending an accepted resolution restarts the 72-hour clock from the new acceptance; the pause must not silently close the ticket once the clock resumes (R28).
6. An employee reply to Resolved or Closed reopens it and notifies its owner (R10). Employees cannot close tickets by email. What a reply should do to a resolution or closure email that is still unaccepted is an open point in the PRD, not an approved decision; do not code either behavior before it is settled.
7. Keep the owner if available, otherwise reassign using the normal algorithm; if none available, leave unassigned and alert admin. A disabled owner is never kept.
8. Concurrent auto-close and reply processing must leave the ticket open when an ordinary employee reply invalidates closure eligibility. Manual closure races the same way and must not close a ticket an employee has just reopened.

9. A reply containing CLOSED is an ordinary employee reply, never a closure command.

## User story 5 — Staff authentication and administration (P1)

1. Only admin-created accounts may sign in; no public signup (R05).
2. Correct password alone cannot access the dashboard; the emailed verification code is also required (R06).
3. Incorrect, expired or reused codes are rejected, and attempts are bounded.
4. All authenticated active staff can view/update tickets; only admin manages accounts/settings, including staff availability and account disabling. Regular staff cannot change their own or others’ availability through the dashboard or API. Availability controls assignment eligibility and is separate from account access: an available account can be disabled, and disabling it ends sessions, blocks sign-in and redistributes open tickets under R08, while marking someone unavailable leaves their access intact.
5. Direct attachment URLs cannot bypass staff authentication.
6. Status, priority and ownership changes preserve actor and timestamp (R22).

## User story 6 — Ready-made IT replies (P1)

IT staff select a predefined message and send it to the employee without writing from scratch (R24).

Acceptance scenarios:

1. Selecting a template supplies the outgoing reply body; sending follows the normal public IT reply path, signature and audit behavior.
2. Selecting a template alone does not send an email or satisfy a response deadline.
3. Templates never instruct employees to close tickets by replying.
4. The dashboard includes an admin-only Reply Templates section where the admin can create reusable replies with a name and message body. All five IT staff can select saved templates. Non-admin staff cannot create or change shared templates through either UI or API.
5. Include starter templates for Working on it, Request more details, Troubleshooting steps, and Issue resolved. Final wording and placeholder behavior remain to be defined; troubleshooting instructions must be completed before sending when issue-specific steps are needed.
6. Editing a shared template must not modify previously sent ticket messages.
7. Staff may edit a selected reply before sending. The edit affects only that outgoing message; the saved shared template remains unchanged and can only be changed by the admin.
8. Sending Working on it sets In Progress; Request more details and Troubleshooting steps set Waiting for Employee; Issue resolved sets Resolved. Display the intended transition before sending. Selecting a template alone never changes ticket status.
9. Custom templates default to no status change. The admin may associate In Progress, Waiting for Employee or Resolved; closure is not a template action.
10. A template-associated transition must meet the same required-message validation as a manual transition. Store the outgoing message intent and associated status/audit change atomically. A template-mapped transition takes effect on SMTP acceptance like any other (R28): pending or failed delivery stays visible, leaves the ticket in its previous status, and counts as no IT response.

## Data concepts

Staff account (enabled or disabled); ticket; message (employee, public IT or internal note); attachment; audit event; inbound mail checkpoint; outgoing email intent with its delivery state (queued, accepted with timestamp, failed or bounced); requested-but-unapplied status transition; response deadline; auto-close clock and its pause state; availability; settings; session/login challenge.

## Nonfunctional requirements

- Poll every two minutes in normal operation; recover safely after failed or overlapping runs.
- Keep production tickets and attachments indefinitely. Run daily backups at 02:00 Asia/Kolkata, retaining 30 days of successful recovery points, including database and restorable attachment bytes. Failed backups alert the admin and must not cause removal of the last usable backup. Verify a full restore before launch; backup copies remain private. Incremental attachment copies are acceptable only if every retained recovery point remains restorable. The intended recovery-point objective is no more than 24 hours under successful daily operation; actual recovery time must be measured.
- Sanitize email HTML, do not execute attachments, and avoid loading remote tracking content in the dashboard.
- Use verified TLS for mail and HTTPS for dashboard. Do not log mail passwords or login codes.
- Maintain correct assignment and transition behavior under concurrency.
- Publish no production readiness claim until acceptance and integration checks pass.
