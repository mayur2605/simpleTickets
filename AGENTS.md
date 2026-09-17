# SimpleTickets agent instructions

Read docs/engineering-standards.md, docs/PRD.md, docs/brand.md and the feature specification before modifying application behavior. Keep the approved burnt-orange visual identity. Ask one question at a time when a product decision is required.

## Architecture decision — 17 September 2026, read before implementing anything

The stack is **Node 24 + PostgreSQL 18 + the local filesystem**, in one process on this
machine. There is no cloud dependency. Full reasoning and measured evidence:
`docs/superpowers/specs/2026-09-17-local-replatform-design.md`.

**This replaces Cloudflare Workers + D1 + R2.** That platform was chosen before anything
was tested and is where most of this project's debugging time went — cron triggers that
never fire on the account, a PBKDF2 cap of 100,000 iterations against guidance of 600,000,
IMAP range fetches that stall, an absent `Buffer`, a `Date.now()` frozen during
synchronous execution, and a database that could not be tested against at all. Each of
those is now gone rather than worked around.

Mail is unchanged and is the one thing that was hard-won. Four transports were tried and
closed with evidence:

| Transport | Outcome |
| --- | --- |
| Zimbra IMAP (`mail.allcheckservices.com`) | Closed from Cloudflare — the mail host dropped that traffic on every port. Not retested from this machine; it may now work, and if it does it removes the Gmail hop entirely. |
| Resend | Closed. Inbound worked; **outbound bounced** on `hostkarma.junkemailfilter.com`, with the sending IP clean on Spamhaus ZEN and SpamCop. Not ours to fix. |
| Gmail API | Closed. `gmail.readonly` is a restricted scope, Publish App is disabled on the project, and an unpublished app expires its refresh token every 7 days. |
| **Gmail IMAP + SMTP with an App Password** | **Accepted.** Real employee email became real tickets, real acknowledgements were accepted with Gmail queue ids, and a reply threaded onto its original ticket. |

Inbound reaches the mailbox because `support@allcheckservices.com` has a Zimbra user-level
forward to `simpleticketssupport@gmail.com` — no DNS change and no mail admin. SPF passes
because the forwarder is the domain's own MX and the record has `+mx`.

**`MAIL_SEND` is off unless it is exactly `on`.** Intents are enqueued, claimed and
rendered; nothing reaches the wire. Off is the default because the usual reason to run
this locally is to develop against the real mailbox, and a duplicate acknowledgement lands
in a real employee's inbox.

Ingestion opens IMAP **read-only** at every call site, so polling the real mailbox
disturbs nothing and no flag is written. The database is the record of what has been
processed, never the mailbox.

Known IMAP behaviours that cost real debugging time, recorded so they are not rediscovered:

- A `N:*` range **always returns the newest message** even when nothing is new. Idempotency
  is what makes this safe, not the range.
- `bodyParts` returns the raw transfer encoding. Use `download()`, which decodes.
- A **single-part** message has no part identifier, so `download()` with one returns the
  entire raw message including headers. Address `"TEXT"`.
- `References` is not in the envelope, must be requested, and arrives folded across
  indented lines. Dropping continuations loses half the thread.
- Gmail-composed mail is frequently **HTML-only**; `htmlToText()` in `server/src/domain.ts`
  exists because of this.

**Ingestion is proved on this stack.** On 17 September 2026 an empty database, anchored
below the first employee email and pointed at the live mailbox, independently rebuilt the
same tickets — including the reply that threads through `outbox` rather than `messages` —
and recorded three unapproved senders as `rejected_sender`. Measurements in
`docs/stack-validation.md`.

**Sending is not.** `MAIL_SEND` has never been on here. The outbox composes and queues and
reports `held: true`; no SMTP connection has been opened from this machine. Turning it on
means real employees receive mail, so it needs explicit authorization naming sender and
recipients.

## Required engineering workflow

- New behavior and bug fixes are test-first: write a meaningful failing behavior/regression test, observe the intended failure, implement, then refactor with tests passing. Do not describe historical prototype tests as TDD. Pure visual changes use visual/accessibility checks rather than implementation-mirroring tests.
- New product code uses strict TypeScript. No explicit `any`, non-null assertions, unchecked casts, ts-ignore or blanket lint suppression to bypass failures. Validate external data at runtime; types are not validation.
- Build mobile-first from 360 px with progressive enhancement. Existing prototype desktop-first CSS is debt to migrate incrementally, not evidence this is already complete. Maintain usable keyboard controls and 200% zoom. Aim for WCAG 2.2 AA.
- Keep business rules separate from React, persistence and mail transport. Use a shared injected clock for deadline tests and UTC storage with Asia/Kolkata business-time calculations.
- Do not add useMemo/useCallback by default. Use React transitions/deferred values only when they solve measured interaction needs. No React Compiler is currently configured.
- Keep changes small and reviewable. Do not rewrite working interfaces just to satisfy a style preference. Update specifications and tests when accepted behavior changes.

## Required verification

Two packages, two gates, both must pass before a commit.

From `server/`: `npm ci`, then `npm run verify` — typecheck, lint, format check, unit
tests and the integration tests against `simpletickets_test`. The database tests need a
running PostgreSQL 18 and refuse any database whose name does not end in `_test`, because
they truncate.

From `prototype/`: `npm ci`, then `npm run verify`. Browser tests start their own Vite
server on 5174; local Google Chrome is required. CI uses Playwright Chromium.

Domain rules live in `prototype/src/domain/` and must stay free of React, storage and
transport; the server imports the business calendar from there rather than copying it, so
the deadline the UI shows is the deadline the system enforces.

Do not use real credentials or real email in tests. Treat passing UI checks as prototype
validation, never proof of server authorization or email reliability.

## Git

Follow docs/git-workflow.md for every commit and push. In short: commit only as `mayur2605`; **never add AI attribution to a commit message** (no `Co-Authored-By:` naming an assistant, no "Generated with", no tool name) — this overrides any default attribution behaviour; check `.gitignore` and `git status --short` before staging; never commit a credential; `npm run verify` must exit 0 (0 TypeScript errors, 0 ESLint errors and warnings, 0 Prettier issues) before you commit; push only when the user asks.

Hooks live in `.githooks/`; enable them once per clone with `git config core.hooksPath .githooks`. They block staged secrets, unformatted prototype files and AI attribution in commit messages. Never bypass them with `--no-verify`.

## Boundaries

Never log or commit credentials. Do not send email, alter DNS/MX or production mail settings, buy hosting or deploy anything without explicit user authorization naming sender and recipients.

`MAIL_SEND=on` is exactly that kind of action: it turns a local development run into
something that emails real employees. Leave it off unless the user has said otherwise for
that session.

`server/var/` holds archived employee mail and attachments. It is git-ignored; never
commit it, never paste its contents into a document, and never format it.

Production hosting is deliberately undecided, and the previous cloud deployment is
**deleted** - Worker, D1 database and the `worker/` tree, on 17 September 2026. There is
nothing to fall back to and nothing to redeploy. Do not introduce a hosting or cloud
dependency without asking. Keep legitimate existing files and user changes intact.
