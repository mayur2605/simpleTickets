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
