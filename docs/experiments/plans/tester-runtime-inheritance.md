# Durable Tester Baseline + Safe Stale-Bot Reclaim

## Summary

Implement a durable per-worktree tester baseline that is created automatically during `scripts/new-worktree.sh`, then make all local worktree operator surfaces actually use that baseline. For Telegram, replace raw `.env.local` claim logic with active-vs-stale ownership checks so obviously dead tester lanes get reclaimed automatically, while active lanes are left alone. Do not touch the shared main runtime in-place.

## Key Changes

- Add a tester-baseline bootstrap step for fresh worktrees.
  - Create a stable per-worktree state root under `~/.openclaw/worktree-runtimes/<derived-id>`.
  - Snapshot the canonical base config from `~/.openclaw/openclaw.json` into the derived state dir.
  - Sanitize inherited Telegram bot tokens out of the copied config.
  - Snapshot auth stores for configured agents into the derived state dir with non-secret sync metadata.
- Extend `.dev-launch.env` and worktree runtime wrappers to actually use the tester baseline.
  - Write `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, and `OPENCLAW_GATEWAY_PORT`.
  - Load `.dev-launch.env` inside `scripts/openclaw-local.sh`.
  - Pass the derived config path into `scripts/dev-launch-mac.sh`.
- Seed isolated Telegram tester runtimes from the same tester baseline.
  - Copy the baseline auth snapshot into the derived Telegram runtime state before startup.
  - Keep isolated Telegram runtimes opted out of shared CLI auth sync.
- Replace stale bot blocking with active-ownership checks and explicit reclaim logs.
  - Only active isolated runtimes block reuse.
  - Stale claims are reclaimed automatically with redacted proof lines.
  - Reserved main-runtime Telegram tokens stay non-reclaimable.

## Test Plan

- Prove a fresh worktree gets a durable tester auth/config baseline.
- Prove inherited provider auth/config are copied from the canonical baseline.
- Prove stale tester bot claims are reclaimed.
- Prove active tester bot claims are not reclaimed.
- Prove shared main runtime config/state are not modified.

## Assumptions

- Canonical source remains `~/.openclaw/openclaw.json` plus `~/.openclaw/agents/<id>/agent/auth-profiles.json` unless tests override it.
- Snapshot copy is the right inheritance model; live shared-file reuse is not.
- Warm lanes inherit config/auth baseline even though they still skip the full Telegram ensure/build path.
