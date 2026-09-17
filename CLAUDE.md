# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Read `AGENTS.md` and `docs/engineering-standards.md` first — they are the binding workflow rules. This file covers what those documents do not: repository layout, commands, and non-obvious couplings.

## Project overview

SimpleTickets is an email-based internal IT ticketing system for a 100-person organization with 5 IT staff. Employees submit requests via email to `support@allcheckservices.com`; IT works only in the dashboard and receives one-way notification emails that link back to it.

**Current status:** a complete local application. One Node process serves the API, serves the dashboard, polls the support mailbox every two minutes, sends queued mail, assigns tickets, sends staff notifications and overdue reminders, closes resolved tickets, stores attachments on disk and takes a nightly backup of both the database and the attachment bytes. Staff sign in with real per-person credentials. CC'd colleagues join a ticket and are copied on replies, every change is audited, disabling an account revokes access and moves its work, and reply templates carry their own status mappings.

Where each PRD requirement actually stands — proved on this stack, asserted by the suite, or inherited from the Cloudflare deployment — is in **`docs/requirements-review.md`**. Running it, watching it and recovering it are in **`docs/operations.md`**.

It runs entirely on this machine. There is no cloud dependency of any kind.

## Architecture decision — 17 September 2026 (supersedes every earlier one)

The stack is **Node 24 + PostgreSQL 18 + the local filesystem**, in one process.

This replaced Cloudflare Workers + D1 + R2, which was chosen before anything was tested and cost this project most of its debugging time: cron triggers that never fire on that account, a PBKDF2 cap of 100,000 iterations, IMAP range fetches that stall, an absent `Buffer`, a frozen `Date.now()`, and a database that could not be tested against. Every one of those problems is gone rather than worked around.

**The Cloudflare resources are deleted** — the Worker, the D1 database and the `worker/` source tree, all on 17 September 2026 after local ingestion was proved against the same mailbox. There is no fallback to redeploy to. `worker/` is recoverable from git history if it is ever wanted.

The full reasoning, the ported-versus-rewritten decision and the measured evidence are in **`docs/superpowers/specs/2026-09-17-local-replatform-design.md`**. Read it before changing the stack.

**Production hosting is deliberately undecided.** A plain Node application deploys to an office server, a VM or a PaaS unchanged, so nothing is lost by deferring it. Do not add a hosting dependency without asking.

## Layout

- `server/` — the backend. Node, PostgreSQL, one process, its own gate.
- `prototype/` — React 19 + TypeScript + Vite dashboard with Fluent UI v9. Built output is served by `server/`.
- `prototype/src/domain/` — production domain rules, free of React, storage and transport. Business logic starts here, not in `main.tsx`. The server imports the business calendar from here on purpose: two implementations of the deadline rules would drift, and the UI would eventually show a different deadline from the one the system enforces.
- `scripts/check-mail-tls.mjs` — unauthenticated Zimbra TLS probe. Worth re-running: it failed from Cloudflare because that host dropped Workers traffic, and that constraint is gone. If Zimbra IMAP is reachable from this machine, the Gmail hop disappears and PRD open point 5 with it.
- `tools/mail-check/` — interactive IMAP/SMTP authentication check, run by hand, its own package.
- `.github/workflows/` — quality gates. Nothing deploys.

## Running it

Once, to set up:

```bash
brew install postgresql@18 && brew services start postgresql@18
createdb simpletickets && createdb simpletickets_test
```

Then:

```bash
cd server && npm ci && cp env.example .env
```

Put the Gmail App Password in `server/.env`. Without it the server still runs — the API and dashboard work against whatever is already in the database — but the mail loop does not start, and says so.

```bash
cd server && npm run db:migrate && npm run db:seed
npm run db:seed -- --password staff1    # prompts; never pass a password as an argument
cd ../prototype && npm ci && npm run build
cd ../server && npm run dev
```

The dashboard is then at `http://localhost:8787`, serving the built bundle from the same origin as the API.

For UI work, run `npm run dev` in `prototype/` as well and use `http://localhost:5173`. Vite proxies `/api` to 8787, so the session cookie behaves exactly as it does in production.

## Commands

**Server** (`server/`) — the gate is 258 unit tests and 176 against real PostgreSQL:

```bash
npm run dev           # watch mode
npm start             # plain
npm run verify        # the gate: typecheck + lint + format:check + unit + database tests
npm run test:unit     # vitest, pure logic only
npm run test:db       # vitest against simpletickets_test
npm run db:migrate    # apply pending migrations
npm run db:reset      # drop everything and re-migrate (refuses a non-local URL)
npm run db:seed       # staff1..staff5, staff1 as admin
npm run db:import     # one-time cutover from a D1 export
```

**Prototype** (`prototype/`) — 19 unit tests, a browser smoke run and a build:

```bash
npm run verify        # typecheck + lint + format + unit + browser smoke + build
npm run dev           # http://127.0.0.1:5173
npm test              # browser smoke test only
```

Both gates are the same standard: strict type-aware ESLint, zero warnings, no explicit `any`, no non-null assertions, Prettier-enforced. `npm run format` after editing — an unformatted file fails at `format:check`, before the tests run.

## The server

| Module | Responsibility | Pure? |
| --- | --- | --- |
| `domain.ts` | Sender authorisation, address extraction, HTML to text | Yes |
| `mime.ts` | RFC 5322 building, header-injection refusal, dot-stuffing, stored-row validation | Yes |
| `smtp.ts` | Reply parsing **and** the Gmail dialogue over `node:tls` | Partly |
| `acknowledgement.ts` | R02 acknowledgement composition | Yes |
| `reply.ts` | R13 public reply composition | Yes |
| `notification.ts` | R15/R18 one-way staff notifications | Yes |
| `outbox.ts` | Retry, backoff, permanence, abandonment, ambiguity | Yes |
| `threading.ts` | Reply → existing ticket, by Message-ID | Yes |
| `autoreply.ts` | RFC 3834 and legacy auto-reply detection | Yes |
| `bounce.ts` | Delivery-failure detection and id extraction | Yes |
| `transitions.ts` | Which status changes need an email first (R28) | Yes |
| `overdue.ts` | Response-deadline state (R03, R04) | Yes |
| `assignment.ts` | Fewest open tickets, round robin for ties (R07) | Yes |
| `domain.ts` | Also: CC eligibility and address-list splitting (R25) | Yes |
| `password.ts` | scrypt hashing, plus the legacy PBKDF2 verifier | Yes |
| `session.ts` | Cookie shape, token hashing, expiry, sign-in codes | Yes |
| `login-code.ts` | The email carrying a sign-in code (R06) | Yes |
| `auth.ts` | Admin token comparison, fails closed | Yes |
| `health.ts` | Whether the mail loop has stalled | Yes |
| `storage.ts` | Local files: raw messages, attachments, path safety | No — disk |
| `backup.ts` | `pg_dump` schedule, retention, restore | No — disk |
| `imap.ts` | Mailbox reading, body-part selection, attachments | No — network |
| `store.ts` | All database access | No — database |
| `ticker.ts` | The two-minute loop | No — timers |
| `pipeline.ts` | Ingest, reminders, auto-close, flush | No |
| `api.ts` | The dashboard API | No |
| `main.ts` | HTTP server, routes, static dashboard, wiring | No |

`smtp.ts` holds parsing and transport together deliberately. They were two files on Cloudflare only because `cloudflare:sockets` could not be imported under vitest, which made anything sharing a file with it permanently untestable. `node:tls` has no such problem, and the split bought nothing but distance between a function and its test.

## What the API exposes

Beyond the obvious ticket routes:

- `POST /api/tickets/:id/participants` — `{add: [...]}` or `{remove: "..."}` (R25)
- `POST /api/tickets/:id/priority` — audited, changes no deadline (R11, R22)
- `GET/POST /api/templates`, `POST|DELETE /api/templates/:id` — reading is open to all staff, writing is admin-only (R24)
- `POST /api/outbox/:id/resend` — requeues a bounced, failed or ambiguous message and clears its acceptance, which re-anchors auto-close (R28)
- `GET /api/audit` — the whole trail, newest first (R22)
- `POST /api/staff` with `{name, enabled}` — account access, distinct from `{name, available}` (R24)
- `POST /backup` — an off-schedule recovery point, behind the admin token

## Correctness properties worth not breaking

