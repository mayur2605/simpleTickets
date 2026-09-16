# Stack validation

Checked 16 September 2026. Status: partial validation; production architecture not yet finalized.

## Frontend decision

Keep React, TypeScript, Vite and Fluent UI from the working prototype. Preserve the approved independent SimpleTickets identity: burnt orange, pearl, graphite and silver. Production extraction should retain current interaction checks while adding real authentication and data.

## Zimbra checks actually performed

From the local development machine, without credentials:

| Endpoint | Result |
| --- | --- |
| mail.allcheckservices.com:993 | Verified TLS 1.2 handshake; IMAP authentication not tested |
| mail.allcheckservices.com:465 | Verified TLS 1.3 handshake; SMTP authentication/delivery not tested |
| mail.allcheckservices.com:587 | TCP connection and Postfix greeting; STARTTLS not tested |
| HTTPS webmail | HTTP 200 with curl's normal certificate verification |

Certificate issuer reported by Node: Let's Encrypt YR1. Certificate expiry reported: 8 October 2026. An initial Python SSL probe failed certificate-chain verification; Node's verified TLS and curl HTTPS checks passed. The Python failure alone is not evidence of a server certificate defect. TLS verification was not disabled.

Repeat the non-authenticated checks with `node scripts/check-mail-tls.mjs`.

These results do not prove Cloudflare-origin connectivity, IMAP client compatibility, mailbox permissions, SMTP sender authorization, reply routing or delivery. No mailbox contents were accessed and no email was sent.

## Cloudflare candidate and constraints

Keep Workers + D1 + private R2 as the free-first candidate pending a deployed feasibility test. Do not purchase a plan or provision resources as part of this local check.

- Workers Free: 10 ms CPU per HTTP request and per cron run, 128 MB memory, 100,000 requests/day, five cron triggers/account. Network wait time is excluded from CPU accounting. Password verification and MIME parsing still require measurement.
- D1 Free: 500 MB per database; 5 GB is aggregate account storage, not the size of one database. Maximum row size 2 MB. Bound email body size or store large source content outside database rows.
- D1 Free native Time Travel: seven days. It does not satisfy the agreed 30-day recovery window by itself; independent daily exports and attachment backups remain necessary.
- Workers outbound TCP port 25 is blocked. The locally reachable 465 endpoint is a candidate for TLS SMTP; deployed connectivity must be proved. Workers also block outbound TCP to Cloudflare IP ranges.
- R2 free storage is finite; indefinite retention and separate backups need capacity tracking and an overage plan.

## Workers feasibility — deployed measurement, 16 September 2026

Measured from a Worker deployed to the `allcheckservices@gmail.com` account
(`0b5b753cc6ed1dfbbe3a597a0ff4fb3b`) and deleted immediately afterwards. The probe
source is `tools/runtime-check/`; redeploy it with `npx wrangler deploy`.

### Blocker: the Zimbra host is unreachable from Cloudflare

| From | Target | Result |
| --- | --- | --- |
| Worker | imap.gmail.com:993 | Connected, IMAP greeting read, 68 ms |
| Worker | smtp.gmail.com:465 | Connected, SMTP greeting read, 183 ms |
| Worker | mail.allcheckservices.com:993 | Connect timeout at 8 s |
| Worker | mail.allcheckservices.com:465 | Connect timeout at 8 s |
| Worker | mail.allcheckservices.com:587 | Connect timeout at 8 s |
| Worker | 49.50.108.191:993 (the A record, by IP) | Connect timeout at 8 s |
| Development Mac, same minute | mail.allcheckservices.com:993 and :465 | Verified TLS, as before |

The controls prove the runtime, the `cloudflare:sockets` API and the probe itself all
work, and that Cloudflare does not block outbound 993 or 465. The host fails by IP as
well as by name, so name resolution is not involved. The local machine reached the same
address and ports in the same minute, so the server was up.

