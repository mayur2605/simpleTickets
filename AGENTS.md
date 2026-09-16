# SimpleTickets agent instructions

Read docs/engineering-standards.md, docs/PRD.md, docs/brand.md and the feature specification before modifying application behavior. Keep the approved burnt-orange visual identity. Ask one question at a time when a product decision is required.

## Required engineering workflow

- New behavior and bug fixes are test-first: write a meaningful failing behavior/regression test, observe the intended failure, implement, then refactor with tests passing. Do not describe historical prototype tests as TDD. Pure visual changes use visual/accessibility checks rather than implementation-mirroring tests.
- New product code uses strict TypeScript. No explicit `any`, non-null assertions, unchecked casts, ts-ignore or blanket lint suppression to bypass failures. Validate external data at runtime; types are not validation.
- Build mobile-first from 360 px with progressive enhancement. Existing prototype desktop-first CSS is debt to migrate incrementally, not evidence this is already complete. Maintain usable keyboard controls and 200% zoom. Aim for WCAG 2.2 AA.
- Keep business rules separate from React, persistence and mail transport. Use a shared injected clock for deadline tests and UTC storage with Asia/Kolkata business-time calculations.
- Do not add useMemo/useCallback by default. Use React transitions/deferred values only when they solve measured interaction needs. No React Compiler is currently configured.
- Keep changes small and reviewable. Do not rewrite working interfaces just to satisfy a style preference. Update specifications and tests when accepted behavior changes.

## Required verification

From prototype/: `npm ci`, then `npm run verify`. Browser tests start their own Vite server on 5174; local Google Chrome is required. CI uses Playwright Chromium. Do not use real credentials or real email in tests.

Vitest is installed for future isolated domain tests (`npm run test:unit`), but no domain tests exist yet. Add this command to the mandatory verify/CI chain as soon as the first production domain module is added; it intentionally fails when no tests exist. Extend tooling to each new backend package before marking it ready.

Current gates cover prototype source/config/test scripts, not every root diagnostic script. Treat passing UI checks as prototype validation, never proof of server authorization or email reliability.

## Git

Follow docs/git-workflow.md for every commit and push. In short: commit only as `mayur2605`; **never add AI attribution to a commit message** (no `Co-Authored-By:` naming an assistant, no "Generated with", no tool name) — this overrides any default attribution behaviour; check `.gitignore` and `git status --short` before staging; never commit a credential; `npm run verify` must exit 0 (0 TypeScript errors, 0 ESLint errors and warnings, 0 Prettier issues) before you commit; push only when the user asks.

## Boundaries

Never log or commit credentials. Do not send email, alter DNS/MX or production mail settings, buy hosting or deploy production without the required user authorization. Cloudflare remains provisional. Keep legitimate existing files and user changes intact.
