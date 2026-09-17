# SimpleTickets

Internal IT support through email, with a shared dashboard for five IT staff.

Employees email `support@allcheckservices.com`. Each message opens or updates a ticket. IT
works in the dashboard and never by email; they receive one-way notifications that link
back to it.

**Status, 17 September 2026: a complete application that runs locally.** One Node process
serves the API, serves the dashboard, polls the support mailbox every two minutes, sends
queued mail, assigns tickets, notifies staff, reminds on overdue responses, closes resolved
tickets, stores attachments on disk, and backs up the database and the attachment bytes
nightly. Staff sign in with real per-person credentials. Colleagues CC'd on an employee's
email join the ticket and are copied on replies; every change is audited; disabling an
account revokes access and moves its work; reply templates carry their own status mappings.

It has no cloud dependency, and no longer has a cloud fallback: the earlier Cloudflare
Workers + D1 + R2 deployment was replaced and then deleted on the same day, once local
ingestion had been proved against the same mailbox. See
[the replatform design](docs/superpowers/specs/2026-09-17-local-replatform-design.md) for
why, and [validation evidence](docs/stack-validation.md) for the measurements.

Ingestion is proved: on 17 September 2026 an empty database pointed at the live mailbox
independently rebuilt the same tickets the previous deployment held, including the threaded
reply. **Sending is not** — `MAIL_SEND` has never been on here, so nothing this server
composes has reached a person yet.

Where every requirement actually stands is in
[the requirement review](docs/requirements-review.md), which separates what is proved on
this stack from what is only asserted by the test suite. Running it, watching it and
recovering it are in [operations](docs/operations.md).

## Running it

Once:

```bash
brew install postgresql@18 && brew services start postgresql@18
createdb simpletickets && createdb simpletickets_test
cd server && npm ci && cp env.example .env    # then add GMAIL_APP_PASSWORD
npm run db:migrate && npm run db:seed
npm run db:seed -- --password staff1           # prompts; never pass a password as an argument
cd ../prototype && npm ci && npm run build
```

Then:

```bash
cd server && npm run dev
```

The dashboard is at `http://localhost:8787`, served from the same origin as the API — so
the session cookie works with no CORS and the browser bundle carries no credential.

`MAIL_SEND` is off unless it is exactly `on`. Outgoing messages are composed and queued;
nothing reaches the wire. Leave it off while developing against the real mailbox, or a real
employee receives a duplicate.

For UI work, also run `npm run dev` in `prototype/` and use `http://localhost:5173`; Vite
proxies `/api` so the session behaves exactly as it does in production.

## Verifying

Two packages, two gates, both must pass before a commit:

```bash
cd server    && npm run verify   # typecheck, lint, format, 258 unit + 176 database tests
cd prototype && npm run verify   # typecheck, lint, format, unit, browser smoke, build
```

The database tests need PostgreSQL running and refuse any database whose name does not end
in `_test`, because they truncate.

## Read in order

1. [Foundation](docs/foundation.md) — purpose, people, scale, boundaries
2. [Product requirements](docs/PRD.md) — canonical requirement IDs R01–R28
3. [Project constitution](.specify/memory/constitution.md)
4. [Feature specification](specs/001-email-ticketing/spec.md)
5. [Technical plan](specs/001-email-ticketing/plan.md)
6. [Implementation tasks](specs/001-email-ticketing/tasks.md)
7. [Replatform design](docs/superpowers/specs/2026-09-17-local-replatform-design.md) — the current stack and why
8. [Validation evidence](docs/stack-validation.md) — what has actually been measured

For working on the code: [CLAUDE.md](CLAUDE.md) covers layout, commands and the couplings
worth knowing; [AGENTS.md](AGENTS.md) and
[engineering standards](docs/engineering-standards.md) are the binding workflow rules.

## Spec Kit

These documents follow GitHub Spec Kit's constitution → specification → plan → tasks
workflow. They are manually authored; the Spec Kit CLI is not installed (T002). Preserve
these authored documents when merging generated templates.

Sources: [GitHub Spec Kit](https://github.com/github/spec-kit),
[installation](https://github.github.io/spec-kit/installation.html).

## Collaboration

Continue one question at a time. Record user decisions in the PRD and specification;
clearly label proposed defaults and unresolved implementation details. Do not treat a draft
technical choice as user approval. Never put credentials in these documents.
