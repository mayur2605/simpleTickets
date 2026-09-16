# Git workflow rules

Binding on every contributor and every coding agent working in this repository (Claude Code, Codex, any other). These rules are not style preferences — a commit that breaks one of them is a defect.

**One-time setup in every clone** (hooks live in `.githooks/`, and Git does not enable them automatically):

```bash
git config core.hooksPath .githooks
```

## 1. Identity and authorship

- Commit and push **only as `mayur2605`**. The identity is set local to this repository; do not change it, and do not fall back to a global or guessed identity.
- **Never add AI attribution.** No `Co-Authored-By:` trailer naming an assistant or model, no "Generated with", no tool name, no robot emoji, no "on behalf of". The author and the committer are the person. This overrides any default attribution behaviour an agent has.
- Before pushing, confirm the identity actually in effect:

```bash
git config user.name && git config user.email && gh auth status
```

All three must show `mayur2605`. If they do not, stop and ask — do not push under another account.

## 2. Before every commit

Every item must hold. No exceptions, no "I'll fix it in the next commit".

1. **Review what is staged.** Run `git status --short` and read every path. Nothing unexpected, nothing belonging to another agent's in-flight work, no stray local files.
2. **Check `.gitignore` first.** Dependencies, build output, local artifacts and test outputs never get committed. If a new generated file appears, add it to `.gitignore` — do not commit it and delete it later.
3. **No secrets.** No passwords, tokens, API keys, mailbox credentials, private keys, session IDs or cookies — in source, config, fixtures, logs, screenshots or commit messages. Mailbox and host *names* are operational settings and are fine; credentials never are.
4. **The gate is green.** From `prototype/`:

```bash
npm run verify
```

It must exit 0, which means all of:

| Check | Required result |
| --- | --- |
| `npm run typecheck` | 0 TypeScript errors |
| `npm run lint` | 0 errors **and** 0 warnings (`--max-warnings 0`) |
| `npm run format:check` | 0 files needing formatting |
| `npm test` | smoke test prints PASS |
| `npm run build` | succeeds |

Run `npm run format` before committing rather than discovering the failure at the gate.

5. **Never weaken a rule to get green.** No `--no-verify`, no `eslint-disable`, no `@ts-ignore`, no `any`, no non-null assertion, no skipped or deleted test, no relaxed `tsconfig.json`, `eslint.config.mjs` or Prettier config. Fix the code. A genuinely necessary exception is narrow, commented with its reason, and raised with the user.

## 3. Commit messages

- Imperative subject line, roughly 72 characters or less, then a blank line, then why the change was needed.
- One logical change per commit. Do not mix a refactor, a fix and a formatting pass.
- No AI attribution trailer of any kind (see §1).

## 4. Pushing

- Push **only when the user asks.** Committing locally does not imply permission to publish.
- Always as `mayur2605`.
- **Never force-push** a branch that exists on the remote, and never rewrite history that has been pushed.
- Amend and rebase are fine only for local commits that have never been pushed.
- Creating a remote repository, changing a remote URL, or enabling auto-merge each need explicit approval.

## 5. If a credential is ever committed

Treat it as leaked the moment it lands in a commit, even locally.

1. Rotate the credential first. This is the step that actually protects the account.
2. Then remove it from history. Deleting the file in a later commit does **not** remove it — the old blob is still reachable.
3. Tell the user what was exposed and where it may have been pushed.

## 6. Two agents, one repository

This project has been worked by more than one coding agent at the same time. That is how work gets silently overwritten.

- **Before starting:** run `git status` and `git log --oneline -5`. A dirty tree you did not create means someone else is mid-change — stop and ask rather than editing the same files.
- **Before finishing:** commit your own work, so the next agent starts from a clean tree and can see what changed.
- Never revert or reformat another agent's in-flight edits to match your own preference.

## 7. Already enforced in this repo

- `.gitignore` covers `node_modules/`, `dist/`, `.env*`, `playwright-report/`, `test-results/` and `prototype/*-preview.png` (smoke-test screenshots, rewritten by every `npm test` run).
- Lockfiles **are** committed — `prototype/package-lock.json` and `tools/mail-check/package-lock.json`. Install with `npm ci`, never `npm install --force` or `--legacy-peer-deps`.
- `.remember/` ignores itself.

## 8. Hooks

`.githooks/` is tracked, so every clone and every agent gets the same checks once `core.hooksPath` is set (see the setup command at the top).

**`pre-commit`** blocks a commit when staged changes contain:
- a `.env` file, or anything under `node_modules/` or `dist/`
- a file **named** like a secret — `.probe-token`, `id_rsa`, `*.pem`, `credentials.json`
- a file whose whole content is one long high-entropy string, whatever it is named
- a private key block, AWS access key, GitHub token or Slack token
- a hardcoded credential assignment such as `password = "..."` with a non-trivial literal
- a file inside `prototype/` that Prettier would reformat

The first two rules exist because a 64-character hex probe token was committed on
17 September 2026. It lived in its own file and contained no `password =` shape, so the
content patterns did not match it. Secrets are not always assignments.

**`commit-msg`** blocks a commit message containing AI attribution — a `Co-Authored-By:` line naming a model or assistant, a "Generated with" line, or a robot emoji.

These hooks are a safety net for the expensive-to-undo mistakes, **not** the gate. They deliberately do not run `npm run verify`: at roughly 40 seconds it would push people toward `--no-verify`, which disables every check at once. Run `npm run verify` yourself before committing, as §2 requires.

`--no-verify` skips both hooks. Using it is a rule violation, not a shortcut.
