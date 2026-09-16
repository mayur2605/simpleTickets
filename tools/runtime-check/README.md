# Runtime feasibility probe

Temporary Cloudflare Workers probe answering gates 2 and 4 of
[../../docs/runtime-feasibility.md](../../docs/runtime-feasibility.md). **Delete this package once the
hosting decision is made.** It is not part of the product.

## What it does

| Route | Purpose |
| --- | --- |
| `GET /tls?port=993\|465\|587` | Opens a verified TLS socket to the Zimbra host, reads the public greeting banner, closes. Proves the runtime can reach the endpoint. |
| `GET /hash?iterations=N` | Derives one PBKDF2-HMAC-SHA256 hash with a synthetic password, to size password verification against the CPU allowance. |

## What it deliberately does not do

No mailbox is opened, no message is fetched or sent, and no mailbox credential is
accepted or stored. The host and ports are a fixed allowlist, so this is not an open
proxy. Every route requires the `x-probe-token` header; anything unauthorised gets a
404 and learns nothing. Protocol errors are reported as categories, never raw text.

## Running it

```sh
npm ci
npm run typecheck
npm run dry-run          # bundles locally, deploys nothing
```

Deployment needs a Cloudflare account and explicit authorisation:

```sh
npx wrangler login               # opens a browser for you to approve
npx wrangler secret put PROBE_TOKEN
npx wrangler deploy
npx wrangler tail --format pretty
```

## Reading the hash measurement

`wallMs` in the response is **not** the measurement. Workers freezes the clock
between I/O operations as a side-channel defence, so it reads 0. Take `cpuTime`
from `wrangler tail` instead.

## Scope note

This package has strict TypeScript and a typecheck script, but not the full
lint/format/test gate that `docs/engineering-standards.md` §6 requires of production
packages. It is a throwaway experiment with no product code, and it is deleted once
the gate is answered. If any of it graduates into the product, it gets the full gate
first.
