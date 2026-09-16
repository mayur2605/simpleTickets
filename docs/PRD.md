# SimpleTickets — Product Requirements

Version 0.1 · Draft · 16 September 2026

## Outcome

An internal employee can request IT help by email, track the conversation through replies, and receive resolution updates. The IT team can see ownership, workload and overdue responses in one dashboard.

## Confirmed requirements

| ID | Requirement |
| --- | --- |
| R01 | Accept employee requests only from `@allcheckservices.com` sent to `support@allcheckservices.com`; use existing Zimbra at `mail.allcheckservices.com`. |
| R02 | Poll for new mail every two minutes. Create a ticket and send an acknowledgement containing its ticket number. |
| R03 | Append email replies to the same ticket. Employees use email only. |
| R04 | Five IT staff use dashboard and email. All can view/update every ticket, change priority, and manually reassign tickets. |
| R05 | One staff member is also admin and creates staff accounts and manages settings. No public signup. |
| R06 | Separate account passwords plus emailed verification codes protect dashboard sign-in. |
| R07 | Assign to available staff with fewest open tickets, using round robin among tied staff. Count New, In Progress and Waiting for Employee. |
| R08 | Only the admin can manage staff availability; regular staff cannot change their own or others’ availability. Skip unavailable staff. When the admin marks a staff member unavailable, automatically redistribute their New, In Progress and Waiting for Employee tickets among available staff using fewest open tickets and round robin for ties, recalculating workload after each assignment. If no staff are available, leave affected open tickets unassigned and alert admin. Preserve ticket status, priority, conversation and response deadlines; record each assignment change and notify new owners. Resolved and Closed tickets retain their historical owner and follow the normal reassignment rule if reopened. When the admin marks a staff member available, automatically assign unassigned New, In Progress and Waiting for Employee tickets among available staff using the same workload and tie-break rules. Preserve existing deadlines/status, audit assignments and notify new owners; do not rebalance tickets already assigned to available staff. |
| R09 | Statuses: New, In Progress, Waiting for Employee, Resolved, Closed. Entering Waiting for Employee requires an emailed message explaining what information IT needs. |
| R10 | Employee reply to Resolved or Closed reopens the ticket. Employees cannot close tickets through email replies. Keep previous owner if available; otherwise reassign by R07. |
| R11 | Priorities Low, Normal, High, Urgent. Default Normal; identical response deadline for all. |
| R12 | Allow attachments up to 5 MB total per email. Over limit: create ticket without attachments and ask sender for smaller files. |
| R13 | Internal notes visible only to IT; never emailed to employees and never count as an IT response. |
| R14 | Send public IT replies from `support@allcheckservices.com`, signed with responding staff member's name. |
| R15 | Notify assigned staff of assignment and employee replies. Marking a ticket Resolved requires a non-empty resolution message emailed to the employee. Email employee when closed. |
| R16 | First response and subsequent employee messages require an IT reply within four working hours. Later employee follow-ups do not reset the first unanswered message's timer. |
| R17 | Work calendar: Monday–Saturday, 09:00–18:00 Asia/Kolkata. Public holidays follow this calendar. New tickets and employee replies received on Sunday have a special Monday 12:00 deadline when they start a new unanswered response episode. An existing earlier pending deadline is not postponed. |
| R18 | Send overdue reminders to assignee and admin, repeating every four working hours until IT replies. No reminders while Waiting for Employee. |
| R19 | Automatically close Resolved tickets after 72 elapsed hours without an employee reply, including Sundays and holidays. |
| R20 | Dashboard summary shows open tickets, overdue tickets and tickets per staff member. |
| R21 | Show All Tickets by default, with a My Tickets filter for tickets assigned to the signed-in IT staff member. Search and filter tickets by status, priority, assignee and employee email. |
| R22 | Activity history records who changed status, priority or assignment, and when. |
| R23 | Retain tickets and attachments indefinitely. Aim for a free starting hosting configuration; provider not finalized. |
| R24 | Provide ready-made reply messages for all IT staff to select and send without composing from scratch. Include four starter templates: Working on it, Request more details, Troubleshooting steps, and Issue resolved. Provide an admin-only Reply Templates dashboard section to create and manage reusable replies. Staff can edit a selected reply before sending; these edits affect only that message, never the saved template. Only the admin can change shared templates. Sending Working on it sets In Progress; sending Request more details or Troubleshooting steps sets Waiting for Employee; sending Issue resolved sets Resolved. Selecting a template alone never changes status. Show the resulting status before sending. Custom templates default to leaving status unchanged; the admin may associate In Progress, Waiting for Employee or Resolved. These are staff reply templates, not employee email commands. |
| R25 | Include people CC’d on the employee’s email in public ticket replies only when their email domain is exactly allcheckservices.com. Exclude external-domain CC addresses from outgoing ticket emails. Eligible company-domain CC recipients can reply and add messages to the same ticket. Their replies follow the same rules as requester replies: reopen Resolved or Closed tickets, restart the need for an IT response after IT has replied, preserve any existing earlier unanswered deadline, and use the Sunday deadline exception when applicable. The requester may add company colleagues by CC’ing them on a later authenticated reply. IT staff may also manage participants in the dashboard. Omitting an existing participant from an email does not remove them; IT must explicitly remove them. Other CC participants cannot add participants through email. New participants receive future public replies; do not automatically email the full ticket history. Internal notes remain IT-only. |
| R26 | Run an automatic daily backup at 02:00 IST and retain successful daily recovery points for 30 days. Include the database and recoverable copies of attachments, not just an attachment inventory. Alert the admin on backup failure. Verify a restore before launch. Production tickets and attachments remain retained indefinitely. |
| R27 | Create tickets only from emails received from launch onward. Do not import pre-launch mailbox emails, whether read or unread. Leave existing mailbox contents intact. |

## Proposed implementation defaults — not additional user decisions

- Treat 5 MB as 5,000,000 decoded attachment bytes, counting inline files too. Apply the limit to replies as well as initial emails; preserve reply text when files are omitted.
- On employee reply, transition a waiting or reopened ticket to In Progress.
- A staff email accepted by the outgoing mail server satisfies a response timer. Track later delivery failures visibly. A draft, internal note or automatic acknowledgement never satisfies it.
- Include the requesting employee, eligible CC recipients and authorized IT staff in public ticket conversations; eligible company-domain CC participants may reply; external-domain CC addresses are excluded. Do not authorize a reply based only on its subject/ticket number.
- An initial draft design uses a 10-minute single-use login code, attempt limits, throttling and secure sessions; verify implementation against hosting limits.

## Open points

1. Confirm the backup storage provider, restore-time feasibility, and capacity/cost growth beyond free allowances. Daily backups and 30-day recovery-point retention are decided.
2. Verify staff reply routing, trusted sender authentication, delivery and Cloudflare-origin compatibility. Local TLS passed on 993/465 and the user reported local authentication PASS; credentials were not supplied in conversation. See stack-validation.md.

3. Resolve delivery/transition timing before implementing the state machine: atomically recording a requested Waiting/Resolved transition must not suppress reminders or start auto-close while its required reply remains unaccepted. SMTP ambiguity and late bounces need explicit handling.

## Success and release criteria

Demonstrate one ticket per original email under retries, correct reply threading, correct assignment, private internal notes, authenticated dashboard access, private attachment downloads, and calendar-correct reminders. Complete a real test mailbox round trip and a backup restore before production. No reliability or hosting claim is proven by this document alone.
