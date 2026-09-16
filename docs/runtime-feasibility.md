# Runtime feasibility acceptance plan

Prepared locally 16 September 2026. Status: test design only; no Worker harness, login or deployment yet. This does not complete T003/T004.

## Local preparation

Create an isolated tools/runtime-check TypeScript package with its own lockfile, strict compiler/lint/format gates and tests. It must not import the prototype or real mailbox settings by default. Pin Wrangler locally, record its version and compatibility date, and dry-run the bundle before any deployment. Test adapters against a synthetic IMAP/SMTP server; real credentials enter only deployment secrets or a hidden local prompt.

Fixtures: plain text; HTML with tracking content; multipart with inline file; 4,999,999/5,000,000/5,000,001 decoded attachment bytes; multiple attachments crossing the aggregate limit; malformed MIME; duplicate Message-ID; conflicting thread references; timeout/disconnect before and after SMTP acceptance. Preserve text on oversized attachments. Generate fixtures deterministically without real employee data.

Implement narrowly scoped probe functions, not an open arbitrary-host proxy. Network targets are allowlisted configuration. Probe endpoints require authorization, have timeouts and bounded input/output, redact raw protocol errors, and default to no authentication/mailbox access/send. Disable all probe routes after the experiment. Test these protections first.

## Sequential acceptance gates

1. **Local bundle and adapter tests:** typecheck/lint/format/tests pass; Worker bundle resolves its APIs without assuming Node compatibility. Demonstrate timeout cleanup and sanitized errors. Synthetic fixtures prove byte accounting and body preservation.
2. **Deployed TLS probe:** after explicit test deployment authorization, validate certificate-checked 993/465 connectivity from Workers. Port 587 requires explicit STARTTLS validation; a greeting is insufficient. Record endpoint, runtime version, elapsed time, success/failure and sanitized error category only.
3. **Authenticated read-only probe:** use an approved temporary mailbox; prove authentication and bounded read-only operations. Do not touch pre-launch support messages. Record checkpoints and verify no Seen/deletion mutation. Secure secret provisioning is separate from login.
4. **CPU/memory benchmark:** repeated representative MIME cases and a security-reviewed password-hash configuration, including failed password verification. Capture platform CPU metrics, cold/warm results, memory evidence available from the runtime, failures and sample counts. Local wall-clock duration is not deployed CPU evidence. Missing memory evidence stays explicitly unverified. Reject a free-tier design that requires weaker hashing or skips attachment validation.
5. **Authorized delivery round trip:** only after the user names sender and recipient, send a uniquely identified synthetic message and verify actual receipt/threading. Test ambiguous delivery with the fake adapter, never by repeatedly emailing employees. No exactly-once SMTP claim.
6. **Storage/scheduler/recovery:** prove two-minute scheduling, overlapping-run exclusion, durable dedup/outbox constraints and retry behavior. Restore a small database plus attachment fixture from an independent recovery point and record hash consistency and elapsed restore time. A seven-day native history is insufficient for thirty-day recovery.

Pass only with recorded deployed evidence and no relaxed security requirement. If limits fail, document measurements and compare alternatives before selecting or purchasing hosting. Costs, R2 activation and backup protection remain open. Do not describe this plan or local Node checks as Workers success.

## Official limits rechecked

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/): Free has 10 ms CPU for HTTP and cron, 128 MB memory; network waiting is excluded from CPU.
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/): Free 500 MB per database, 5 GB per account, seven-day Time Travel; rows limited to 2,000,000 bytes.
- [TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/): outbound port 25 blocked; destination restrictions include Cloudflare/private IPs.
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/): Standard allowance is 10 GB-month, not unlimited retention or backups.

These are provider constraints, not measured SimpleTickets feasibility.
