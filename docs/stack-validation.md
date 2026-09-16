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

## IMAP works on Workers, 17 September 2026

A Worker held a real IMAP dialogue with `imap.gmail.com:993`: read the greeting, wrote
`a1 CAPABILITY`, parsed the tagged `a1 OK` reply, then logged out. 929 ms end to end.
This is stronger than the earlier reachability probe, which only read a banner — it
proves the runtime can **write** to a socket and follow a stateful line protocol, which
is what a poller needs.

Gmail advertises `AUTH=PLAIN` with no `LOGINDISABLED`, so a Google App Password will
authenticate. No OAuth is required.

Why this matters: the Gmail **API** path is closed on a free Gmail account.
`gmail.readonly` is a restricted scope, and publishing an app that uses one requires a
privacy policy, terms of service, an authorised domain and a security assessment. The
consent screen's Publish button stays disabled until then, and an unpublished app
expires refresh tokens after seven days — which would silently stop ingestion every week.

So the workable path is App Password plus IMAP, on Workers, with no VPS and no Workspace
seat. Cost: nothing.

### imapflow runs on Workers under nodejs_compat

Answered, and favourably. A Worker built with `compatibility_flags = ["nodejs_compat"]`
loaded `imapflow`, opened TLS to Gmail and completed a LOGIN exchange with deliberately
invalid credentials. The server's own rejection came back intact:

```
authenticationFailed: true
serverResponseCode:   AUTHENTICATIONFAILED
response:             3 NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)
```

Reaching that response requires the module to load, the socket shims to work, the
greeting to be read, CAPABILITY and LOGIN to be written, and the tagged reply to be
parsed. With a real App Password it authenticates.

- Bundle: 1679 KiB raw, 437 KiB gzipped — within limits.
- Cost: **8 ms CPU**, 1541 ms wall. Network wait is excluded from Workers CPU
  accounting, so an IMAP session is nearly free in CPU terms and fits even a strict
  10 ms budget. Polling is I/O-bound, not CPU-bound.

No hand-written IMAP client is needed. `imapflow` and `nodemailer` are the same
libraries already proven against a live server by `tools/mail-check/check.mjs`.

Not yet proven: long-lived connections and IDLE under the shims. Short poll-and-close
cycles are what R02 needs, and that is what was tested.

## Gmail App Password authenticates from a Worker, 17 September 2026

A Worker authenticated to `imap.gmail.com:993` with a Google App Password and opened
INBOX read-only:

```
authenticated: true   mailbox: INBOX   uidNext: 618314   uidValidity: 660171327
```

Every link is now proved: Workers reach Gmail, `imapflow` runs under `nodejs_compat`,
an App Password authenticates without OAuth, and a mailbox can be opened and inspected.
No VPS, no Workspace seat, no OAuth verification, nothing to pay.

Google displays app passwords in groups of four. The spaces are presentation only and
must be stripped before use, or authentication fails confusingly.

### Use a dedicated mailbox, not this one

The account used for the proof holds **517,547 messages**. It is a real working inbox,
which makes it unsuitable as the support mailbox:

- Every newsletter, receipt and notification arriving there would become a ticket.
- R27 limits ticket creation to post-launch mail. Against half a million existing
  messages the launch cutoff becomes delicate; against an empty mailbox it is trivial.
- Personal correspondence would become readable by all five IT staff, which the privacy
  principle in the constitution does not permit.

Done: the support mailbox is **simpleticketssupport@gmail.com**, a fresh account. A
Worker authenticated to it and opened INBOX read-only:

```
authenticated: true   messages: 3   uidNext: 4   uidValidity: 1
```

The three messages are Google's welcome mail. `uidValidity: 1` means the mailbox has
never been recreated.

### R27's launch cutoff becomes one integer

The plan devotes considerable design to UIDVALIDITY reconciliation, a durable launch
boundary and not importing pre-launch mail, because it assumed an existing mailbox with
history. Against a fresh mailbox that reduces to: record `uidNext` at activation (4), and
create tickets only for UIDs at or above it. UIDVALIDITY still has to be stored and
compared, because Gmail can in principle renumber, but the reconciliation path is no
longer the delicate part of ingestion.

