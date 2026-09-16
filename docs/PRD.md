# SimpleTickets — Product Requirements

Version 0.2 · Draft · 16 September 2026

## Outcome

An internal employee can request IT help by email, track the conversation through replies, and receive resolution updates. The IT team works entirely in one dashboard, where it can see ownership, workload and overdue responses.

## Confirmed requirements

| ID | Requirement |
| --- | --- |
| R01 | Accept employee requests only from `@allcheckservices.com` sent to `support@allcheckservices.com`. The sender rule is unchanged and implemented. **The Zimbra clause is withdrawn:** a Cloudflare Worker cannot reach `mail.allcheckservices.com` on any port, so the mailbox is now `simpleticketssupport@gmail.com`, polled over IMAP. How mail reaches it from the published address is open point 5. |
| R02 | Poll for new mail every two minutes. Create a ticket and send an acknowledgement containing its ticket number. |
| R03 | Append email replies to the same ticket. Employees use email only. |
| R04 | Five IT staff work exclusively in the dashboard; it is the only place they read tickets, reply, add internal notes and change status, priority or assignment. Staff never work a ticket by email, and a reply to an IT notification email is not ingested. All can view/update every ticket, change priority, and manually reassign tickets. |
| R05 | One staff member is also admin and creates staff accounts, disables them and manages settings. No public signup. Disabling an account ends dashboard access and redistributes that person's open tickets under R08. |
| R06 | Separate account passwords plus emailed verification codes protect dashboard sign-in. |
| R07 | Assign to available staff with fewest open tickets, using round robin among tied staff. Count New, In Progress and Waiting for Employee. |
| R08 | Only the admin can manage staff availability; regular staff cannot change their own or others’ availability. Skip unavailable staff. When the admin marks a staff member unavailable, automatically redistribute their New, In Progress and Waiting for Employee tickets among available staff using fewest open tickets and round robin for ties, recalculating workload after each assignment. If no staff are available, leave affected open tickets unassigned and alert admin. Preserve ticket status, priority, conversation and response deadlines; record each assignment change and notify new owners. Resolved and Closed tickets retain their historical owner and follow the normal reassignment rule if reopened. Disabling a staff account redistributes that person's New, In Progress and Waiting for Employee tickets by exactly these rules, with the same preservation, audit and notification behavior; Resolved and Closed tickets retain their historical owner. Re-enabling an account does not return previously redistributed tickets. When the admin marks a staff member available, automatically assign unassigned New, In Progress and Waiting for Employee tickets among available staff using the same workload and tie-break rules. Preserve existing deadlines/status, audit assignments and notify new owners; do not rebalance tickets already assigned to available staff. |
| R09 | Statuses: New, In Progress, Waiting for Employee, Resolved, Closed. Entering Waiting for Employee requires an emailed message explaining what information IT needs, and takes effect only when that message is accepted for delivery (R28). |
| R10 | Employee reply to Resolved or Closed reopens the ticket. Employees cannot close tickets through email replies. Keep previous owner if available; otherwise reassign by R07. |
| R11 | Priorities Low, Normal, High, Urgent. Default Normal; identical response deadline for all. |
| R12 | Allow attachments up to 5 MB total per email. Over limit: create ticket without attachments and ask sender for smaller files. |
| R13 | Internal notes visible only to IT; never emailed to employees and never count as an IT response. |
| R14 | Compose public IT replies in the dashboard and send them from `support@allcheckservices.com`, signed with the responding staff member's name. |
| R15 | Email the assigned staff member on assignment, on employee replies and when a response becomes overdue (R18). Every IT notification links to the ticket in the dashboard, carries no internal-note content, and is one-way: replying to it neither reaches the ticket nor satisfies a response deadline. Marking a ticket Resolved requires a non-empty resolution message emailed to the employee, and takes effect on acceptance of that message (R28). Email the employee when the ticket is closed. |
| R16 | First response and subsequent employee messages require an IT reply within four working hours. Later employee follow-ups do not reset the first unanswered message's timer. |
| R17 | Work calendar: Monday–Saturday, 09:00–18:00 Asia/Kolkata. Public holidays follow this calendar. New tickets and employee replies received on Sunday have a special Monday 12:00 deadline when they start a new unanswered response episode. An existing earlier pending deadline is not postponed. |
| R18 | Send overdue reminders to assignee and admin, each linking to the ticket in the dashboard, repeating every four working hours until IT replies. No reminders while Waiting for Employee. |
| R19 | Automatically close Resolved tickets after 72 elapsed hours without an employee reply, including Sundays and holidays, measured from acceptance of the resolution email (R28). IT may also close a Resolved ticket manually from the dashboard before that. Both closure routes leave the ticket Resolved until the closure email is accepted (R28). |
| R20 | Dashboard summary shows open tickets, overdue tickets and tickets per staff member. |
| R21 | Show All Tickets by default, with a My Tickets filter for tickets assigned to the signed-in IT staff member. Search and filter tickets by status, priority, assignee and employee email. |
| R22 | Activity history records who changed status, priority or assignment, and when. |
| R23 | Retain tickets and attachments indefinitely. Aim for a free starting hosting configuration; provider not finalized. |
| R24 | Provide ready-made reply messages for all IT staff to select and send without composing from scratch. Include four starter templates: Working on it, Request more details, Troubleshooting steps, and Issue resolved. Provide an admin-only Reply Templates dashboard section to create and manage reusable replies. Staff can edit a selected reply before sending; these edits affect only that message, never the saved template. Only the admin can change shared templates. Sending Working on it sets In Progress; sending Request more details or Troubleshooting steps sets Waiting for Employee; sending Issue resolved sets Resolved. Each mapped transition follows R28. Selecting a template alone never changes status. Show the resulting status before sending. Custom templates default to leaving status unchanged; the admin may associate In Progress, Waiting for Employee or Resolved. These are staff reply templates, not employee email commands. |
| R25 | Include people CC’d on the employee’s email in public ticket replies only when their email domain is exactly allcheckservices.com. Exclude external-domain CC addresses from outgoing ticket emails. Eligible company-domain CC recipients can reply and add messages to the same ticket. Their replies follow the same rules as requester replies: reopen Resolved or Closed tickets, restart the need for an IT response after IT has replied, preserve any existing earlier unanswered deadline, and use the Sunday deadline exception when applicable. The requester may add company colleagues by CC’ing them on a later authenticated reply. IT staff may also manage participants in the dashboard. Omitting an existing participant from an email does not remove them; IT must explicitly remove them. Other CC participants cannot add participants through email. New participants receive future public replies; do not automatically email the full ticket history. Internal notes remain IT-only. |
| R26 | Run an automatic daily backup at 02:00 IST and retain successful daily recovery points for 30 days. Include the database and recoverable copies of attachments, not just an attachment inventory. Alert the admin on backup failure. Verify a restore before launch. Production tickets and attachments remain retained indefinitely. |
| R27 | Create tickets only from emails received from launch onward. Do not import pre-launch mailbox emails, whether read or unread. Leave existing mailbox contents intact. |
| R28 | A status change that requires an email takes effect only when the outgoing mail server accepts that message. A requested Waiting for Employee or Resolved transition leaves the ticket's status, response deadline and reminders exactly as they were until acceptance; on acceptance the status changes, and for a resolution the R19 auto-close clock starts at the acceptance time. Manual and automatic closure both leave the ticket Resolved until the closure email is accepted. A bounce or delivery failure reported after acceptance alerts the assignee and admin and pauses automatic closure until delivery is fixed. A message that is never accepted leaves the ticket in its previous status with the failure visible to IT. A draft, internal note or automatic acknowledgement never satisfies a transition or a response deadline. |

