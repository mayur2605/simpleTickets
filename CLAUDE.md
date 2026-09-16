# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Read `AGENTS.md` and `docs/engineering-standards.md` first — they are the binding workflow rules. This file covers what those documents do not: repository layout, commands, and non-obvious couplings.

## Project overview

SimpleTickets is an email-based internal IT ticketing system for a 100-person organization with 5 IT staff. Employees submit requests via email to `support@allcheckservices.com`; IT works only in the dashboard and receives one-way notification emails that link back to it. Current status: an interactive frontend prototype with an enforced quality gate, plus a **deployed ingestion backend** that turns real emails into real tickets in D1. The two are not connected — the prototype is still in-memory — and the system cannot send any mail at all, so it can open a ticket but not answer one.

## Architecture

**Current state:**
- `prototype/`: React 19 + TypeScript + Vite frontend with Fluent UI React v9 components
- `prototype/src/domain/`: production domain rules, free of React, storage and transport — start here for business logic, not in `main.tsx`
- Single-file prototype (`src/main.tsx`) with in-memory state for UI review
- `worker/`: **deployed** Cloudflare Worker that polls Gmail over IMAP and opens tickets in D1. Real emails have become real tickets. No dashboard reads it yet — the prototype is still in-memory and unconnected.
- `scripts/check-mail-tls.mjs`: unauthenticated Zimbra TLS probe
- `tools/mail-check/`: interactive IMAP/SMTP authentication check, run by hand, its own package
- `.github/workflows/prototype-quality.yml`: runs `npm run verify` on push/PR — first remote run green 16 Sep 2026
- `.github/workflows/worker-quality.yml`: runs the worker gate on push/PR. Deploys are owned by Cloudflare Workers Builds, not by Actions
- Still missing: authentication, the dashboard-to-database connection, and any outgoing mail

**Production stack, as actually built:**
- Cloudflare Workers for the API and the two-minute ingestion cron
- D1 (`simpletickets`) for tickets, messages and the ingestion checkpoint — live
- Gmail IMAP (`simpleticketssupport@gmail.com`) for receiving, via App Password
- R2 for attachments and backups — not started
- Sending mail — **no transport chosen**; every candidate so far failed on outbound

## Architecture decision — 17 September 2026

Mail transport is **Gmail IMAP polling with a Google App Password**, on **Cloudflare
Workers**. This **reverses** the Resend decision taken earlier the same day: Resend's
inbound worked, but its outbound bounced on a HostKarma blacklisting we do not control.
Zimbra IMAP stays closed — a Worker cannot reach `mail.allcheckservices.com` on any port.

So `specs/001-email-ticketing/plan.md` and T010 are **current again**, not superseded:
two-minute polling with a UIDVALIDITY/UID checkpoint is the design, and `worker/`
implements it. Read the "Architecture decision" section of `AGENTS.md` and
`docs/stack-validation.md` before touching ingestion.

**Sending is still unsolved.** No transport has ever successfully sent a reply. Do not
write code that assumes one exists.

## Essential documents (read in order)

1. `AGENTS.md` — required engineering workflow and boundaries
2. `docs/engineering-standards.md` — mobile-first, test-first, type/lint policy, definition of done
3. `docs/git-workflow.md` — commit/push rules, binding on every agent
4. `docs/foundation.md` — core purpose, people, scale, boundaries
5. `docs/PRD.md` — product requirements with canonical requirement IDs (R01–R27)
6. `.specify/memory/constitution.md` — architectural principles and governance
7. `specs/001-email-ticketing/spec.md` — feature specification with acceptance scenarios
8. `specs/001-email-ticketing/plan.md` — provisional technical plan with feasibility gates
9. `specs/001-email-ticketing/tasks.md` — implementation tasks (T001–T028, none complete)
10. `docs/stack-validation.md` — what has actually been tested against Zimbra and Cloudflare
11. `docs/brand.md` — current palette, typography, contrast measurements
12. `docs/ui-direction.md` — UI decisions and prototype instructions

**Traceability:** PRD `R01`–`R28` are the canonical IDs. Spec acceptance scenarios cite them; tasks `T001`–`T028` implement them. A requirement change touches all four documents plus `docs/foundation.md` if a boundary moves.

**Document age matters.** `docs/brand.md` supersedes the earlier navy/blue description in the first half of `docs/ui-direction.md`. `docs/stack-validation.md` supersedes the PRD's "Open points" on mail verification. When documents disagree, the later evidence document wins — and fix the stale one.

**Claimed status is not evidence.** Distinguish proposed, implemented, locally verified and deployed. Re-run the gate rather than trusting a document that says it passed.

## Key constraints

These are product rules from the PRD, not descriptions of working code. The dashboard-only IT workflow, the notification set, the delivery-gated transitions, manual closure, the bounce pause and account-disabling redistribution were approved on 16 September 2026 and none of them is implemented — see the PRD's “Approved 16 September 2026 — not implemented” section.