## First ticket created from a real email, 17 September 2026

A message from a company address became a ticket in D1: subject, requester, status and
Message-ID stored, the UID recorded in `ingest_log`. Three further polls created nothing,
so idempotency holds. The launch cutoff behaved: five pre-existing messages were never
imported.

### One thing does not work yet

**Message bodies: fixed.** The diagnosis in the first paragraph below was wrong in an
instructive way, so both are kept.

The stall is not about IMAP literals. Fetching bodies across a UID **range** times out
under `nodejs_compat`; the identical request for a **single UID** succeeds. Four
strategies were tried against one known message and all four worked one-at-a-time:
`fetchOne` with `bodyParts`, `fetchOne` with `source`, and `download` of part `TEXT` or
`1`. So ingestion now reads envelopes in one ranged call and each body individually.

Three further corrections came out of actually looking at the stored rows rather than
trusting a byte count:

- `bodyParts` returns content still in its transfer encoding — the first "successful"
  body was base64. `download()` decodes, so it is used instead.
- A single-part message has no part identifier, so the structure search returned null and
  `download` fetched the entire raw message, headers and all. Single-part messages now
  address their body as `TEXT`.
- The test message was HTML-only, which is common. Bodies are converted to text, with
  tags stripped and entities decoded, so a ticket shows the message rather than markup.

A ticket now stores `"TEST MAIL TO CREATE TICKET\n\nGet Outlook for Mac"` — the actual
content. `htmlToText` lives in `domain.ts` with the other pure rules and has six tests.

The earlier probe proved connect and `mailboxOpen`, and was taken as proving IMAP works.
It did not prove fetching, and fetching is where it broke. Worth remembering when the
next component is declared proven.

**Cron does not fire.** The trigger is registered (`*/2 * * * *`, visible in the deploy
output and the dashboard) but there have been zero scheduled invocations. Every run so
far has been a manual POST to `/poll`. Unexplained.

### Gmail files company mail as spam, because SPF is broken

The first test email landed in `[Gmail]/Spam`, not INBOX, and was only ingested after
being marked not-spam by hand.

`allcheckservices.com` publishes **two** SPF records, which RFC 7208 makes a permanent
error: receivers treat the domain as having no valid SPF. Gmail sees a failed check and
files the mail as spam. This affects all company mail, not just this system.

The fix is to delete both TXT records and publish one merged record:

```
v=spf1 +a +mx ip4:49.50.108.191 ip4:49.50.108.192 ip4:103.10.190.17 ip4:103.10.190.18
  ip4:103.10.190.19 ip4:103.10.190.12 ip4:103.10.190.13 include:_spf.mail.hostinger.com ~all
```

Polling the Spam folder was rejected as a workaround: it would ingest real spam as
tickets and hide a genuine problem with the mail domain. But it does raise a design
requirement — mail that silently never becomes a ticket is worse than a visible failure,
so ingestion needs to surface gaps rather than sit quietly.

## Accepted architecture, 17 September 2026

The user chose **Cloudflare Workers for the application and Resend for mail transport**,
on the evidence below. This supersedes the IMAP-polling transport in
`specs/001-email-ticketing/plan.md`. It was chosen because it is the only combination
proved to work end to end: Workers cannot reach the Zimbra host at all, and no code
change alters that.

| Concern | Decision | Proved? |
| --- | --- | --- |
| Application hosting | Cloudflare Workers | Deploys and serves; CPU measured |
| Receiving mail | Resend inbound webhook, signature verified | Yes, end to end, first attempt |
| Message body and headers | Second call to `/emails/receiving/{email_id}` | Endpoint documented, not yet exercised |
| Sending mail | Resend API | **Not yet proved** |
| Staff password hashing | Undecided | Blocked: see below |

### Consequences for the specification

These follow from the decision and need applying to the PRD, spec and tasks. They are
listed rather than applied, because requirement documents are being maintained
separately.

