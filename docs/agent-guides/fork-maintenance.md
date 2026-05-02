# Fork Maintenance

This fork is not an upstream-tracking branch. Treat upstream as a source of candidates, not a branch to merge.

## Branch roles

- `upstream/main`: external source of fixes and ideas. Never merge it into this fork.
- `origin/main`: fork integration branch and consumer-product shipping branch.
  Shared stability, security, runtime, packaging, and upstream ports land here.
- `origin/codex/consumer-openclaw-project`: legacy/emergency fallback branch.
  Do not target it unless the user explicitly asks for an emergency backport.
- `consumer`: legacy branch name in old docs. Do not recreate it or target new work at it.
- If a user says "consumer branch", clarify whether they mean the legacy
  fallback before doing work there.

## Rules

- Never do blind upstream merges or rebases onto fork branches.
- Intake one bounded upstream change at a time.
- Default to `main`.
- Only port what materially improves one of these:
  - security or trust-boundary hardening
  - Telegram reliability or onboarding
  - macOS/local runtime stability
  - browser or gateway stability
  - session durability or restart recovery
  - packaging or first-run UX
- Default skip list:
  - new channels/providers that the product does not use
  - broad refactors with no direct user benefit
  - test-only churn
  - pricing/docs copy updates
  - Linux/container ergonomics that do not affect the fork's current product path

## Port method

- `cherry-pick`: use when the upstream commit is small, self-contained, and test-backed.
- `manual port`: use when the upstream fix depends on a refactor stack, overlaps fork-specific edits, or touches code already changed here.
- `skip`: use when value is low, risk is high, or the change is outside the fork's current priorities.

## Intake loop

1. `git fetch origin --prune && git fetch upstream --prune`
2. Review recent commits in `origin/main..upstream/main`
3. Write or update a dated intake report with:
   - commit
   - why it matters
   - target branch
   - port method
   - owner/status
4. Pick at most 1-3 upstream items for the current cycle
5. Port each item in a scoped worktree branch from `origin/main`
6. Run narrow tests for the touched path plus the relevant runtime smoke
7. Land to `main`
8. Use `codex/consumer-openclaw-project` only for explicit emergency backports

## Emergency consumer backport rules

- Prefer forwarding from `main`, not directly from upstream.
- Backport to `codex/consumer-openclaw-project` only when all three are true:
  - the change is consumer-critical
  - a user explicitly needs the legacy fallback branch
  - the port is small enough to validate in one pass
- If a backport touches browser startup, Telegram delivery, session routing, or
  onboarding, validate on the legacy branch before calling it done.

## Decision heuristics

- If the upstream change fixes a bug the fork already has, port it now
- If it hardens a trusted surface, port it unless the fork has already replaced that code path
- If it overlaps a recent fork-specific change, treat it as a manual-port candidate, not a reflex cherry-pick
- If the change starts a refactor chain, skip the chain and port the smallest safe fix instead

## Current drift this doc replaces

- Older docs still mention a `consumer` branch or
  `codex/consumer-openclaw-project` as product branches
- Older docs still show `git merge upstream/main`

Those instructions are stale. This document overrides them.

## Companion report

- Current intake snapshot: [upstream-intake-2026-03-25.md](./upstream-intake-2026-03-25.md)
