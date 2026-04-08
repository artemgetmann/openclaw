# Home Clone Rescue Index (2026-04-08)

This branch is a preservation breadcrumb for the dirty state that existed in
`~/Programming_Projects/openclaw` on 2026-04-08 before restoring the home clone
to clean `main`.

It is not a feature branch. It is an index.

## Why this exists

The home clone had mixed uncommitted work from multiple agents. Preserving it as
one blind WIP commit would have made recovery ambiguous. The state was split
into coherent rescue branches instead.

## Rescue branches

### 1. Telegram validation guidance

- Branch: `codex/rescue-telegram-live-guidance-2026-04-08`
- Commit: `83c9832c1a`
- Contains:
  - Telegram live-validation docs/skill narrowing
  - guidance that local CLI/browser validation should be the default for
    non-Telegram bugs
- Safe to delete later:
  - only after this guidance is either merged elsewhere or intentionally
    abandoned

### 2. Himalaya iCloud send wrapper

- Branch: `codex/rescue-himalaya-icloud-wrapper-2026-04-08`
- Commit: `b9769ab752`
- Contains:
  - Himalaya iCloud send wrapper
  - smoke harness
  - docs describing the Sent-copy skip behavior for larger iCloud attachment
    sends
- Safe to delete later:
  - only after the wrapper is merged, replaced, or explicitly rejected

### 3. Codex auth-profile pinning

- Branch: `codex/rescue-auth-profile-codex-pinning-2026-04-08`
- Commit: `f5230de1b7`
- Contains:
  - `openai-codex` single-active-profile selection
  - stricter permanent-failure handling for `refresh_token_reused`
  - related auth/profile tests
- Safe to delete later:
  - only after the change is merged, superseded, or explicitly dropped

### 4. Plugin discovery tracing

- Branch: `codex/rescue-plugin-discovery-tracing-2026-04-08`
- Commit: `670e7e53a9`
- Contains:
  - plugin discovery/loader timing traces
  - manifest-load reuse across discovery and manifest-registry
  - Firecrawl runtime web-tools test coverage
- Safe to delete later:
  - only after the instrumentation is merged, superseded, or intentionally
    abandoned

## Non-durable local backup taken before splitting

Before branch splitting, a raw local backup was written to:

- `/tmp/openclaw-home-rescue-2026-04-08/home-clone-dirty.patch`
- `/tmp/openclaw-home-rescue-2026-04-08/himalaya-untracked-scripts.tgz`

That snapshot is only a local emergency fallback. The durable recovery path is
the rescue branches listed above.

## Home clone policy after rescue

Once these branches are pushed and this index branch is pushed, the intended
state of `~/Programming_Projects/openclaw` is:

- branch: `main`
- worktree: clean
- role: canonical shared runtime checkout only

Feature work should continue on short-lived feature branches or temporary
worktrees, not in the canonical home clone.
