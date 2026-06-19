---
name: "codex-worktree-adoption"
description: "Adopt Codex-created OpenClaw chat worktrees into the repo-standard warm or clean lane contract. Use when a Codex thread was created with Codex's built-in worktree option, when the current OpenClaw worktree is detached, cold, missing node_modules, missing .dev-launch.env, failing worktree-ready-check, failing pnpm exec vitest --version, or needs local dependencies before builds, tests, packaging, macOS app packaging, release prep, Telegram live E2E, or runtime validation."
---

# Codex Worktree Adoption

Use this only in OpenClaw/Jarvis checkouts that contain `scripts/adopt-codex-worktree.sh`.

Run the repo script as the source of truth:

```bash
bash scripts/adopt-codex-worktree.sh <feature-name> --mode warm
```

Use `--mode warm` for normal coding, tests, local dependency setup, and packaging prep. Warm mode intentionally copies the canonical Telegram userbot files but does not claim a tester bot or start an isolated Telegram runtime.

Use `--mode clean` when the lane may need live Telegram E2E:

```bash
bash scripts/adopt-codex-worktree.sh <feature-name> --mode clean
```

Clean mode matches the normal worktree path more closely: it attempts the tester bot claim, writes root `.env.local`, and runs bounded `scripts/telegram-live-runtime.sh ensure`.

For a Codex-spawned worktree that is already behind current `origin/main`, preserve the snapshot only when the user explicitly wants to continue in that exact lane:

```bash
bash scripts/adopt-codex-worktree.sh <feature-name> --mode warm --allow-stale-head
```

If the worktree already has local edits that must be preserved, add `--allow-dirty`. Do not use that flag casually; a clean Codex-spawned checkout should adopt without it.

After adoption, verify readiness:

```bash
bash scripts/worktree-ready-check.sh --root "$PWD" --mode warm
```

Do not symlink or copy `node_modules` from another checkout. The adoption script installs dependencies in-place through the repo-validated Node path and reuses the existing bootstrap, doctor, and readiness gates.

A directory existing is not readiness. Readiness means the lane has a branch, `.dev-launch.env`, local dependencies, and a passing worktree readiness proof.