The failure mode is a timeout rather than a refusal, which means packets are dropped
rather than rejected — the signature of a firewall DROP rule. The most likely cause is
that the mail host blocks datacenter or cloud IP ranges, or allows only known office
addresses. **Direct IMAP/SMTP from Cloudflare Workers to this mailbox is therefore not
possible today, on any Workers plan.** This is a network-reachability problem, not a
CPU, feature or pricing problem, so paying for a higher tier does not address it.

A DNS detail worth recording so it is not rediscovered as a false lead: a local
resolver on the development network synthesises a NAT64 AAAA record
(`64:ff9b::3132:6cbf`, which decodes to the same IPv4 address). The authoritative
nameservers publish only an A record, and public resolvers return no AAAA, so this is
local DNS64 behaviour and not something Cloudflare sees.

### Password hashing: capped by the API, not by CPU

An earlier entry in this document framed hashing as a CPU-budget problem based on a
local Node benchmark. The deployed measurement corrects that:

| Iterations | Result on Workers |
| --- | --- |
| 10,000 | ok |
| 50,000 | ok |
| 100,000 | ok, `cpuTime` 25 ms, `wallTime` 26 ms |
| 210,000 | exception: `Pbkdf2 failed: iteration counts above 100000 are not supported` |
| 600,000 | same exception |

Two corrections follow. First, the binding constraint is a **hard cap of 100,000
PBKDF2 iterations in the Workers WebCrypto implementation**, not elapsed CPU. Second,
100,000 iterations consumed 25 ms of CPU and still completed, so the 10 ms per-invocation
figure recorded above was not what this account enforced; the real allowance needs
confirming against current Cloudflare documentation and the account's plan before it is
relied on.

Current OWASP guidance for PBKDF2-HMAC-SHA256 is 600,000 iterations, which the Workers
cap makes unreachable. Meeting R06 on Workers therefore means either a WebAssembly
Argon2id or bcrypt implementation rather than native WebCrypto PBKDF2, or an explicit,
recorded decision to accept 100,000 PBKDF2 iterations. Neither has been chosen, and
specs/001-email-ticketing/plan.md forbids quietly weakening hashing.

### What this leaves open

The mail-reachability blocker outranks the hashing question: if the runtime cannot reach
the mailbox, hashing parameters do not matter yet. Options, none chosen and nothing
purchased:

1. Establish whether the block is deliberate by asking whoever administers the mail
   host. If it is an allowlist, Cloudflare Workers cannot be added to it usefully,
   because Workers egress addresses are broad and not stable.
2. Run only the mail-polling component on a host with a stable outbound address that the
   Zimbra firewall can allow, and keep the rest of the system wherever it fits best.
3. Move the whole backend to a host with stable egress.

D1, R2, cron scheduling and MIME parsing remain unmeasured; they are not worth measuring
until the transport question is settled.

## Next validation gate

1. Use a temporary Zimbra test mailbox with secure local secret entry; do not paste passwords in conversation or commit them.
2. Confirm IMAP authentication and restricted read operations, then test SMTP delivery only after explicit authorization of test sender and recipient.
3. Run the same integration from Cloudflare and measure CPU/memory using representative 5 MB attachments and secure password hashing.
4. Measure cron, database and backup behavior, then finalize hosting. If free Workers cannot safely meet the requirements, present a measured paid or alternate-host proposal rather than weakening security or silently adding a mail bridge.

## Primary sources

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)

## User-reported authentication result

The user reported PASS after running `tools/mail-check/check.mjs` with the normal password for support@allcheckservices.com. Record this as a user-reported successful local IMAP/SMTP authentication check; raw per-protocol output was not supplied. The checker opens no mailbox, fetches no messages and sends no email. Credentials were not supplied in conversation.

Still pending: explicitly authorized sender/recipient delivery round trip, mailbox polling, and Cloudflare-origin authentication/runtime measurements.