- **`ingest_log.uid` and `outbox.message_id` are both UNIQUE.** They are what stop one email opening two tickets, and one ticket sending two acknowledgements.
- **The acknowledgement is enqueued in the same transaction as the ingest log entry.** Queue it afterwards and a crash in between leaves a ticket nothing will ever acknowledge.
- **`claimNextIntent` uses `FOR UPDATE SKIP LOCKED`.** It replaced a compare-and-swap that was correct only because there was exactly one poller.
- **A send whose outcome is unknown becomes `ambiguous` and waits for a human.** Resending risks a duplicate to a real person; dropping it risks silence (PRD open point 4).
- **Bounces are classified before auto-replies.** A bounce has a null return path, so the auto-reply test matches it too, and misfiling one loses a delivery failure R15 needs.
- **`findTicketByMessageIds` refuses to thread on a notification's Message-ID.** IT staff are on the approved sender domain, so a staff member replying to a one-way notification produces a message indistinguishable from the employee's. Without this it would be appended to the ticket, restarting the response clock and reopening a resolved ticket — which R15 forbids.
- **`addNote` contains no outbox statement.** The constitution forbids an internal note reaching employee email, and the safest guarantee is that the sending machinery can never be handed one. `notification.ts` has the same shape: it cannot receive note text.
- **The `Ticker`'s `#running` flag is the mutual exclusion the Durable Object gave by being single-threaded.** Two concurrent polls can claim the same outbox row.
- **Notification Message-IDs carry a random component.** One reminder goes to the assignee and every admin in the same millisecond; a timestamp alone produced identical ids and the UNIQUE constraint silently dropped every recipient after the first.
- **"Answered" is per response episode, not per ticket (R16).** `first_response_at` is the earliest outbound message *after the most recent inbound one*. The obvious version — the earliest outbound message, full stop — read a ticket IT had ever replied to as answered forever, so an employee writing back a week later was owed nothing and appeared on no overdue list. `ticketsNeedingReminder` uses the same definition.
- **A follow-up while a response is already owed does not move the deadline (R16).** `appendReply` applies a new one only when an outbound message exists after the last inbound one — and runs that check BEFORE inserting, or the message being added becomes its own "most recent inbound".
- **Assignment runs under `withAssignmentLock`.** Two assignments deciding at once both read the same workloads and both pick the same least-loaded person. The outbox claim solves this with `FOR UPDATE SKIP LOCKED`; assignment needs an advisory lock, because what it protects is a decision made from several tables rather than any one row.
- **`author` comes from the session, never from the request body.** That is what makes the ticket history an audit trail rather than a record of what the client claimed. The same applies to every `actor` in `audit_events`.
- **`findTicketByMessageIds` matching is not enough on its own: `isTicketParticipant` decides who may write.** Everybody in the company is on the approved domain, so a same-domain sender who learned a Message-ID would otherwise join any conversation, and IT would read it as the employee's own reply.
- **`available` and `enabled` are ANDed in exactly one place, `assignable`.** A caller that forgot the second half would hand tickets to someone who no longer has an account, and nothing about the result would look wrong.
- **A backup is two files.** The `pg_dump` and a `tar` of `STORAGE_DIR`, taken together and pruned together. Restoring the database alone gives an `attachments` table whose every row points at a file that is not there.
- **Pruning never deletes the newest dump.** A machine switched off for two months would otherwise wake up, find everything past retention, and delete the only copy it has.
- **An oversized-attachment notice has no `messages` row.** `first_response_at` is the earliest outbound message, so recording it would have an automatic size notice satisfy a four-hour response deadline. The acknowledgement is queued the same way for the same reason.

## Things that cost real debugging time

