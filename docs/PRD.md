# SimpleTickets — Product Requirements

Version 0.2 · Draft · 16 September 2026

## Outcome

An internal employee can request IT help by email, track the conversation through replies, and receive resolution updates. The IT team works entirely in one dashboard, where it can see ownership, workload and overdue responses.

## Confirmed requirements

| ID | Requirement |
| --- | --- |
| R01 | Accept employee requests only from `@allcheckservices.com` sent to `support@allcheckservices.com`. The sender rule is unchanged and implemented. **The Zimbra clause is withdrawn:** a Cloudflare Worker cannot reach `mail.allcheckservices.com` on any port, so the mailbox is now `simpleticketssupport@gmail.com`, polled over IMAP. How mail reaches it from the published address is open point 5. |
| R02 | Poll for new mail every two minutes. Create a ticket and send an acknowledgement containing its ticket number. **Implemented and proved on real mail, 17 September 2026** — driven by a Durable Object alarm rather than a cron trigger, because cron does not fire on this account. |
| R03 | Append email replies to the same ticket. Employees use email only. |
| R04 | Five IT staff work exclusively in the dashboard; it is the only place they read tickets, reply, add internal notes and change status, priority or assignment. Staff never work a ticket by email, and a reply to an IT notification email is not ingested. All can view/update every ticket, change priority, and manually reassign tickets. |
| R05 | One staff member is also admin and creates staff accounts, disables them and manages settings. No public signup. Disabling an account ends dashboard access and redistributes that person's open tickets under R08. |
| R06 | Separate account passwords plus emailed verification codes protect dashboard sign-in. **Implemented 17 September 2026**, behind `LOGIN_CODES` and off by default: a code sent over SMTP while `MAIL_SEND` is off would lock every staff member out of a system that cannot tell them why, so the server refuses to start in that combination. Six digits, hashed at rest, ten minutes, five guesses, single use. A correct password grants no session on its own. Account recovery is still open. |
| R07 | Assign to available staff with fewest open tickets, using round robin among tied staff. Count New, In Progress and Waiting for Employee. |
| R08 | Only the admin can manage staff availability; regular staff cannot change their own or others’ availability. Skip unavailable staff. When the admin marks a staff member unavailable, automatically redistribute their New, In Progress and Waiting for Employee tickets among available staff using fewest open tickets and round robin for ties, recalculating workload after each assignment. If no staff are available, leave affected open tickets unassigned and alert admin. Preserve ticket status, priority, conversation and response deadlines; record each assignment change and notify new owners. Resolved and Closed tickets retain their historical owner and follow the normal reassignment rule if reopened. Disabling a staff account redistributes that person's New, In Progress and Waiting for Employee tickets by exactly these rules, with the same preservation, audit and notification behavior; Resolved and Closed tickets retain their historical owner. Re-enabling an account does not return previously redistributed tickets. When the admin marks a staff member available, automatically assign unassigned New, In Progress and Waiting for Employee tickets among available staff using the same workload and tie-break rules. Preserve existing deadlines/status, audit assignments and notify new owners; do not rebalance tickets already assigned to available staff. |
| R09 | Statuses: New, In Progress, Waiting for Employee, Resolved, Closed. Entering Waiting for Employee requires an emailed message explaining what information IT needs, and takes effect only when that message is accepted for delivery (R28). |
| R10 | Employee reply to Resolved or Closed reopens the ticket. Employees cannot close tickets through email replies. Keep previous owner if available; otherwise reassign by R07. |
| R11 | Priorities Low, Normal, High, Urgent. Default Normal; identical response deadline for all. |
| R12 | Allow attachments up to 5 MB total per email. Over limit: create ticket without attachments and ask sender for smaller files. |
| R13 | Internal notes visible only to IT; never emailed to employees and never count as an IT response. |
| R14 | Compose public IT replies in the dashboard and send them from `support@allcheckservices.com`, signed with the responding staff member's name. |
| R15 | Email the assigned staff member on assignment, on employee replies and when a response becomes overdue (R18). Every IT notification links to the ticket in the dashboard, carries no internal-note content, and is one-way: replying to it neither reaches the ticket nor satisfies a response deadline. Marking a ticket Resolved requires a non-empty resolution message emailed to the employee, and takes effect on acceptance of that message (R28). Email the employee when the ticket is closed. |
| R16 | First response and subsequent employee messages require an IT reply within four working hours. Later employee follow-ups do not reset the first unanswered message's timer. **Implemented 17 September 2026** as response *episodes*: "answered" is the earliest outbound message after the most recent inbound one, so a ticket IT replied to once no longer reads as answered forever. A follow-up arriving while a response is already owed leaves the existing deadline where it is. |
| R17 | Work calendar: Monday–Saturday, 09:00–18:00 Asia/Kolkata. Public holidays follow this calendar. New tickets and employee replies received on Sunday have a special Monday 12:00 deadline when they start a new unanswered response episode. An existing earlier pending deadline is not postponed. |
| R18 | Send overdue reminders to assignee and admin, each linking to the ticket in the dashboard, repeating every four working hours until IT replies. No reminders while Waiting for Employee. |
| R19 | Automatically close Resolved tickets after 72 elapsed hours without an employee reply, including Sundays and holidays, measured from acceptance of the resolution email (R28). IT may also close a Resolved ticket manually from the dashboard before that. Both closure routes leave the ticket Resolved until the closure email is accepted (R28). |
| R20 | Dashboard summary shows open tickets, overdue tickets and tickets per staff member. |
| R21 | Show All Tickets by default, with a My Tickets filter for tickets assigned to the signed-in IT staff member. Search and filter tickets by status, priority, assignee and employee email. |
| R22 | Activity history records who changed status, priority or assignment, and when. **Implemented 17 September 2026** as `audit_events`, separate from `messages` on purpose: the message history is what was *said*, the audit trail is who *did* what. The actor comes from the session, never the request body. Setting something to the value it already has records nothing. |
| R23 | Retain tickets and attachments indefinitely. Aim for a free starting hosting configuration; provider not finalized. |
| R24 | Provide ready-made reply messages for all IT staff to select and send without composing from scratch. Include four starter templates: Working on it, Request more details, Troubleshooting steps, and Issue resolved. Provide an admin-only Reply Templates dashboard section to create and manage reusable replies. Staff can edit a selected reply before sending; these edits affect only that message, never the saved template. Only the admin can change shared templates. Sending Working on it sets In Progress; sending Request more details or Troubleshooting steps sets Waiting for Employee; sending Issue resolved sets Resolved. Each mapped transition follows R28. Selecting a template alone never changes status. Show the resulting status before sending. Custom templates default to leaving status unchanged; the admin may associate In Progress, Waiting for Employee or Resolved. These are staff reply templates, not employee email commands. **Implemented 17 September 2026.** The isolation this requirement asks for is structural rather than checked: the body sent is always what is on screen and only the template's status mapping is read server-side, so editing a selected reply reaches the employee while the shared wording is untouched, and editing the shared template later cannot rewrite what was already sent. Closure is refused as a mapping by a database constraint. |
| R25 | Include people CC’d on the employee’s email in public ticket replies only when their email domain is exactly allcheckservices.com. Exclude external-domain CC addresses from outgoing ticket emails. Eligible company-domain CC recipients can reply and add messages to the same ticket. Their replies follow the same rules as requester replies: reopen Resolved or Closed tickets, restart the need for an IT response after IT has replied, preserve any existing earlier unanswered deadline, and use the Sunday deadline exception when applicable. The requester may add company colleagues by CC’ing them on a later authenticated reply. IT staff may also manage participants in the dashboard. Omitting an existing participant from an email does not remove them; IT must explicitly remove them. Other CC participants cannot add participants through email. New participants receive future public replies; do not automatically email the full ticket history. Internal notes remain IT-only. **Implemented 17 September 2026.** The half that carries the requirement is authorisation: everyone in the company is on the approved domain, so nothing about the *address* stops a stranger threading onto a colleague's ticket — only membership does. An unrelated same-domain sender is refused and recorded rather than dropped. Participants are copied in the Cc header *and* the SMTP envelope, since a colleague in one but not the other sees their name on a message they never received. |
| R26 | Run an automatic daily backup at 02:00 IST and retain successful daily recovery points for 30 days. Include the database and recoverable copies of attachments, not just an attachment inventory. Alert the admin on backup failure. Verify a restore before launch. Production tickets and attachments remain retained indefinitely. |
| R27 | Create tickets only from emails received from launch onward. Do not import pre-launch mailbox emails, whether read or unread. Leave existing mailbox contents intact. |
| R28 | A status change that requires an email takes effect only when the outgoing mail server accepts that message. A requested Waiting for Employee or Resolved transition leaves the ticket's status, response deadline and reminders exactly as they were until acceptance; on acceptance the status changes, and for a resolution the R19 auto-close clock starts at the acceptance time. Manual and automatic closure both leave the ticket Resolved until the closure email is accepted. A bounce or delivery failure reported after acceptance alerts the assignee and admin and pauses automatic closure until delivery is fixed. A message that is never accepted leaves the ticket in its previous status with the failure visible to IT. A draft, internal note or automatic acknowledgement never satisfies a transition or a response deadline. |