## Approved 16 September 2026 — not implemented

The user approved these eight decisions. They are recorded in the requirements above and in the specification, plan and tasks; no code implements any of them.

1. IT staff work exclusively through the dashboard; employees use email (R04, R14).
2. IT receives assignment, employee-reply and overdue email notifications, each linking to the dashboard (R15, R18).
3. A Waiting for Employee or Resolved transition takes effect only after SMTP acceptance of the required public reply; until then status and response deadlines are preserved (R09, R15, R28).
4. The 72-hour auto-close timer starts when the resolution email is accepted (R19, R28).
5. IT may close a Resolved ticket manually; automatic closure also remains (R19).
6. Both closure routes leave the ticket Resolved until the closure email is accepted (R19, R28).
7. A resolution-email bounce reported after acceptance alerts the assignee and admin and pauses automatic closure until delivery is fixed (R28).
8. Disabling a staff account redistributes open tickets by the existing assignment rules; Resolved and Closed tickets retain their historical owner (R05, R08).

## Proposed implementation defaults — not additional user decisions

- Treat 5 MB as 5,000,000 decoded attachment bytes, counting inline files too. Apply the limit to replies as well as initial emails; preserve reply text when files are omitted.
- On employee reply, transition a waiting or reopened ticket to In Progress.
- A public dashboard reply accepted by the outgoing mail server satisfies a response timer, per R28. Track later delivery failures visibly.
- Include the requesting employee, eligible CC recipients and authorized IT staff in public ticket conversations; eligible company-domain CC participants may reply; external-domain CC addresses are excluded. Do not authorize a reply based only on its subject/ticket number.
- An initial draft design uses a 10-minute single-use login code, attempt limits, throttling and secure sessions; verify implementation against hosting limits.

