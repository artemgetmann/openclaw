# OpenClaw Repo-Local Skills

These skills are project-specific wrappers around the canonical repo docs.

Keep the detailed procedures in the docs. Use skills to force the right docs and checks into the execution path for recurring workflows that repeatedly go wrong when agents improvise.

## Canonical docs first

- Worktrees and branch policy:
  - `docs/agent-guides/workflow.md`
- Default local/browser/agent validation:
  - `docs/agent-guides/browser-agent-e2e.md`
- Telegram live validation:
  - `docs/agent-guides/telegram-live.md`
  - `scripts/telegram-e2e/README.md`
- Runtime ownership and restart rules:
  - `docs/agent-guides/runtime-ops.md`

## Repo-local skills

- `openclaw-worktree-lane`
  - Use when the user wants an actual new worktree/lane created in this repo.
  - Wraps the repo's branch policy, `.worktrees/` rules, and `scripts/new-worktree.sh`.
  - If tmux handoff is also needed, combine with the global `tmux-worktree-handoff` skill.

- `telegram-live-e2e`
  - Use only when the user wants live Telegram verification or Telegram runtime debugging in this repo.
  - Do not use it as the default E2E path for non-Telegram bugs; use local OpenClaw CLI / browser-agent validation first.
  - Wraps tester-bot/runtime ownership proof and forces separation of text-command vs callback-button validation.

- `parallels-discord-roundtrip`
  - Use for the repo's Parallels Discord smoke workflow.

## Organization rule

- Put repeatable, error-prone repo workflows into repo-local skills.
- Keep long procedures, exact commands, and evolving operational detail in the docs.
- Skills should point to docs, not duplicate them.
