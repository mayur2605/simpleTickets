# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Read `AGENTS.md` and `docs/engineering-standards.md` first — they are the binding workflow rules. This file covers what those documents do not: repository layout, commands, and non-obvious couplings.

## Project overview

SimpleTickets is an email-based internal IT ticketing system for a 100-person organization with 5 IT staff. Employees submit requests via email to `support@allcheckservices.com`; IT works through a dashboard or email. Current status: interactive frontend prototype with an enforced quality gate; production backend not implemented.

## Architecture

**Current state:**
- `prototype/`: React 19 + TypeScript + Vite frontend with Fluent UI React v9 components
- Single-file prototype (`src/main.tsx`) with in-memory state for UI review
- `scripts/check-mail-tls.mjs`: unauthenticated Zimbra TLS probe
- `tools/mail-check/`: interactive IMAP/SMTP authentication check, run by hand, its own package
- `.github/workflows/prototype-quality.yml`: runs `npm run verify` on push/PR (not yet verified remotely)
- No backend, authentication, database, or email integration yet

**Planned production stack (provisional):**
- Cloudflare Workers for API and scheduled jobs
- D1 for tickets, messages, accounts, templates, audit events
- R2 for attachments and backups
- Zimbra IMAP/SMTP integration (mail.allcheckservices.com)

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

**Traceability:** PRD `R01`–`R27` are the canonical IDs. Spec acceptance scenarios cite them; tasks `T001`–`T028` implement them. A requirement change touches all four documents plus `docs/foundation.md` if a boundary moves.

**Document age matters.** `docs/brand.md` supersedes the earlier navy/blue description in the first half of `docs/ui-direction.md`. `docs/stack-validation.md` supersedes the PRD's "Open points" on mail verification. When documents disagree, the later evidence document wins — and fix the stale one.

**Claimed status is not evidence.** Distinguish proposed, implemented, locally verified and deployed. Re-run the gate rather than trusting a document that says it passed.

## Key constraints

- **Email domain:** Only `@allcheckservices.com` senders to `support@allcheckservices.com`
- **Work calendar:** Mon–Sat, 09:00–18:00 Asia/Kolkata (UTC+5:30)
- **Response deadline:** 4 working hours; Sunday messages due Monday 12:00
- **Assignment:** Fewest open tickets among available staff; round robin for ties
- **Statuses:** New, In Progress, Waiting for Employee, Resolved (auto-closes after 72h), Closed
- **Attachments:** 5 MB total per email
- **Backups:** Daily at 02:00 IST, 30-day retention
- **Staff availability:** Admin-only control; unavailable staff have tickets redistributed

## Commands

All frontend work happens in `prototype/`:

```bash
npm ci                    # Install dependencies
npm run dev               # Preview server on http://127.0.0.1:5173
npm run verify            # The gate: typecheck + lint + format:check + test + build
npm run typecheck         # tsc --noEmit
npm run lint              # eslint . --max-warnings 0
npm run format            # prettier --write .
npm run format:check      # prettier --check .
npm test                  # Browser smoke test (see below)
npm run test:unit         # vitest run — exits 1 today, no domain tests exist yet
npm run build             # tsc + vite build
```

`npm run test:unit` is deliberately **not** in `verify`: Vitest exits non-zero with no test files. Add it to `verify` and to the CI workflow with the first production domain module.

Prettier owns formatting for everything except `node_modules`, `dist` and `package-lock.json`. Run `npm run format` after editing — an unformatted file fails the gate at `format:check`, before the tests ever run.

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

**Prototype limitations:** In-memory data, resets on refresh, no backend, fixed admin identity, sample due-date strings rather than a running clock, no permission enforcement. UI controls demonstrate layout and flow, never authorization or backend correctness.

**Constitution principles (excerpt):**
- Email is the employee interface; no employee accounts required
- Mail ingestion is retryable and deduplicated
- Internal notes never reach employee email
- Persist UTC timestamps; evaluate business time in Asia/Kolkata
- Test constraints before choosing infrastructure
- Evidence before release: test round-trip emails, backup restore, authentication
- No external communication or production deployment is authorized by these documents; sending test mail requires explicit user authorization naming sender and recipients

## Unresolved items

- Cloudflare-origin Zimbra connectivity, CPU limits for password hashing and MIME parsing, not validated
- Mail delivery round trip never performed; only TLS handshakes and a user-reported local auth check
- Backup storage provider and restore procedures not finalized
- Production hosting choice pending feasibility tests
- CI workflow has never run remotely
- ESLint pinned at 9 (jsx-a11y peer ceiling) though npm marks 9 out of support; TypeScript pinned to 6.0.2 for typed-ESLint compatibility