1. **R01 — the support address changes.** Mail now arrives at
   `support@tickets.allcheckservices.com`. Either employees use the new address, or the
   Zimbra administrator forwards `support@allcheckservices.com` to it. The second keeps
   the published address but reintroduces a dependency on the mail administrator. This is
   an open product decision.
2. **R02 — polling becomes delivery on arrival.** "Poll for new mail every two minutes"
   no longer describes the system. Mail is pushed within seconds of arrival.
3. **T010 largely dissolves.** Mailbox polling, IMAP leases, UIDVALIDITY reconciliation
   and the UID-based launch cutoff have no equivalent. They are replaced by: verify the
   Svix signature, deduplicate on `email_id`, and fetch the body in a second call.
   The launch-cutoff requirement in R27 becomes trivial, since the subdomain mailbox has
   no pre-launch history at all.
4. **Idempotency moves.** Svix retries a delivery until it gets a 2xx, so the same
   `email_id` can arrive more than once and must create one ticket.
5. **R12 attachments** arrive as download URLs. The 5 MB aggregate limit is enforced
   against bytes actually fetched, not a declared size.

### Still unresolved on this stack

- **R06 password hashing.** Workers WebCrypto refuses PBKDF2 above 100,000 iterations,
  below current guidance of 600,000. Meeting R06 needs WebAssembly Argon2id or bcrypt, or
  an explicit recorded decision to accept 100,000. Not urgent for mail ingestion, but it
  blocks the dashboard sign-in work.
- **Sending has never been tested.** Receiving working says nothing about whether replies
  leave, arrive, or thread correctly.
- **Delivery-failure visibility.** `email.bounced` and `email.failed` are not subscribed
  yet; R15 needs them.

## Inbound mail proved working over Resend, 17 September 2026

A real message from a company address reached the webhook receiver end to end on the
first attempt: Resend accepted it for `support@tickets.allcheckservices.com`, signed the
delivery, and our Worker verified the signature and returned `200` on attempt 1.

This routes around the Zimbra firewall block entirely. Nothing has to reach out to the
mail server any more, so the unreachability recorded above stops being a blocker for
receiving. It does not resolve sending, which still has to be proved.

### The webhook payload is metadata only

`email.received` delivers exactly these fields under `data`:

```
attachments, bcc, cc, created_at, email_id, from, message_id, received_for, subject, to
```

There is **no message body and there are no `In-Reply-To` or `References` headers**, which
the Resend feature page implies are included. Both matter: the body is the ticket
content, and the threading headers are what R03 and the plan's participant-authorised
threading depend on.

### Ingestion is therefore two steps, not one

1. `email.received` webhook — signed, fast, carries `email_id`. Verify the Svix signature
   before trusting anything in it.
2. `GET https://api.resend.com/emails/receiving/{email_id}` with an API key — returns
   `html`, `text`, a `headers` object, attachment metadata with download URLs, and a
   signed URL for the raw original message.

Consequences to design around, none of them resolved yet:

- A Resend API key becomes a stored secret, separate from the webhook signing secret.
- Step 2 is an outbound HTTPS call that can fail independently of step 1. The webhook
  must not be acknowledged in a way that loses the message if the fetch fails, and Svix
  retries mean step 1 can arrive more than once for one email. Deduplicate on `email_id`.
- Attachments arrive as URLs to fetch, so R12's 5 MB aggregate limit is enforced at fetch
  time against real bytes, not against a declared size.
- Threading data comes only from step 2, so a ticket cannot be threaded from the webhook
  alone.

### What this does to the existing plan

`specs/001-email-ticketing/plan.md` and T010 describe two-minute IMAP polling with a
UIDVALIDITY/UID checkpoint, a durable launch cutoff and UID-based deduplication. If
Resend inbound is accepted, most of that is replaced by signed push delivery plus
`email_id` deduplication, and R02's "poll every two minutes" becomes "delivered on
arrival". That is a product-visible change and has not been accepted yet, so the plan
and tasks are left as written pending the user's decision.

Still unproven: outbound sending as this domain, delivery-failure visibility
(`email.bounced` and `email.failed` are not yet subscribed), attachment fetching, and
anything about staff authentication.

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
