# Telegram live checks

Use this after the isolated browser and agent smoke flow in `docs/agent-guides/browser-agent-e2e.md` unless the bug is clearly Telegram-specific.

## Required precheck before any live Telegram validation

- Confirm the current git branch has a real name and is not `HEAD`.
- Confirm the running gateway process belongs to the current worktree path.
- If the runtime path does not match, restart the gateway from this worktree before testing.
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

## Common tools

- User E2E operator path:
  - `pnpm openclaw:local telegram-user <precheck|send|read|wait> ...`
- Full repo-local details:
  - `scripts/telegram-e2e/README.md`

## Known failure pattern

- A live Telegram test can fail even when code is correct if the wrong runtime process owns the gateway. Prove runtime ownership before debugging behavior.
