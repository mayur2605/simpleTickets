# Takeover review — 16 September 2026

## Evidence and scope

Inspected the foundation, PRD, standards, brand, UI direction, constitution, feature spec/plan/tasks, prototype source/config/smoke checks, mail diagnostics and CI workflow. This directory is not a Git repository (`git status` fails); no commit history, diff baseline or remote CI result is available. No backend or deployment configuration was found. Wrangler is not on PATH. No mailbox connection, email transmission, account login, provisioning or deployment was performed during this review.

Implemented: fictional in-memory queue, All/My Tickets, attention/status/search filters, conversations, owner/priority editing, public reply simulation, internal notes, template management and workload display. The fixed admin identity is not authentication. Refresh discards state. Availability redistribution, priority/assignee filters and actual lifecycle jobs remain absent.

Only documented: database/API, server permissions, account/session lifecycle, mail ingestion/delivery, participant authorization, atomic assignment, calendars/reminders, private attachments, backup/restore and operations. Spec Kit documents remain manually authored.

## Prioritized findings

1. **P1 — Private draft exposed in public composer (fixed locally).** `prototype/src/main.tsx:171` now separates public/internal drafts. Previously the shared draft survived a mode switch, allowing internal content to be saved as public. The new browser regression first failed with expected public text versus actual private text, then passed after the fix. Sending clears only the active draft; opening another ticket clears both. This fixes a demo privacy hazard, not server email authorization.
2. **P1 — Delivery/transition policy was incomplete (decided 16 September 2026, not implemented).** This review raised the risk that applying Waiting immediately on enqueue hides an unsent reply and that applying Resolved starts closure too early. The user then approved R28: a Waiting or Resolved transition takes effect only on SMTP acceptance of its required public reply, the 72-hour auto-close clock is anchored to that acceptance, both closure routes stay Resolved until the closure email is accepted, and a later resolution bounce pauses automatic closure. See `docs/PRD.md` R28 and its “Approved 16 September 2026” section. Two narrower questions stay open there: what an employee reply does to a transition still awaiting acceptance, and how to detect ambiguous SMTP acceptance. No code implements any of this.
3. **P1 — Production trust/persistence boundaries do not exist (launch blocker).** `prototype/src/main.tsx:164` stores state in React; `prototype/src/main.tsx:205` simulates a send. All security/reliability items below are unimplemented, not vulnerabilities in a deployed service.
4. **P2 — Contradictory guidance (corrected).** `docs/ui-direction.md:7` previously prescribed navy/blue despite the later approved orange palette. Foundation/PRD/plan also said mail authentication was untested despite the recorded user PASS. Updated these to the approved brand and precise evidence: local TLS plus user-reported authentication; no delivery or Workers proof.
5. **P2 — Quality coverage is narrower than product requirements.** `prototype/checks/smoke.mjs:1` runs Chromium only. Width assertions cover the queue, not all detail/admin interactions. `prototype/src/style.css:539` and subsequent max-width overrides retain desktop-first architecture. `prototype/src/brand.css:211` includes 10 px metadata. The table scroll container needs a keyboard/screen-reader discoverability audit. Full keyboard journeys, 200% browser zoom, screen-reader checks, touch targets, forced colors and Firefox/WebKit remain unverified.
6. **P2 — Tooling/recovery baseline incomplete.** No Git metadata means there is no verified rollback/commit baseline. Root mail diagnostics are outside prototype gates. ESLint 9 remains unsupported; do not force peer dependencies. Unit testing is installed but no production domain module/suite exists. The new regression belongs to the existing browser gate, so it does not trigger the domain-unit gate requirement.

## Security and reliability gap map

| Boundary | Required implementation/evidence |
| --- | --- |
| Threading and launch cutoff | Durable UIDVALIDITY/UID identity, immutable activation boundary, downtime recovery, duplicate constraints, validated References/In-Reply-To, conflicting-reference and UIDVALIDITY recovery tests. Sender-controlled Date/Message-ID cannot independently establish arrival/authorization. |
| Sender authorization | Trusted Zimbra-origin identity evidence and explicit staff/requester/participant authorization. Reject forged From and untrusted Authentication-Results. Quarantine unverifiable mail without creating bounce loops. |
| CC participants | Exact case-insensitive domain comparison, support-address exclusion, requester-only email additions, audited IT removals, future-only delivery and denial after removal. No participant model exists yet. |
| Assignment | Persisted tie cursor, workload counts including Waiting, atomic selection/update, redistribution with recalculation, retry-safe audit/outbox, concurrency tests. UI owner selection is not this algorithm. |
| Deadlines | Shared injected clock/calendar, UTC storage, Sunday exception only for new episodes, preserved earlier deadline, deduplicated reminders, closure/reply race checks. Current due strings are static demo text. |
| Outgoing mail | Atomic durable intents, delivery states, bounded retries, ambiguous acceptance visibility, stable identifiers and policy for pending transitions. SMTP verification alone does not prove sender permission or delivery. |
| Sessions | Password hashing, single-use hashed OTPs, expiry/attempt limits, throttling, secure cookies, CSRF, disabled-account invalidation and recovery. No server routes exist to enforce these. |
| Attachments | Decoded aggregate/inline limit, body preservation on rejection, bounded MIME parsing, private authorized downloads, safe headers, sanitization and no remote tracking. No attachment storage exists. |
| Restoration | Daily consistent database plus attachment recovery points; integrity manifests, protected backup permissions, dependency-safe 30-day pruning, failure alerts, full restore with actual duration. No restore has run. |

The detailed design intent is in `specs/001-email-ticketing/plan.md:26` (ingestion), `:28` (authorization), `:30` (outbox), `:32` (delivery-gated transitions), `:34` (bounce handling), `:36` (assignment), `:38` (deadlines), `:42` (sessions/attachments), and `:44` (notifications and recovery).

## Local verification

- `npm ci`: passed; audit reported zero vulnerabilities, ESLint support warning and fsevents install-script policy warning. No policy override was applied.
- Baseline `npm run verify`: passed before edits.
- Added browser regression: observed intended failure, public field contained private draft.
- Final `npm run verify`: passed typecheck, zero-warning lint, formatting, browser journey/360–390–768–1440 queue overflow checks and production bundle build.
- Smoke checks regenerated the three existing preview PNGs. No visual styles changed.
- Remote CI, Firefox/WebKit, full accessibility and backend correctness: not verified.
- Runtime reproducibility follow-up: interactive shell reports Node 24.20.0; failing npm-launched browser test reported Node 26.8.1. CI requests Node 24. Establish one explicit runtime path/version in the next tooling milestone; this run alone is not evidence of Node-24 CI success.

## Tooling resolution plan

Registry metadata checked during review: latest `eslint-plugin-jsx-a11y` declares ESLint support only through 9; installed `typescript-eslint@8.70.0` supports ESLint 10 but TypeScript below 6.1. Preserve the current compatible lockfile. Upgrade when the accessibility plugin supports ESLint 10, or evaluate a replacement retaining equivalent accessibility checks, then run the complete gate. Do not drop rules or override peers. Pin a reproducible Node runtime, extend type/lint/format/test gates to any new package, and add unit checks to verify/CI with the first production domain module. Initialize version control without overwriting existing files before deployment work.

## Next milestone: isolated runtime feasibility harness

See [runtime acceptance plan](runtime-feasibility.md). This is the next proposed milestone, not a completed Worker. Prove TLS/client compatibility, secure password verification and representative MIME parsing under the candidate runtime before selecting hosting. Then implement one synthetic email-to-ticket/outbox slice with durable constraints and fault tests. Preserve the current UI throughout.
