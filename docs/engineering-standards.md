# Engineering standards

Locked direction: mobile-first, test-first, strict TypeScript and automated quality gates. These standards apply to new production work; they do not retroactively make the prototype production-ready.

## 1. Mobile-first and accessibility

Start new styles at 360 px; progressively enhance through tablet and desktop breakpoints. No document-level horizontal overflow; wide data tables may scroll in a labeled region. Keep key actions usable at 360, 390, 768 and 1440 px, including touch, keyboard and 200% browser zoom. Target WCAG 2.2 AA: readable contrast, associated field labels, visible focus, semantic controls, reduced motion, and understandable empty/error/loading states. Avoid hover-only functionality. Test Chromium, Firefox and WebKit before release; current smoke tests cover Chromium only. Mobile layout checks do not equal a completed accessibility audit.

## 2. Test-first behavior

For new business behavior and bug fixes, write a test that fails for the intended reason, implement minimally, then refactor. Use Vitest for isolated domain rules and Playwright for user journeys; add integration tests for persistence and transport boundaries. Visual-only adjustments need targeted visual checks, not superficial unit tests. Do not inflate test counts or enforce arbitrary coverage percentages instead of acceptance coverage.

Critical scenarios: sender/participant authorization, duplicate ingestion, outbox ambiguity, assignment ties and concurrency, unavailable staff, Sunday/working-hour boundaries, internal-note privacy, OTP expiry/reuse/rate limits, attachments, backup restoration and closure/reply races. Use fake clocks, synthetic mail fixtures and fake delivery adapters. No production mailbox access in automated tests.

## 3. Type and lint policy

TypeScript strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, noImplicitReturns, noFallthroughCasesInSwitch, noUnusedLocals, noUnusedParameters and consistent filename casing are enabled for the prototype. ESLint uses strict type-aware rules, React Hooks and JSX accessibility rules with zero warnings. Ban explicit any and non-null assertions. Prefer unknown plus validation over casts. Document genuinely necessary exceptions narrowly rather than weakening the global rules.

Documented exception: `jsx-a11y/no-noninteractive-tabindex` allows a tab stop on `role="region"` in addition to its default `tabpanel`. A horizontally scrolling container must be focusable or keyboard-only users cannot scroll it (WCAG 2.1.1); the rule stays an error everywhere else and no disable comment is used.

Third-party declaration checking currently uses skipLibCheck for dependency compatibility; application code is still strictly checked. New external boundaries (API input, environment, database projections, parsed mail) require runtime schemas. Select the validation library when the backend is selected.

## 4. Architecture and data

Separate domain logic from UI, transport and storage. Split the current large prototype component into focused modules as production features are added. Use typed contracts and explicit status transitions. Store timestamps in UTC; use one business-calendar service. Define mailbox checkpoint, outbox, retry and idempotency semantics before transport implementation. Apply database uniqueness and transactional protections, not just UI checks. Create versioned migrations with tested upgrade and recovery steps.

## 5. Security and operations

Server authorization for every sensitive action and attachment. Password hashing, OTP limits, session expiry, secure cookies, CSRF defenses, sender validation, safe email rendering and private backups are launch requirements. Never weaken them to fit a free hosting plan. Redact secrets and sensitive mail content from logs. Separate test and production configuration. Keep evidence for backup restoration, migration verification, mail-health checks and deployment rollback.

## 6. Reproducible quality gate

Use npm and committed package-lock files. Use npm ci in CI. Do not bypass peer-dependency checks. Prototype commands: typecheck, lint, format:check, test:unit, test and build, combined as npm run verify. The domain unit suite joined that gate with the first domain module (business calendar). Add integration checks as persistence and transport modules appear. Keep tests deterministic and isolated from the running user preview.

A CI workflow is provided for the prototype. It first ran remotely on 16 September 2026 and passed every step, including npm ci, Playwright Chromium install and npm run verify. Tooling has a compatibility constraint: current JSX accessibility plugin supports ESLint through v9, while npm marks v9 out of support. Track upgrade/replacement before production rather than forcing unsupported peer versions. TypeScript was pinned to 6.0.2 because the installed typed ESLint supports versions below 6.1; the original TypeScript 7 dependency was incompatible.

## 7. Definition of done

Accepted behavior documented; appropriate regression tests pass; strict type/lint/format/build pass; relevant phone/desktop and accessibility checks pass; errors and empty states handled; no secrets or unintended external actions; migration/operations implications documented. No skipped failing tests to obtain a green result. Keep a distinction between proposed, implemented, locally verified and deployed.

## Remaining prerequisites

Cloudflare-origin Zimbra validation, hosting choice, Spec Kit CLI initialization, backend schema and contract design, unit/integration suites, full accessibility and cross-browser checks, and production release validation remain open. Existing prototype CSS is largely desktop-first; converting it is a staged production task, not completed by this standards document.
