# SimpleTickets agent instructions

Read docs/engineering-standards.md, docs/PRD.md, docs/brand.md and the feature specification before modifying application behavior. Keep the approved burnt-orange visual identity. Ask one question at a time when a product decision is required.

## Architecture decision — 17 September 2026, read before implementing ingestion

Mail transport is **Gmail IMAP polling with a Google App Password**, from a Cloudflare
Worker on a two-minute cron. The mailbox is `simpleticketssupport@gmail.com`. Evidence
and full measurement history: `docs/stack-validation.md`.

**This reverses the Resend decision recorded earlier the same day, and restores IMAP
polling.** Three transports were tried and closed with evidence before this one:

| Transport | Outcome |
| --- | --- |
| Zimbra IMAP (`mail.allcheckservices.com`) | Closed. A Worker cannot reach it on 993, 465 or 587 — all time out, as does the bare IP, while `imap.gmail.com:993` connects from the same Worker in 68 ms and the development machine reaches the same host fine. The mail host drops Cloudflare's traffic. No code change alters this. |
| Resend | Closed. Inbound worked end to end on the first attempt, but **outbound bounced**: `550 ... black list hostkarma.junkemailfilter.com`. The sending IP was clean on Spamhaus ZEN and SpamCop, so this is not ours to fix. A transport that cannot reply is not a ticketing transport. |
| Gmail API | Closed. `gmail.readonly` is a restricted scope; Publish App is disabled on this project, and an unpublished app expires its refresh token every 7 days. |
| **Gmail IMAP + App Password** | **Accepted.** Proved end to end: Workers reach Gmail, `imapflow` runs under `nodejs_compat`, an App Password authenticates without OAuth, and real emails have become tickets in D1. |

So `specs/001-email-ticketing/plan.md` and T010 are **no longer superseded** — two-minute
polling, the UIDVALIDITY/UID checkpoint and the UID launch cutoff are the design again,
and are partly implemented in `worker/`. R01 keeps `support@allcheckservices.com` as the
published address only if Zimbra forwards to the Gmail mailbox; that forwarding is an
open product decision and is **not** configured.

What is built and proved in `worker/`:

1. `scheduled()` on `crons = ["*/2 * * * *"]` calls `ingest()`.
2. `readNewMail()` fetches UIDs above the checkpoint; `ingest_log.uid` is the primary key,
   so a retried or overlapping run inserts nothing the second time and one email can never
   open two tickets.
3. First run adopts `uidNext - 1` and imports nothing, which is R27's launch cutoff in one
   integer.
4. `createTicket()` writes ticket, message and log in one D1 batch so they commit together.

Known IMAP behaviours that cost real debugging time, recorded so they are not rediscovered:

- A `N:*` range **always returns the newest message** even when nothing is new. Idempotency
  is what makes this safe, not the range.
- Fetching a **UID range** stalls; fetching a **single UID** does not. Poll one UID at a time.
- `bodyParts` returns the raw transfer encoding. Use `download()` instead, or decode by hand.
- A **single-part** message has no part identifier, so `download()` with one returns the
  entire raw message including headers. Address `"TEXT"`.
- Gmail-composed mail is frequently **HTML-only**; `htmlToText()` in `worker/src/domain.ts`
  exists because of this.

Still unproved on this stack: **sending has never been tested** from any transport,
delivery-failure visibility for R15 has no mechanism yet, and Workers WebCrypto refuses
PBKDF2 above 100,000 iterations, which blocks R06 until Argon2id/bcrypt via WebAssembly is
chosen or the cap is explicitly accepted. The cron trigger's reliability is under active
measurement — see "Cron trigger" in `docs/stack-validation.md`.

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