- A **single-part** message has no part identifier. Address `"TEXT"`, or `download()` returns the entire raw message including headers.
- `bodyParts` returns raw transfer encoding; `download()` decodes.
- `References` is **not** in the IMAP envelope and must be requested, and it arrives folded across indented lines — dropping continuations loses half the thread.
- IMAP is opened **read-only** at every call site. Ingestion must not mark anything seen; the database is the record of what has been processed, not the mailbox's flags. This is also what lets a local instance poll the same mailbox as another running system without disturbing it.
- PostgreSQL folds unquoted identifiers to lower case, so `AS openTickets` arrives as `opentickets`. Every camelCase alias in `store.ts` is double-quoted.
- PostgreSQL types `count()` as bigint and `pg` returns bigint as a **string**. Every `COUNT` in `store.ts` is cast with `::int`.
- Id columns are `GENERATED ALWAYS AS IDENTITY`, which refuses an explicit id. That is wanted everywhere except `db:import`, which uses `OVERRIDING SYSTEM VALUE` and then resets the sequences.
- A **delivery report** quotes the original message in its `message/rfc822` part, which is not what `readBody` returns. `bouncedMessageIds` therefore takes the complete raw source, and skips the report's own header block — its Message-ID belongs to the report and can never be in the outbox.
- A **comma inside a quoted display name** is not an address separator. `"Rao, Ananya" <...>` split on every comma becomes two entries, neither of which parses, and the colleague silently stops being copied.
- **Routes that send need a message body; routes that do not, do not.** A shared guard once demanded one from the participants route, which answered 400 to every well-formed call.

## Mail

- Inbound: `support@allcheckservices.com` forwards to `simpleticketssupport@gmail.com` (a Zimbra user-level forward; no DNS change, no mail admin). SPF passes because the forwarder is the domain's MX and the record has `+mx`.
- Outbound: Gmail SMTP on port 465 with the same App Password.
- **`MAIL_SEND` is off unless it is exactly `on`.** Intents are still enqueued, claimed and rendered — everything except the wire. It is off by default because the usual reason to run this locally is to develop against the real mailbox, and a second acknowledgement for a ticket another system already answered lands in a real employee's inbox. **It was turned on deliberately on 17 September 2026**; check `/status` before assuming its current value, and check the outbox has nothing pending before changing it — what is already queued is the entire risk of flipping that switch.
- Replies still go out from the Gmail address. An employee who writes to the company address is answered by a `gmail.com` one. Needs Gmail "send as" or Workspace on the domain. PRD open point 5.

## Key constraints

- **Email domain:** only `@allcheckservices.com` senders to `support@allcheckservices.com`
- **Work calendar:** Mon–Sat, 09:00–18:00 Asia/Kolkata (UTC+5:30)
- **Response deadline:** 4 working hours; Sunday messages due Monday 12:00
- **Assignment:** fewest open tickets among available staff; round robin for ties
- **Statuses:** New, In Progress, Waiting for Employee, Resolved, Closed
- **Delivery-gated transitions (R28):** Waiting for Employee, Resolved and Closed take effect only when the mail server accepts the required message. The 72-hour auto-close clock starts at that acceptance, and a later bounce pauses it.
- **Attachments:** 5 MB total per email, on local disk under `STORAGE_DIR`
- **Backups:** `pg_dump` daily at 02:00 IST, 30-day retention, under `BACKUP_DIR`
- **Staff availability:** admin-only; unavailable staff have tickets redistributed and the new owners are notified

## Authentication

Staff sign in with a name and password (R06). Sessions are HttpOnly, Secure, SameSite=Strict cookies whose tokens are stored hashed. Passwords are scrypt (N=2¹⁶, r=8, p=2), and the stored format records its own parameters so the cost can be raised later without invalidating anyone's password. The Cloudflare-era chained-PBKDF2 verifier is retained so an older password still works.

**Sign-in codes (R06) are behind `LOGIN_CODES`, off by default.** With it on, a correct password grants no session — it emails a six-digit code, and `POST /api/login/verify` exchanges that for one. The code is hashed at rest, lasts ten minutes, dies after five guesses, is single use, and there is one outstanding per account. The server **refuses to start** with `LOGIN_CODES=on` and no way to send, because a code that cannot be delivered locks out every staff member and the system has no way to tell them why. The code email carries no link: a sign-in email with a clickable link is the shape of every credential phishing message, and training staff to click one is worse than typing six digits.

Unlike everything else outbound, the code is sent **inline rather than queued**. Somebody is waiting for it; a code that arrives on the next two-minute poll is a code nobody will use. A send failure answers 502 rather than being swallowed.

**Bootstrapping the first password is deliberately a command-line action.** Only an admin session may provision a password, and a fresh database has no account with one, so the API has no way to create the first — which is the safe direction. `npm run db:seed -- --password staff1` fills the gap from the machine, where whoever runs it already has the database.

