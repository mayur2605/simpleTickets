# SimpleTickets agent instructions

Read docs/engineering-standards.md, docs/PRD.md, docs/brand.md and the feature specification before modifying application behavior. Keep the approved burnt-orange visual identity. Ask one question at a time when a product decision is required.

## Architecture decision — 17 September 2026, read before implementing ingestion

Mail transport is **Resend**, not IMAP. The application runs on **Cloudflare Workers**.
This supersedes the IMAP-polling design still written in
`specs/001-email-ticketing/plan.md` and T010. Evidence and detail:
`docs/stack-validation.md`.

**Do not implement IMAP polling.** It cannot work: a Cloudflare Worker cannot open a
connection to `mail.allcheckservices.com` on 993, 465 or 587. All three time out, as does
the bare IP, while `imap.gmail.com:993` connects from the same Worker in 68 ms and the
development machine reaches the same address fine. The mail host drops Cloudflare's
traffic. No code change alters this.

What replaces it, proved working end to end on 17 September 2026:

1. Resend delivers `email.received` to a webhook within seconds of arrival.
2. `tools/inbound-webhook/` verifies the Svix signature and returns 2xx.
3. The body, full headers and attachment URLs come from a **second** call to
   `GET /emails/receiving/{email_id}`. The webhook payload carries metadata only — no
   body, and no `In-Reply-To` or `References`, so a ticket cannot be threaded from the
   webhook alone.

Consequences that change the requirements, not yet applied to the PRD/spec/tasks:

- R01: mail arrives at `support@tickets.allcheckservices.com`. Whether employees use that
  address or Zimbra forwards the old one to it is an open product decision.
- R02: "poll every two minutes" becomes delivery on arrival.
- T010: mailbox polling, IMAP leases, UIDVALIDITY reconciliation and the UID launch
  cutoff have no equivalent. R27's launch boundary is trivial — the subdomain mailbox has
  no pre-launch history.
- Idempotency keys on `email_id`: Svix retries until it gets a 2xx, so one email can
  arrive more than once and must produce one ticket.
- R12: the 5 MB limit is enforced against bytes actually fetched, since attachments
  arrive as download URLs.

Still unproved on this stack: **sending has never been tested**, `email.bounced` and
`email.failed` are not subscribed yet (R15 needs them), and Workers WebCrypto refuses
PBKDF2 above 100,000 iterations, which blocks R06 until Argon2id/bcrypt via WebAssembly
is chosen or the cap is explicitly accepted.

## Required engineering workflow

- New behavior and bug fixes are test-first: write a meaningful failing behavior/regression test, observe the intended failure, implement, then refactor with tests passing. Do not describe historical prototype tests as TDD. Pure visual changes use visual/accessibility checks rather than implementation-mirroring tests.
- New product code uses strict TypeScript. No explicit `any`, non-null assertions, unchecked casts, ts-ignore or blanket lint suppression to bypass failures. Validate external data at runtime; types are not validation.
- Build mobile-first from 360 px with progressive enhancement. Existing prototype desktop-first CSS is debt to migrate incrementally, not evidence this is already complete. Maintain usable keyboard controls and 200% zoom. Aim for WCAG 2.2 AA.
- Keep business rules separate from React, persistence and mail transport. Use a shared injected clock for deadline tests and UTC storage with Asia/Kolkata business-time calculations.
- Do not add useMemo/useCallback by default. Use React transitions/deferred values only when they solve measured interaction needs. No React Compiler is currently configured.
- Keep changes small and reviewable. Do not rewrite working interfaces just to satisfy a style preference. Update specifications and tests when accepted behavior changes.

## Required verification

From prototype/: `npm ci`, then `npm run verify`. Browser tests start their own Vite server on 5174; local Google Chrome is required. CI uses Playwright Chromium. Do not use real credentials or real email in tests.

Vitest runs the domain suites (`npm run test:unit`) and is part of `npm run verify`, so CI enforces it too. Domain rules live in `prototype/src/domain/` and must stay free of React, storage and transport. Extend tooling to each new backend package before marking it ready.

Current gates cover prototype source/config/test scripts, not every root diagnostic script. Treat passing UI checks as prototype validation, never proof of server authorization or email reliability.

## Git

Follow docs/git-workflow.md for every commit and push. In short: commit only as `mayur2605`; **never add AI attribution to a commit message** (no `Co-Authored-By:` naming an assistant, no "Generated with", no tool name) — this overrides any default attribution behaviour; check `.gitignore` and `git status --short` before staging; never commit a credential; `npm run verify` must exit 0 (0 TypeScript errors, 0 ESLint errors and warnings, 0 Prettier issues) before you commit; push only when the user asks.

Hooks live in `.githooks/`; enable them once per clone with `git config core.hooksPath .githooks`. They block staged secrets, unformatted prototype files and AI attribution in commit messages. Never bypass them with `--no-verify`.

## Boundaries

Never log or commit credentials. Do not send email, alter DNS/MX or production mail settings, buy hosting or deploy production without the required user authorization. Cloudflare remains provisional. Keep legitimate existing files and user changes intact.