## Approved 16 September 2026 — implemented 17 September 2026

The user approved these eight decisions. All eight are now built in `server/` and covered
by tests. What each one still lacks is noted, because "implemented" is not "proved against
real mail".

| # | Decision | Where it lives | Covered by |
| --- | --- | --- | --- |
| 1 | IT works only in the dashboard; employees use email (R04, R14) | `api.ts` requires a session for every write; there is no inbound path from a staff address to a ticket | `notification.db.test.ts` |
| 2 | Assignment, employee-reply and overdue notifications, each linking to the dashboard (R15, R18) | `notification.ts`, `pipeline.notifyAssignee`, `pipeline.sendReminders` | `notification.test.ts`, `notification.db.test.ts` |
| 3 | Waiting/Resolved take effect only on SMTP acceptance (R09, R15, R28) | `transitions.ts` classifies; `store.recordAcceptance` applies the status and the acceptance in one transaction | `store.db.test.ts` |
| 4 | The 72-hour clock starts at acceptance (R19, R28) | `store.ticketsReadyToClose` joins on `outbox.accepted_at` | `autoclose.db.test.ts` |
| 5 | Manual closure as well as automatic (R19) | `POST /api/tickets/:id/status` with `Closed`; `pipeline.autoClose` | `autoclose.db.test.ts` |
| 6 | Both closure routes leave the ticket Resolved until accepted (R19, R28) | both queue a `closure` intent with `pendingStatus` — the same machinery, deliberately | `autoclose.db.test.ts` |
| 7 | A bounce after acceptance alerts and pauses auto-close (R28) | `delivery_failed` notification; `ticketsReadyToClose` excludes a bounced resolution | `autoclose.db.test.ts` |
| 8 | Redistribution on disabling/unavailability (R05, R08) | `api.redistribute`, re-reading workloads after each move | `store.db.test.ts` |