- **Email domain:** Only `@allcheckservices.com` senders to `support@allcheckservices.com`
- **Work calendar:** Mon–Sat, 09:00–18:00 Asia/Kolkata (UTC+5:30)
- **Response deadline:** 4 working hours; Sunday messages due Monday 12:00
- **Assignment:** Fewest open tickets among available staff; round robin for ties
- **Statuses:** New, In Progress, Waiting for Employee, Resolved, Closed
- **Delivery-gated transitions (R28):** Waiting for Employee and Resolved take effect only when the outgoing mail server accepts the required public reply; until then status, deadlines and reminders are unchanged. The 72-hour auto-close clock starts at that acceptance. IT may also close a Resolved ticket manually, and either closure route leaves the ticket Resolved until the closure email is accepted. A later resolution bounce alerts assignee and admin and pauses auto-close until delivery is fixed.
- **Attachments:** 5 MB total per email
- **Backups:** Daily at 02:00 IST, 30-day retention
- **Staff availability:** Admin-only control; unavailable staff have tickets redistributed
- **Account disabling:** Admin-only; ends dashboard access and redistributes open tickets by the same assignment rules. Resolved/Closed tickets keep their historical owner

## Commands

All frontend work happens in `prototype/`:

```bash
npm ci                    # Install dependencies
npm run dev               # Preview server on http://127.0.0.1:5173
npm run verify            # The gate: typecheck + lint + format + unit + smoke + build
npm run typecheck         # tsc --noEmit
npm run lint              # eslint . --max-warnings 0
npm run format            # prettier --write .
npm run format:check      # prettier --check .
npm test                  # Browser smoke test (see below)
npm run test:unit         # vitest run — domain suites under src/domain/
npm run build             # tsc + vite build
```

`npm run test:unit` is part of `verify`, ahead of the slow browser test so a domain failure surfaces in seconds. CI inherits it by running `verify`. Vitest exits non-zero when it finds no test files, so never leave `src/domain/` without a suite.

Prettier owns formatting for everything except `node_modules`, `dist` and `package-lock.json`. Run `npm run format` after editing — an unformatted file fails the gate at `format:check`, before the tests ever run.

## The worker

The backend lives in `worker/` and is its own npm package with its own gate:

```bash
cd worker
npm ci
npm run verify        # typecheck + unit tests + `wrangler deploy --dry-run`
npm run test:unit     # vitest run — 17 cases, all against src/domain.ts
npm run deploy        # wrangler deploy (prefer the CI workflow)
```

- **It is deployed and live.** `simpletickets-api`, on the Cloudflare account belonging to
  `simpleticketssupport@gmail.com`, bound to the D1 database `simpletickets`.
- Secrets (`GMAIL_APP_PASSWORD`, `ADMIN_TOKEN`) are set with `wrangler secret put` and are
  **preserved across deploys**. Never put them in `wrangler.toml` or a workflow file.
- `fetch()` is token-gated and returns `404` — not `401` — to an unauthenticated caller,
  so the worker does not advertise itself. Routes: `GET /status`, `POST /poll`, `GET /diag`.
- Tests cover `domain.ts` only. `imap.ts`, `store.ts` and `index.ts` have none, so
  checkpoint recovery and idempotency-under-overlap are argued, not demonstrated.

### Deploying

Deploys are owned by **Cloudflare Workers Builds**, which pulls this repository directly.
Nothing deploys from GitHub Actions, and **no Cloudflare credential is stored in GitHub** —
that is the reason for this choice over a token-based Actions deploy.

Build configuration, set in the Cloudflare dashboard on `simpletickets-api`:

| Setting | Value |
| --- | --- |
| Root directory | `worker` |
| Build command | `npm run verify` |
| Deploy command | `npx wrangler deploy` |
| Build watch paths | `worker/*` |

**The watch path is load-bearing, not tidiness.** A Cloudflare schedule change takes up to
15 minutes to propagate globally and every deploy restarts that clock, so building on
documentation commits would keep the ingestion cron permanently inside a propagation
window. Do not widen it. This is not hypothetical: it invalidated a night of cron
measurements.

The build command is the gate, so a red gate fails the build and never deploys. Secrets
already set with `wrangler secret put` are preserved across deploys and are not managed by
the build — never put them in `wrangler.toml` or any workflow file.

`.github/workflows/worker-quality.yml` runs the same gate on push **and pull requests**,
which the deploy path does not cover. It never deploys.

Local deploys still work: `npm run deploy` in `worker/`, with wrangler's own OAuth login.

## The smoke test

`prototype/checks/smoke.mjs` is a single linear Playwright script, not a test runner: no watch mode, no filters, no way to run one case. It starts **its own Vite server on port 5174** (`strictPort`), so it does not touch a preview server on 5173 — but two concurrent smoke runs will collide on 5174.

It walks the whole prototype (filters, empty state, reply/status mapping, draft isolation, internal notes, template creation, responsive widths) and throws on the first failure or any browser console error.

Couplings to respect:
- It asserts **exact row and item counts** against the `seed` and `initialTemplates` arrays in `main.tsx`. Changing that sample data breaks the test — update both together.
- It **overwrites** `dashboard-preview.png`, `ticket-preview.png` and `mobile-preview.png` in `prototype/`. Those screenshots are outputs of a smoke run, not hand-made assets.
- Locally it launches `channel:"chrome"`, so real Google Chrome must be installed. Under `CI=true` it uses Playwright's bundled Chromium instead.

