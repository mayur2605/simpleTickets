# SimpleTickets Constitution

Version 1.1.0 · Adopted 16 September 2026

## I. Employee simplicity

Email is the employee interface. No employee account or portal is required. Keep IT flows understandable for a five-person team.

## II. Reliable email handling

Mail ingestion is retryable and deduplicated. Persist ticket changes and intended outgoing messages before advancing ingestion checkpoints. Display failed deliveries and ingestion health. Do not promise exactly-once external SMTP delivery.

## III. Privacy and access

Enforce staff access on the server for tickets and attachments. Internal notes never enter employee email. Domain matching alone is not proof of sender identity. Protect credentials, login codes and session tokens; keep secrets out of source, documents and logs.

## IV. Explicit time and ownership

Persist timestamps in UTC and evaluate business time in Asia/Kolkata. Use one shared calendar implementation. Assignment and ownership history must remain correct under concurrent ingestion and staff actions.

## V. Small and maintainable

Prefer one coherent application with a small dependency set. Favor free hosting where it meets real requirements. Test constraints before choosing infrastructure; do not weaken authentication or lose mail to fit a free tier.

## VI. Evidence before release

Test threading, duplicates, assignment ties, unavailable staff, reminder boundaries, reopening, OTP failures, note privacy and attachment access. Prove a backup restore and a test-mailbox round trip. Keep proposed choices separate from verified behavior.

## VII. Engineering quality

Follow docs/engineering-standards.md: mobile-first production development, test-first behavior changes, strict TypeScript, typed linting, reproducible dependencies and automated quality gates. Passing prototype tests does not establish backend or production readiness.

## Governance

The user requirements in docs/PRD.md guide product scope. Update specifications and tasks when decisions change. These principles do not authorize external communication or production deployment. Ask remaining product questions one at a time.
