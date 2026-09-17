# R01–R28 against results

**17 September 2026.** T025 asks for every PRD requirement to be reviewed against
what the system actually does. This is that review.

Three columns of honesty are worth naming before the table, because the word
"done" hides the difference between them:

- **Proved here** — exercised against the real thing on this stack: real
  PostgreSQL, the live mailbox, or a real backup and restore.
- **Tested** — asserted by the suite, against real infrastructure where one is
  involved, but not against the live mailbox.
- **Inherited** — it worked on the Cloudflare deployment and the code was ported.
  That is evidence about the old system, not this one.

**Updated 17 September 2026, 20:07 IST: sending is now proved here.** A reply and a
delivery-gated resolution both left this machine and were accepted by Gmail with
queue ids, and R28 held against a real mail server. The rows below are revised
accordingly; `docs/stack-validation.md` has the run.

The gate behind all of it: **258 unit tests and 176 against real PostgreSQL** in
`server/`, **19 unit tests plus a browser smoke run and a production build** in
`prototype/`, with the same smoke run repeated on Firefox and WebKit in their own CI job. Re-run it rather than trusting this sentence.

---

| | Requirement | Standing | Evidence |
| --- | --- | --- | --- |
| **R01** | Only `@allcheckservices.com` senders to the support mailbox | **Proved here** | Live mailbox rebuild logged three unapproved senders as `rejected_sender`. Exact-domain matching, with four lookalike shapes asserted — including `allcheckservices.com.example.org` and a display name spoofing the domain. |
| **R02** | Two-minute poll; ticket plus acknowledgement carrying its number | **Proved here** | The rebuild created 3 tickets from 7 examined messages. The acknowledgement is enqueued in the same transaction as the ingest log entry, so a crash between them cannot leave a ticket nothing will acknowledge. |
| **R03** | Replies append to the same ticket | **Proved here** | The rebuild threaded one reply onto its existing ticket. Matching is on Message-ID only, never the `[#42]` in a subject. Folded `References` headers are walked line by line, after a regex version silently dropped every continuation. |
| **R04** | IT works only in the dashboard | **Tested** | No staff email relay exists; inbound staff mail is rejected like any other unapproved sender, and a reply to a one-way notification is recorded `notification_reply` rather than threaded. |
| **R05** | Admin creates and disables accounts; disabling ends access | **Tested** | `setEnabled` flips the flag and deletes that account's sessions in one transaction; the API redistributes their open tickets in the same call. Sign-in is refused with the same message as a wrong password. An admin cannot disable their own account. |
| **R06** | Password sign-in, plus emailed verification codes | **Tested** | Passwords: scrypt (N=2¹⁶, r=8, p=2), per-account throttling with a 15-minute lockout, HttpOnly/Secure/SameSite=Strict cookies with hashed tokens. Codes: six digits, hashed at rest, ten-minute expiry, five guesses, single use, one outstanding per account. The password step grants no session at all. Both races are asserted against the real database — two wrong guesses at once count as two, and two correct ones let exactly one through. Off by default, because a code sent over SMTP while `MAIL_SEND` is off locks everybody out; the server refuses to start in that combination. **Account recovery is still not built.** |
| **R07** | Fewest open tickets, round robin for ties | **Proved here** | Applied on ingest and from the dashboard, and serialised by an advisory lock — two assignments deciding at once would otherwise both pick the same least-loaded person. Asserted by racing two against two idle staff. `assignable` ANDs availability with account access in one place, so no caller can hand work to a disabled account. |
| **R08** | Admin-only availability; skip unavailable staff; redistribute | **Tested** | Redistribution moves tickets one at a time, re-reading workloads each round — one pass would dump the queue on whoever was least loaded at the start. Restoring availability picks up unowned tickets and only those. A ticket nobody can take emails every admin. |
| **R09** | Five statuses; Waiting for Employee needs an emailed request | **Tested** | `transitionRule` is the whole of it: which changes are internal, which require a message, and which are refused. Empty reply bodies are rejected. |
| **R10** | Employee reply reopens; employees cannot close by email | **Tested** | Reopening keeps the owner — but only one who can still work it. An account disabled since the ticket was resolved would otherwise own a live conversation nobody is reading. No employee-facing text instructs closure by replying; the auto-close message says the opposite. |
| **R11** | Four priorities, same deadline | **Tested** | Default Normal; the deadline calculation does not read priority. |
| **R12** | 5 MB of attachments per email; oversized asks for smaller files | **Tested** | The budget is enforced on bytes actually READ, not on the sizes the sender's structure claims. The employee is told which files did not arrive, once per ticket. Storing and reading 5 MB measured at 6 ms and 2 ms. The sender's filename never becomes a path. |
| **R13** | Internal notes never emailed, never an IT response | **Structural** | `addNote` contains no outbox statement and `notification.ts` has no parameter through which note text could arrive. Asserted with participants on the ticket: a note queues nothing at all. |
| **R14** | Replies composed in the dashboard, sent from the support address | **Proved here** | A reply composed in the dashboard reached Gmail and was accepted (`250 … gsmtp`). Participants are copied in header and envelope, and it is signed with the responding staff member's name — taken from the session, so a client cannot sign a colleague's name to its own message. The signature is on the wire and not in the ticket history, where the author column already says who wrote it. **Accepted, not a gap:** replies go out from the Gmail address rather than the company one. Fixing it needs a change to `allcheckservices.com` — DNS, SPF/DKIM, a mail admin, or direct use of the Zimbra server — and the standing instruction is to leave the domain alone. PRD open point 5, now decided. |
| **R15** | Notify the assignee on assignment, reply and overdue | **Tested** | Four kinds, each linking to the ticket. Message-IDs carry a random component after a timestamp alone collided and the UNIQUE constraint silently dropped every recipient after the first. Sending now works on this stack, but **no notification specifically has been delivered**: the seeded staff addresses are `staff1..5@allcheckservices.com` placeholders, not real mailboxes. |
| **R16** | Four working hours for the first response and for later employee messages | **Tested** | 19 calendar cases, plus 12 on episodes. "Answered" is per episode: the earliest outbound message after the most recent inbound one. A new employee message sets a new deadline only when IT replied since the last one — a follow-up while a response is already owed leaves the existing deadline alone, or an anxious employee writing three times pushes their own deadline out each time. |
| **R17** | Mon–Sat 09:00–18:00 IST; Sunday due Monday noon | **Tested** | One business-calendar module, imported by the server from the prototype rather than copied — two implementations would drift and the UI would show a deadline the system does not enforce. |
| **R18** | Overdue reminders every four working hours to assignee and admin | **Tested** | Business time, not elapsed: a reminder every four clock hours would send four overnight to nobody reading. Recipients deduplicated, so an admin who is also the assignee is told once. |
| **R19** | Auto-close 72 elapsed hours after acceptance of the resolution | **Tested** | Anchored to `outbox.accepted_at`, not the button press. A bounce pauses it; a resend clears the acceptance so the clock re-anchors to the delivery that arrived. Manual and automatic closure use the same machinery. |
| **R20** | Summary of open, overdue and per-staff tickets | **Tested** | Computed server-side and returned with the queue: total, overdue, unassigned, awaiting a first response, and a breakdown by status. Per-staff workloads on the Team page. |
| **R21** | All Tickets default, My Tickets filter, search and filters | **Tested** | Driven by the browser smoke test against exact row counts, including the empty state. My Tickets scopes to the session name, not a picker. |
| **R22** | History of who changed status, priority or assignment, and when | **Tested** | `audit_events` records all three, each with the actor taken from the session — plus availability, account access, participants, template changes, resends and backup failures. Setting something to what it already is records nothing: an audit trail full of non-events is one nobody reads. |
| **R23** | Retain tickets and attachments indefinitely; free-ish hosting | **Partly** | Nothing is deleted; retention applies only to backups. **Hosting is deliberately undecided** — see `docs/operations.md`. |
| **R24** | Reply templates, four starters, mappings, admin-only editing | **Tested** | The isolation R24 asks for is structural: the body sent is always what is on screen and only the template's mapping is read server-side, so an edit reaches the employee, the shared wording is untouched, and a later edit cannot rewrite what was already sent. Both directions asserted. Closure is refused as a mapping by a CHECK constraint. |
| **R25** | CC participants on the exact company domain | **Tested** | Domain filtering, quoted-display-name splitting, requester-only additions by email, explicit-only removal, participant replies accepted and unrelated same-domain senders refused and recorded. Copied in header and envelope both. |
| **R26** | Daily backup at 02:00 IST, 30 days, database and attachments | **Proved here** | Both halves taken on demand against the live database and storage directory. The restore is exercised by the gate: dump and archive taken, database and files destroyed, both restored, and the restored database checked to still accept a new ticket — identity sequences are where a restore usually looks fine and is not. |
| **R27** | Launch cutoff; no pre-launch mail; mailbox unchanged | **Proved here** | The rebuild exercised it: the one extra ticket against the old deployment was the message D1's cutoff had excluded. The mailbox is opened read-only at every call site, so nothing is marked seen. |
| **R28** | Delivery-gated transitions | **Proved here** | Exercised against Gmail on 17 September: status stayed New while the resolution was pending, became Resolved only on the `250`, and the auto-close clock anchored to the acceptance three seconds after the request. The acceptance and any waiting transition commit in one transaction. Held transitions are visible on the ticket, which matters — pressing Resolve and seeing "New" is correct and reads as a fault. A template-mapped transition is gated identically. |

