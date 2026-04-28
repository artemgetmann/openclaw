# Telegram live checks

Use this only when Telegram behavior itself is under test, or after the isolated
browser and agent smoke flow in `docs/agent-guides/browser-agent-e2e.md` has
already passed and you still need Telegram transport proof.

Do not use Telegram as the default first-pass E2E path for non-Telegram bugs.
For most agent/tool/browser issues, local OpenClaw CLI validation is the faster
and more reliable default.

## Required precheck before any live Telegram validation

- Confirm the current git branch has a real name and is not `HEAD`.
- Confirm the running gateway process belongs to the current worktree path.
- If the runtime path does not match, restart the gateway from this worktree before testing.
- Prefer `bash scripts/telegram-live-runtime.sh ensure` as the canonical fixer/checker for isolated Telegram tester lanes.
- Preferred operator surface now lives under `openclaw telegram ...`:
  - `openclaw telegram doctor`
  - `openclaw telegram runtime ensure`
  - `openclaw telegram runtime release`
  - `openclaw telegram smoke dm-reply`
- `bash scripts/telegram-live-preflight.sh` is read-only now; it inspects the derived isolated runtime profile and tells you when to run `ensure`.
- Confirm the running isolated gateway process belongs to the current worktree path before trusting Telegram replies.
- If `.env.local` is missing, run `bash scripts/assign-bot.sh`.
- Never print raw token values.
- Emit proof lines in logs or output:
  - `branch=<...>`
  - `runtime_worktree=<...>`

## Worktree bot setup

- Preferred worktree entrypoint: `bash scripts/new-worktree.sh <feature-name>`
- The helper creates repo-owned worktrees under `.worktrees/<feature-name>`.
- For each new worktree:
  - Copy `.env.bots` from the main checkout if needed
  - Run `bash scripts/assign-bot.sh`
- Each worktree gets its own test bot. Do not reuse production tokens.
- Worktree tester baselines strip inherited Telegram secrets on purpose. If the
  source config had named Telegram accounts, the bootstrap writes non-secret
  strip metadata to the baseline `auth-sync.json`, and
  `bash scripts/telegram-live-preflight.sh` prints the affected account ids.
  Refresh those named accounts with their own `tokenFile`/`botToken`, or disable
  them, before testing named-account bots.

## Common tools

- High-level workflow/operator path:
  - `pnpm openclaw:local telegram doctor --chat @jarvis_tester_1_bot`
  - `pnpm openclaw:local telegram runtime ensure`
  - `pnpm openclaw:local telegram smoke dm-reply --chat @jarvis_tester_1_bot --json`
- User E2E operator path:
  - Start broad triage with `pnpm openclaw:local telegram-user inbox --json`
  - Use `pnpm openclaw:local telegram-user inbox --unread --json` for unread-only sweeps
  - Narrow with `--dm-only` and `--limit` when you only need a lighter scan
  - Use `pnpm openclaw:local telegram-user read --chat <chat> --limit <n> --json` only after picking the target chat
  - Then continue with `precheck`, `send`, or `wait` on that chosen chat
- Full repo-local details:
  - `scripts/telegram-e2e/README.md`

## Known failure pattern

- A live Telegram test can fail even when code is correct if the wrong runtime process owns the gateway. Prove runtime ownership before debugging behavior.