## Prototype conventions

`src/main.tsx` is one ~960-line Prettier-formatted file. It was originally written in a minified single-line style; that is gone. **Do not re-minify it** — Prettier is the enforced format.

- No router. Navigation is a `page` string in `useState`; all views are conditional expressions in one `App` return.
- All state is a `useState` cluster at the top of `App`. Sample data (`seed`, `initialTemplates`, `statuses`, `staff`) sits above it as module constants.
- The composer keeps `replyDraft` and `noteDraft` separate, with `draft`/`setDraft` selected by the `note` flag. Keep them separate: a shared draft lets an internal note land in the public reply box, which R13 and Constitution III forbid.
- Fluent brand tokens are overridden inline in the `FluentProvider` theme object (burnt orange `#B54720`), separately from the CSS files.
- CSS is **append-only override layers**: `style.css` holds successive design iterations, each block overriding the last, and `brand.css` is imported after it so its tokens win. To change the palette, edit `brand.css` and the `FluentProvider` theme — not the older blocks in `style.css`.
- The prototype CSS is still desktop-first. New work is mobile-first from 360 px per `docs/engineering-standards.md`; migrating the existing sheets is task T028, not a side effect of an unrelated change.

## Git

`docs/git-workflow.md` is binding. The two rules that override Claude Code defaults:

- **Never add AI attribution to a commit message.** No `Co-Authored-By:` naming a model or assistant, no "Generated with", no tool name, no robot emoji. The author is `mayur2605` and nothing else. This applies to pull request descriptions too.
- **`npm run verify` must exit 0 before you commit** — 0 TypeScript errors, 0 ESLint errors *and* warnings, 0 Prettier issues, smoke PASS, build clean. Never reach green by weakening a rule.

Also: check `.gitignore` and `git status --short` before staging, never commit a credential, and push only when asked.

Hooks in `.githooks/` enforce part of this automatically — enable them once per clone with `git config core.hooksPath .githooks`. They are a safety net, not the gate: `npm run verify` is still yours to run. Never use `--no-verify`.

## Working practices

**Documentation first:** Record user decisions in PRD and specs. Label proposed defaults clearly; distinguish user approval from draft technical choices.

**One question at a time:** Continue discussions incrementally rather than batching open questions.

**No credentials in documents:** Never add real passwords, tokens, or secrets to markdown files, source, logs, or command arguments. `tools/mail-check/check.mjs` prompts for the mailbox password interactively; never pass it as an argument.

**Spec Kit workflow:** This project follows GitHub Spec Kit's constitution → specification → plan → tasks pattern. These are manually authored; Spec Kit CLI is not installed yet (T002).

**Prototype limitations:** In-memory data, resets on refresh, no backend, fixed admin identity, sample due-date strings rather than a running clock, no permission enforcement. It sends no mail, so its status changes apply immediately and model none of the R28 delivery gating. UI controls demonstrate layout and flow, never authorization or backend correctness.

**Constitution principles (excerpt):**
- Email is the employee interface; no employee accounts required
- Mail ingestion is retryable and deduplicated
- Internal notes never reach employee email
- Persist UTC timestamps; evaluate business time in Asia/Kolkata
- Test constraints before choosing infrastructure
- Evidence before release: test round-trip emails, backup restore, authentication
- No external communication or production deployment is authorized by these documents; sending test mail requires explicit user authorization naming sender and recipients

## Unresolved items

- **Sending mail has no transport.** Zimbra SMTP is unreachable from Workers; Resend's outbound bounced on a HostKarma blacklisting outside our control. R02's acknowledgement, R13's replies and R15's failure visibility are all blocked on this. PRD open point 6.
- **The two-minute cron has never been observed firing.** Every ticket so far came from a manual `POST /poll`. Schedule, handlers and deployment all verify correct against the Cloudflare API. Under measurement — see "Cron trigger" in `docs/stack-validation.md`.
- **No mail reaches the system from the published address.** Employees write to `support@allcheckservices.com`; the poller reads `simpleticketssupport@gmail.com`. Nothing forwards between them yet. PRD open point 5.
- **The dashboard reads none of this.** Connecting the prototype to D1 is not started.
- R06 staff password hashing: Workers WebCrypto caps PBKDF2 at 100,000 iterations against current guidance of 600,000. Needs WebAssembly Argon2id/bcrypt or an explicit recorded acceptance.
- **DMARC policy is undecided**, and what the domain publishes today is not recorded in this repository, which is public. PRD open point 7.
- Backup storage provider and restore procedures not finalized; D1 Free gives 7 days of Time Travel against the agreed 30-day window, so separate exports are required
- CPU limits for MIME parsing and 5 MB attachments not measured
- What an employee reply should do to a transition whose required email is not yet accepted (PRD open point 3); SMTP acceptance-ambiguity detection (open point 4)
- ESLint pinned at 9 (jsx-a11y peer ceiling) though npm marks 9 out of support; TypeScript pinned to 6.0.2 for typed-ESLint compatibility