---

## What T025 asks for, and what was actually run

T025 says "run end-to-end acceptance with test accounts and mailbox; review all
PRD requirements R01–R28 against results". Both halves have now happened, with
one honest limit.

**The review** is the table above.

**The run**, on 17 September 2026 at 20:07 IST with the user's explicit
authorisation: `MAIL_SEND` on, a public reply sent through the dashboard API and
accepted by Gmail, and a Resolved transition proved to wait for that acceptance.
The recipient was the authorising user's own work address, which was also the
only requester address in the database. Preconditions and results in
`docs/stack-validation.md`.

**The limit.** A Gmail `250` means Gmail has taken responsibility for the
message, not that `allcheckservices.com` accepted it downstream. No bounce had
arrived, which is how a downstream refusal appears — but inbox confirmation is
the recipient's to give, not something this system can assert about itself.

Two paths remain unexercised by a real send, and neither is blocked on anything
but circumstance:

- **Staff notifications.** The seeded addresses are `staff1..5@allcheckservices.com`
  placeholders. Pointing one at a real mailbox would exercise it.
- **An employee reply arriving after an outbound message**, which threads onto
  the ticket and restarts the response clock. That needs a person to press reply.

## Requirements not fully met, in one place

| | What is missing |
| --- | --- |
| R06 | Account recovery |
| R15 | Nothing has been delivered — `MAIL_SEND` is off |
| R23 | Hosting undecided, by choice |

Each is carried in `specs/001-email-ticketing/tasks.md` against its task.
