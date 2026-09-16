# Foundation

## Purpose

Make internal IT requests traceable without requiring employees to learn a new portal. An employee emails support, receives a ticket number, and continues the conversation by email. IT works only in the dashboard; the notifications IT receives link back to it.

## People and scale

- Approximately 100 employees; no employee application accounts.
- Five IT staff, one also an administrator; all five can view and update all tickets, and all do so in the dashboard.
- Expected volume: 5–15 new tickets daily.
- Single organization, IT support only.

## Confirmed boundaries

- Allowed sender domain: `allcheckservices.com`.
- Support mailbox: `support@allcheckservices.com`.
- Existing Zimbra host: `mail.allcheckservices.com`, publicly accessible according to the user.
- User can arrange IMAP/SMTP access. Local verified TLS passed on 993/465; the user reported a local authentication PASS. Delivery, polling and Cloudflare-origin compatibility remain unverified; see stack-validation.md.
- Cloud hosting; prioritize a free starting option such as Cloudflare.
- Retain tickets and attachments indefinitely. Free storage cannot be assumed sufficient forever.
- Dashboard accessible from anywhere, using separate staff passwords plus emailed verification codes. It is the sole IT working surface, so its availability is an IT-workflow dependency, not a convenience.
- Email is the employee interface only. IT staff never work a ticket from their mailbox, and replies to IT notification emails are not ingested.
- The administrator can disable a staff account; disabling it ends dashboard access and redistributes that person's open tickets by the normal assignment rules, while Resolved and Closed tickets keep their historical owner.
- The two boundaries above were approved on 16 September 2026 and are not implemented.
- Documentation and specifications precede implementation; discuss open product questions one at a time.

## First-version exclusions

Employee portal, public registration, Zimbra single sign-on, HR/facilities workflows, different deadlines by priority, holiday calendars, automatic retention deletion, and any path for IT staff to work a ticket from their own mailbox.

## Working approach

Start with one email-to-ticket flow and prove reliability before adding the full dashboard. Validate a candidate hosting architecture using representative email and attachment processing. Keep backups, restore checks, privacy, and delivery failures in the launch criteria.
