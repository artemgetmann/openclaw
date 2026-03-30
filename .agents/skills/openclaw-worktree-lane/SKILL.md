---
name: openclaw-worktree-lane
description: "OpenClaw-specific wrapper for creating and validating durable worktrees in this repo. Use when creating a new lane, choosing the right base branch, bootstrapping Telegram credentials, or handing work off into tmux."
---

# OpenClaw Worktree Lane

Use this skill when the task is about creating, choosing, or validating a worktree in this repository.

This skill is repo-specific. It does not replace the global tmux/worktree skills. It adds the OpenClaw rules that are easy to miss.

## Read first

1. `docs/agent-guides/workflow.md`
2. `docs/agent-guides/runtime-ops.md` when runtime ownership matters
3. `scripts/telegram-e2e/README.md` when the new lane will run Telegram live checks

## Hard rules for this repo

- The shared checkout at `/Users/user/Programming_Projects/openclaw` on `main` is runtime/orchestration only.
- Do not make tracked implementation edits in the shared checkout.
- Durable worktrees belong under `.worktrees/`, not `.codex/worktrees/`, unless the user explicitly asks otherwise.
- Before creating a worktree, fast-forward the chosen base branch so it matches `origin/<base>`.
- Use `bash scripts/new-worktree.sh <feature-name> --base <branch>` instead of ad-hoc `git worktree add`.

## Branch rules

- Consumer-product work targets `codex/consumer-openclaw-project`.
- General fork work targets `main`.
- Do not revive or target the legacy `consumer` branch unless the user explicitly asks.

## Telegram-specific lane setup

If the lane will touch Telegram live validation:

1. Run `bash scripts/bootstrap-worktree-telegram.sh` if `scripts/new-worktree.sh` did not already do it.
2. Run `scripts/telegram-live-runtime.sh ensure` from the worktree.
3. Print proof lines:
   - `branch=<branch>`
   - `worktree=<absolute-path>`
   - `head=<sha>`
   - `runtime_worktree=<absolute-path>`

## tmux handoff

If the user wants a tmux lane or agent handoff, combine this skill with the global tmux/worktree skills. This skill supplies the repo-specific rules; the tmux skill handles pane/session mechanics.