**Half proved end to end.** Ingestion runs on the current stack: on 17 September 2026 an
empty database pointed at the live mailbox rebuilt the same tickets, threaded the reply
onto its original, and logged three unapproved senders (`docs/stack-validation.md`).

**The outgoing half is not.** `MAIL_SEND` is off by default and has never been on here, so
no acknowledgement, reply, notification or reminder composed by this server has reached a
person. Rows 2, 3, 6 and 7 above are therefore built and tested but unwitnessed in the
wild, and turning sending on is a decision that needs naming a sender and recipients.

## Proposed implementation defaults — not additional user decisions

- Treat 5 MB as 5,000,000 decoded attachment bytes, counting inline files too. Apply the limit to replies as well as initial emails; preserve reply text when files are omitted.
- On employee reply, transition a waiting or reopened ticket to In Progress.
- A public dashboard reply accepted by the outgoing mail server satisfies a response timer, per R28. Track later delivery failures visibly.
- Include the requesting employee, eligible CC recipients and authorized IT staff in public ticket conversations; eligible company-domain CC participants may reply; external-domain CC addresses are excluded. Do not authorize a reply based only on its subject/ticket number.
- An initial draft design uses a 10-minute single-use login code, attempt limits, throttling and secure sessions; verify implementation against hosting limits.

## Open points