The shared `ADMIN_TOKEN` guards the operational routes (`/status`, `/ticker`, `/poll`, `/flush`, `/peek`, `/diag`) and **carries no identity on purpose**: a token cannot author a message, because then anyone holding it could write history under any staff member's name.

## Connecting the dashboard

Nothing to configure. The server serves the built dashboard, so `/api` is same-origin, the session cookie works, and there is no CORS and no token in the browser bundle.

The dashboard still shows built-in **sample data** when no server answers — it asks `/api/me` and falls back if nothing sensible comes back. That fallback is load-bearing: the browser smoke test drives the UI by its labels and asserts exact row counts against the `seed` array, and a design review has to work without a backend. A configured API that *fails* shows an error and no tickets, never sample data: invented tickets displayed when the real ones could not be loaded would have IT working a queue that does not exist. The banner always states which mode is active.

## The smoke test

`prototype/checks/smoke.mjs` is a single linear Playwright script, not a test runner. It starts **its own Vite server** on a port chosen by engine — 5174/5175/5176 (`strictPort`) — so the three can run at once but two runs of the same engine collide.

`SMOKE_BROWSER` picks the engine: chromium (default, the main gate), firefox or webkit. `npm run test:browsers` runs the other two locally; CI runs them as their own matrix job. Screenshots are written only from chromium, since three engines overwriting them in turn would make the committed files depend on which job finished last.

**WebKit skips buttons and links in its tab order** unless the user turns on Safari's "Press Tab to highlight each item". That is a browser setting a page cannot opt into, so the smoke test's tab WALK runs on chromium and firefox; keyboard ACTIVATION — focus the row, press Enter — runs on all three, because that is the part the page owns.

- It asserts **exact row and item counts** against the `seed` and `initialTemplates` arrays in `main.tsx`. Changing that sample data breaks the test — update both together.
- It sets `VITE_PROXY_TARGET` to a dead port so the dashboard cannot find a backend and stays on sample data. Without that the test would pass or fail depending on whether a real server happened to be running on 8787.
- It **overwrites** `dashboard-preview.png`, `ticket-preview.png` and `mobile-preview.png`. Those are outputs of a smoke run, not hand-made assets.
- Locally it launches `channel:"chrome"`; under `CI=true` it uses Playwright's bundled Chromium.

## Prototype conventions

`src/main.tsx` is one Prettier-formatted file. It was originally written in a minified single-line style; that is gone. **Do not re-minify it.**

- No router. Navigation is a `page` string in `useState`; all views are conditional expressions in one `App` return.
- All state is a `useState` cluster at the top of `App`. Sample data (`seed`, `initialTemplates`, `statuses`, `staff`) sits above it as module constants.
- The composer keeps `replyDraft` and `noteDraft` separate, with `draft`/`setDraft` selected by the `note` flag. Keep them separate: a shared draft lets an internal note land in the public reply box, which R13 and Constitution III forbid.
- Fluent brand tokens are overridden inline in the `FluentProvider` theme object (burnt orange `#B54720`), separately from the CSS files.
- CSS is **append-only override layers**: `style.css` holds successive design iterations and `brand.css` is imported after it so its tokens win. To change the palette, edit `brand.css` and the `FluentProvider` theme — not the older blocks in `style.css`.
- The prototype CSS is still desktop-first. New work is mobile-first from 360 px per `docs/engineering-standards.md`; migrating the existing sheets is T028, not a side effect of an unrelated change.

## Dependencies

Everything is at its latest version with **one deliberate exception**: TypeScript is pinned to 6.0.3 rather than 7.0.2, because `typescript-eslint` declares `typescript <6.1.0`. Taking 7 would silently disable the type-aware lint rules that are the gate. Revisit when typescript-eslint supports 7.

The server needs no bundler and no `tsx`: Node 24 runs TypeScript directly by stripping types, which is why `tsconfig.json` sets `erasableSyntaxOnly` and every relative import carries an explicit `.ts` extension. `node --env-file-if-exists=.env` reads the environment file natively, so there is no `dotenv` dependency and no import-order trap.

## Git

`docs/git-workflow.md` is binding. The two rules that override Claude Code defaults:

- **Never add AI attribution to a commit message.** No `Co-Authored-By:` naming a model or assistant, no "Generated with", no tool name, no robot emoji. The author is `mayur2605` and nothing else. This applies to pull request descriptions too.
- **`npm run verify` must exit 0 before you commit** — in both packages. Never reach green by weakening a rule.

