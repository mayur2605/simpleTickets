# Foundation

## Purpose

Make internal IT requests traceable without requiring employees to learn a new portal. An employee emails support, receives a ticket number, and continues the conversation by email. IT works through a dashboard or email.

## People and scale

- Approximately 100 employees; no employee application accounts.
- Five IT staff, one also an administrator; all five can view and update all tickets.
- Expected volume: 5–15 new tickets daily.
- Single organization, IT support only.

## Confirmed boundaries

- Allowed sender domain: `allcheckservices.com`.
- Support mailbox: `support@allcheckservices.com`.
- Existing Zimbra host: `mail.allcheckservices.com`, publicly accessible according to the user.
- User can arrange IMAP/SMTP access. Local verified TLS passed on 993/465; the user reported a local authentication PASS. Delivery, polling and Cloudflare-origin compatibility remain unverified; see stack-validation.md.
- Cloud hosting; prioritize a free starting option such as Cloudflare.
- Retain tickets and attachments indefinitely. Free storage cannot be assumed sufficient forever.
- Dashboard accessible from anywhere, using separate staff passwords plus emailed verification codes.
- Documentation and specifications precede implementation; discuss open product questions one at a time.

## First-version exclusions

Employee portal, public registration, Zimbra single sign-on, HR/facilities workflows, different deadlines by priority, holiday calendars, and automatic retention deletion.

## Working approach

Start with one email-to-ticket flow and prove reliability before adding the full dashboard. Validate a candidate hosting architecture using representative email and attachment processing. Keep backups, restore checks, privacy, and delivery failures in the launch criteria.