## Open points

1. Confirm the backup storage provider, restore-time feasibility, and capacity/cost growth beyond free allowances. Daily backups and 30-day recovery-point retention are decided.
2. ~~Verify trusted sender authentication, delivery and Cloudflare-origin compatibility.~~ **Resolved for receiving, 17 September 2026.** Cloudflare-origin Zimbra access is impossible and the transport moved to Gmail IMAP; real emails now become tickets. **Still open for sending:** no transport has ever successfully sent a reply, so R02's acknowledgement, R13's replies and R15's failure visibility are all unproved. See stack-validation.md.

3. Decide what an employee reply does to a Waiting, Resolved or closure transition whose required email has not yet been accepted: cancel the pending transition and leave the ticket open, or apply it on acceptance and let the reply reopen the ticket immediately. The approved rule in R28 covers the waiting period itself, not this collision.

4. Handle SMTP acceptance ambiguity: a disconnect after the server accepted a message must not be recorded as a failure, nor an unacknowledged send as an acceptance. R28 settles what a transition waits for; the detection mechanism is still an implementation question.

5. **Decide how mail reaches the support mailbox.** The published address is
   `support@allcheckservices.com`; the mailbox that is actually polled is
   `simpleticketssupport@gmail.com`. Either employees are told the new address, or the
   Zimbra administrator forwards the published one to it. Forwarding keeps the address
   employees already know but reintroduces a dependency on the mail administrator.
   **Nothing is configured yet, so no employee mail reaches the system today.**

6. ~~**Choose a sending transport.**~~ **Resolved 17 September 2026: Gmail SMTP.** A
   Worker authenticated to `smtp.gmail.com:465` with the App Password already used for
   ingestion (`235`, 1416 ms). Zimbra SMTP stays unreachable and Resend stays blacklisted;
   this needs neither. **Authentication is not delivery** — no mail has been sent and no
   outbound module exists, so R02's acknowledgement, R13's replies and R28's delivery
   gating remain unbuilt. The From address is still open point 5: replies would come from
   the Gmail address unless Gmail is configured to send as the company address.

7. **Decide the DMARC policy.** Open. What the domain publishes today is deliberately not
   recorded here - see the note in `docs/stack-validation.md` for why a public repository
   is the wrong place for it.

## Success and release criteria

Demonstrate one ticket per original email under retries, correct reply threading, correct assignment, private internal notes, authenticated dashboard access, private attachment downloads, and calendar-correct reminders. Complete a real test mailbox round trip and a backup restore before production. No reliability or hosting claim is proven by this document alone.