Also: check `.gitignore` and `git status --short` before staging, never commit a credential, and push only when asked. `server/var/` holds real employee mail and attachments and is git-ignored.

Hooks in `.githooks/` enforce part of this — enable them once per clone with `git config core.hooksPath .githooks`. They are a safety net, not the gate. Never use `--no-verify`.

## Working practices

**Documentation first:** record user decisions in PRD and specs. Label proposed defaults clearly; distinguish user approval from draft technical choices.

**One question at a time:** continue discussions incrementally rather than batching open questions.

**No credentials in documents:** never add real passwords, tokens or secrets to markdown, source, logs or command arguments. `npm run db:seed -- --password` and `tools/mail-check/check.mjs` both prompt interactively for exactly this reason.

**Claimed status is not evidence.** Distinguish proposed, implemented, locally verified and deployed. Re-run the gate rather than trusting a document that says it passed.

**Document age matters.** `docs/brand.md` supersedes the navy/blue description in the first half of `docs/ui-direction.md`. `docs/superpowers/specs/2026-09-17-local-replatform-design.md` supersedes every earlier stack decision. When documents disagree, the later evidence document wins — and fix the stale one.

**Traceability:** PRD `R01`–`R28` are the canonical IDs. Spec acceptance scenarios cite them; tasks `T001`–`T028` implement them. A requirement change touches all four documents plus `docs/foundation.md` if a boundary moves.

## Essential documents (read in order)

1. `AGENTS.md` — required engineering workflow and boundaries
2. `docs/engineering-standards.md` — mobile-first, test-first, type/lint policy, definition of done
3. `docs/git-workflow.md` — commit/push rules, binding on every agent
4. `docs/foundation.md` — core purpose, people, scale, boundaries
5. `docs/PRD.md` — product requirements with canonical requirement IDs
6. `.specify/memory/constitution.md` — architectural principles and governance
7. `specs/001-email-ticketing/spec.md` — feature specification with acceptance scenarios
8. `specs/001-email-ticketing/plan.md` — technical plan
9. `specs/001-email-ticketing/tasks.md` — implementation tasks
10. `docs/superpowers/specs/2026-09-17-local-replatform-design.md` — the current stack and why
11. `docs/stack-validation.md` — what has actually been tested, including everything Cloudflare cost
12. `docs/requirements-review.md` — every requirement against its evidence, and what is not met
13. `docs/operations.md` — running it, watching it, recovering it, deploying and rolling back
14. `docs/brand.md` — palette, typography, contrast measurements
15. `docs/ui-direction.md` — UI decisions and prototype instructions

## Unresolved

- **Sending is proved, with one honest limit.** On 17 September 2026 at 20:07 IST, with the user's explicit authorisation, `MAIL_SEND` was turned on and two messages composed by this server were accepted by Gmail with queue ids; R28 held against a real mail server. What a `250` does not prove is delivery downstream of Gmail — no bounce arrived, which is how a refusal appears, but inbox confirmation is the recipient's to give. Staff notifications and an inbound reply after an outbound message are still unexercised. See `docs/stack-validation.md`.
- **Production hosting is undecided**, by choice.
- **Replies go out from the Gmail address**, not the company one. PRD open point 5.
- **DMARC policy is undecided**, and what the domain publishes today is not recorded in this repository, which is public. PRD open point 7.
- **Login leaks account existence by timing**, accepted and recorded — see `docs/stack-validation.md`.
- What an employee reply should do to a transition whose required email is not yet accepted (PRD open point 3); SMTP acceptance-ambiguity *detection* (open point 4 — the `ambiguous` state and the resend path exist; the detection rule does not).
- **Backups sit on the same disk as the database.** That is not a backup against losing the disk. An off-machine copy waits on the hosting decision (PRD open point 9).
- **Account recovery is not built** (R06). Emailed sign-in codes now are, behind `LOGIN_CODES`.
- **The inherited stylesheets are desktop-first.** New CSS is mobile-first; `style.css` and `brand.css` are not, and inverting 1651 lines of append-only design iterations is a rewrite with regression risk and no behavioural gain. A pass with an actual screen reader is also still open — no automated check substitutes for it (T028).
