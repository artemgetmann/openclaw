---
name: "codex-worktree-adoption"
description: "Adopt existing Codex-created OpenClaw chat worktrees into the repo-standard warm or clean lane contract. Use before reporting a blocker when a Codex worktree is detached, cold, missing node_modules or .dev-launch.env, failing worktree-ready-check, unable to resolve pnpm-local tools such as tsx, tsdown, or vitest, missing or stale dist/build readiness because local dependencies are required, or needs local dependencies before builds, tests, packaging, macOS app packaging, release prep, Telegram live E2E, or runtime validation."
---

# Codex Worktree Adoption

Use this only in OpenClaw/Jarvis checkouts that contain `scripts/adopt-codex-worktree.sh`.

This skill repairs an existing worktree created by Codex's built-in worktree
option. To prepare a brand-new repository worktree without reserving tester
identity, use `scripts/new-worktree.sh <feature-name> --mode warm` from the
sacred home clone instead of creating a worktree through this adoption script.

Do not report a missing-tool or cold-worktree blocker until canonical adoption
and the readiness check below have run. This includes failures resolving local
commands through pnpm, such as `tsx`, `tsdown`, or `vitest`, and missing or
stale build output when the requested build first needs local dependencies.

Run the repo script as the source of truth:

```bash
bash scripts/adopt-codex-worktree.sh <feature-name> --mode warm
```

Use `--mode warm` for normal coding, tests, local dependency setup, and packaging prep. Warm mode intentionally copies the canonical Telegram userbot files but does not claim a tester bot or start an isolated Telegram runtime.

Prepare dependencies, requested build output, local tool resolution, and model
authentication in warm mode while tester identity remains untouched. Only
after those checks pass, use the owning `telegram-live-e2e` skill and runbook
to reserve a tester identity and set up its isolated runtime explicitly.

Clean mode is not a side-effect-free preparation step. It can claim tester
state and attempt `telegram-live-runtime.sh ensure` during adoption:

```bash
bash scripts/adopt-codex-worktree.sh <feature-name> --mode clean
```

Use clean adoption only when immediate tester reservation/runtime setup is
intended and authorized. Do not select it merely because the lane may need live
Telegram E2E later.

For a Codex-spawned worktree that is already behind current `origin/main`, preserve the snapshot only when the user explicitly wants to continue in that exact lane:

```bash
bash scripts/adopt-codex-worktree.sh <feature-name> --mode warm --allow-stale-head
```

If the worktree already has local edits that must be preserved, add `--allow-dirty`. Do not use that flag casually; a clean Codex-spawned checkout should adopt without it.

After adoption, verify readiness:

```bash
bash scripts/worktree-ready-check.sh --root "$PWD" --mode warm
```

Warm adoption restores local dependency and tool resolution but intentionally
skips the build. If the original failure was missing or stale `dist` output,
rerun the task's canonical guarded build after adoption before deciding that
the lane is blocked.

Never symlink or copy `node_modules` from another checkout. The adoption script
installs dependencies in-place through the repo-validated Node path and reuses
the existing bootstrap, doctor, and readiness gates.

A directory existing is not readiness. Readiness means the lane has a branch,
`.dev-launch.env`, local dependencies, and a passing worktree readiness proof.
Stop only when the canonical adoption command itself fails, the machine-wide
guard refuses the work, preserving a stale snapshot requires authority you do
not have, or readiness remains broken after adoption.