1. ~~Confirm the backup storage provider, restore-time feasibility, and capacity growth.~~
   **Resolved 17 September 2026.** Backups are `pg_dump --format=custom` to `BACKUP_DIR`
   at 02:00 IST with 30-day retention, which the local disk holds comfortably at this
   scale. Restore is a tested path, not a runbook paragraph: `backup.db.test.ts` takes a
   real dump, empties the database, restores it and checks the rows came back — including
   that the restored database can still accept new tickets, which is where identity
   sequences usually break. **Extended 17 September:** a recovery point is now two files
   taken together — the dump and a `tar` of the attachment bytes — because restoring the
   database alone gives an `attachments` table whose every row points at a file that is not
   there. The restore test destroys both halves and brings both back. Pruning keeps them
   together and never deletes the newest dump. **Still open:** the backups are on the same
   disk as the database, which is not a backup against disk loss. An off-machine copy is
   needed before this is relied on, and that decision waits on where this runs in
   production.
2. ~~Verify trusted sender authentication, delivery and origin compatibility.~~
   **Resolved 17 September 2026.** Real employee email became real tickets and real
   acknowledgements were accepted with Gmail queue ids. The Cloudflare-origin constraint
   that forced Gmail is gone with Cloudflare, which is now deleted entirely — Zimbra IMAP
   may well be reachable from this machine, which would remove the Gmail hop and open
   point 5 with it. `scripts/check-mail-tls.mjs` is the probe. Untested; worth an hour.
   See stack-validation.md.

3. Decide what an employee reply does to a Waiting, Resolved or closure transition whose required email has not yet been accepted: cancel the pending transition and leave the ticket open, or apply it on acceptance and let the reply reopen the ticket immediately. The approved rule in R28 covers the waiting period itself, not this collision.

4. Handle SMTP acceptance ambiguity: a disconnect after the server accepted a message must not be recorded as a failure, nor an unacknowledged send as an acceptance. R28 settles what a transition waits for; the detection mechanism is still an implementation question. **Partly addressed 17 September:** such a send is parked as `ambiguous` and shown to IT, and `POST /api/outbox/:id/resend` lets a person decide to try again — which also clears the acceptance, so an auto-close clock re-anchors to the delivery that arrived. What is still open is the detection rule itself: when a disconnect after DATA should count as acceptance.

5. ~~**Decide how mail reaches the support mailbox.**~~ **Resolved 17 September 2026:
   Zimbra forwards it.** `support@allcheckservices.com` forwards to
   `simpleticketssupport@gmail.com`, set as a user-level forward in Zimbra webmail - no
   DNS change, no mail administrator, apex MX untouched. Proved end to end: the message
   arrived in INBOX rather than spam (SPF passes because the forwarder is the domain's own
   MX, which the record authorises via `+mx`), and the original sender was preserved, so
   tickets are filed against the employee and not the support mailbox. Employees keep the
   address they already know. **Outbound identity is still open:** replies leave as the
   Gmail address, which needs Gmail "send as" or Workspace on the domain.

6. ~~**Choose a sending transport.**~~ **Resolved 17 September 2026: Gmail SMTP**, port
   465 with the App Password already used for ingestion. The outbound module, the durable
   outbox, retry/backoff, permanence classification and R28 delivery gating are all built
   and tested. The From address remains open point 5.

7. **Decide the DMARC policy.** Open. What the domain publishes today is deliberately not
   recorded here - see the note in `docs/stack-validation.md` for why a public repository
   is the wrong place for it.

8. ~~**Staff password hashing.**~~ **Resolved 17 September 2026, and then improved.** The
   Workers workaround — six chained PBKDF2 rounds to reach 600,000 iterations past a
   100,000-per-call cap — is no longer needed. Node has scrypt, which is **memory-hard**,
   the property PBKDF2 lacks at any iteration count. Parameters are N=2¹⁶, r=8, p=2: 64 MB
   per guess, measured at 252 ms per hash. The old verifier is retained so a password set
   under the previous scheme still works, with a test pinning a real legacy hash.

   One accepted trade-off stands, unchanged by the platform move and recorded in
   `docs/stack-validation.md`: login returns early for unknown accounts, which leaks
   account existence by timing, because evening the timing would let any anonymous caller
   burn a full KDF per request. Revisit if account names ever stop being `staff1`–`staff5`.

9. **Decide where backups go off this machine.** See open point 1. Blocked on the
   production hosting decision, which is deliberately still open.

## Success and release criteria

Demonstrate one ticket per original email under retries, correct reply threading, correct assignment, private internal notes, authenticated dashboard access, private attachment downloads, and calendar-correct reminders. Complete a real test mailbox round trip and a backup restore before production. No reliability or hosting claim is proven by this document alone.
