# SimpleTickets

Internal IT support through email, with a shared dashboard for five IT staff.

Status: requirements draft, 16 September 2026. An interactive frontend prototype is available; the production application and backend have not been implemented or deployed.

## Read in order

1. [Foundation](docs/foundation.md)
2. [Product requirements](docs/PRD.md)
3. [Project constitution](.specify/memory/constitution.md)
4. [Feature specification](specs/001-email-ticketing/spec.md)
5. [Provisional technical plan](specs/001-email-ticketing/plan.md)
6. [Implementation tasks](specs/001-email-ticketing/tasks.md)

## Spec Kit

These documents follow GitHub Spec Kit's constitution → specification → plan → tasks workflow. They are manually authored project artifacts; the Spec Kit CLI and agent commands are not installed yet. Neither `uv` nor `specify` was available on PATH during setup. Follow the official installation guide and verify the current supported agent integration before initializing into this existing folder. Preserve these authored documents when merging generated templates.

Sources: [GitHub Spec Kit](https://github.com/github/spec-kit), [installation](https://github.github.io/spec-kit/installation.html).

## Collaboration

Continue one question at a time. Record user decisions in the PRD and specification; clearly label proposed defaults and unresolved implementation details. Do not treat a draft technical choice as user approval. Never put credentials in these documents.

## UI preview

See [UI direction and prototype instructions](docs/ui-direction.md). Run `npm ci` and `npm run dev` in `prototype/` to explore the sample dashboard.

## Engineering standards

Read [engineering standards](docs/engineering-standards.md) and [agent instructions](AGENTS.md) before implementation. Prototype quality gate: `npm run verify` from `prototype/`.

## Takeover review

See [local review and verification](docs/takeover-review.md) and [runtime feasibility acceptance plan](docs/runtime-feasibility.md). The prototype now keeps public and internal-note drafts separate; production tasks remain open.
