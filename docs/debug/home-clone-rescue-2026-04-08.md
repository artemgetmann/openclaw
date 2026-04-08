# Home Clone Rescue Index (2026-04-08)

This branch is a preservation breadcrumb for the dirty state that existed in
`~/Programming_Projects/openclaw` on 2026-04-08 before restoring the home clone
to clean `main`.

It is not a feature branch. It is an index.

## Audit disposition (2026-04-08)

| PR | Branch | Decision | Why |
| --- | --- | --- | --- |
| #381 | `codex/rescue-telegram-live-guidance-2026-04-08` | Close as obsolete/duplicate | The rescue commit `83c9832c1a` was already shipped on `main` in PR #385 (`3a6081ea7b`) and on consumer in PR #386 (`9fe9c0f4a5`). Keeping the rescue PR open only creates a duplicate docs path. |
| #382 | `codex/rescue-auth-profile-codex-pinning-2026-04-08` | Close as obsolete/duplicate | The rescue commit `f5230de1b7` was already shipped on `main` in PR #375 (`7e03d371c9`) and on consumer in PR #376 (`2fc61d1779`). The rescue PR no longer preserves unshipped value. |
| #383 | `codex/rescue-plugin-discovery-tracing-2026-04-08` | Keep open only as a preservation artifact; ship the clean follow-up PRs instead | This rescue lane mixes already-shipped overlap with one remaining useful slice. `src/plugins/provider-discovery.ts` and `src/secrets/runtime-web-tools.test.ts` already landed via PR #380 (`50fcca0571`). The only unique value left is the manifest/discovery cache work in `src/plugins/discovery.ts`, `src/plugins/loader.ts`, and `src/plugins/manifest-registry.ts`, now extracted into PR #392 (`main`) and PR #393 (`codex/consumer-openclaw-project`). Do not merge the rescue PR as-is. |
| #384 | `codex/rescue-himalaya-icloud-wrapper-2026-04-08` | Close as obsolete/superseded | The rescue commit `b9769ab752` is effectively the first half of merged PR #378: the wrapper/files match the shipped fix commit `e52145b003`, and `main` also includes the follow-up docs clarification commit `a257864816`. The rescue PR is now a worse duplicate of the real shipping PR. |

## Why this exists

The home clone had mixed uncommitted work from multiple agents. Preserving it as
one blind WIP commit would have made recovery ambiguous. The state was split
into coherent rescue branches instead.

## Rescue branches

### 1. Telegram validation guidance

- Branch: `codex/rescue-telegram-live-guidance-2026-04-08`
- Commit: `83c9832c1a`
- Draft PR: `#381`
- Decision:
  - Closed as obsolete/duplicate
- Audit note:
  - Same docs slice already shipped on `main` in PR #385 (`3a6081ea7b`)
  - Same docs slice already shipped on consumer in PR #386 (`9fe9c0f4a5`)
  - Rescue PR also carried unrelated earlier preservation commits, so leaving it open would be confusing
- Contains:
  - Telegram live-validation docs/skill narrowing
  - guidance that local CLI/browser validation should be the default for
    non-Telegram bugs
- Safe to delete later:
  - yes, after PR closure and any routine rescue-branch cleanup

### 2. Himalaya iCloud send wrapper

- Branch: `codex/rescue-himalaya-icloud-wrapper-2026-04-08`
- Commit: `b9769ab752`
- Draft PR: `#384`
- Decision:
  - Closed as obsolete/superseded
- Audit note:
  - Main already shipped the real fix in PR #378
  - Rescue commit `b9769ab752` matches the shipped wrapper/files from `e52145b003`
  - Main also includes the follow-up docs clarification commit `a257864816`, so the rescue PR is strictly worse than the merged path
- Contains:
  - Himalaya iCloud send wrapper
  - smoke harness
  - docs describing the Sent-copy skip behavior for larger iCloud attachment
    sends
- Safe to delete later:
  - yes, after PR closure and any routine rescue-branch cleanup

### 3. Codex auth-profile pinning

- Branch: `codex/rescue-auth-profile-codex-pinning-2026-04-08`
- Commit: `f5230de1b7`
- Draft PR: `#382`
- Decision:
  - Closed as obsolete/duplicate
- Audit note:
  - Same auth/profile patch already shipped on `main` in PR #375 (`7e03d371c9`)
  - Same auth/profile patch already shipped on consumer in PR #376 (`2fc61d1779`)
  - Rescue PR no longer preserves unique unmerged work
- Contains:
  - `openai-codex` single-active-profile selection
  - stricter permanent-failure handling for `refresh_token_reused`
  - related auth/profile tests
- Safe to delete later:
  - yes, after PR closure and any routine rescue-branch cleanup

### 4. Plugin discovery tracing

- Branch: `codex/rescue-plugin-discovery-tracing-2026-04-08`
- Commit: `670e7e53a9`
- Draft PR: `#383`
- Decision:
  - Keep open only as a preservation artifact
  - Superseded for shipping by clean follow-up PR #392 on `main`
  - Superseded for shipping by clean follow-up PR #393 on `codex/consumer-openclaw-project`
- Audit note:
  - `src/plugins/provider-discovery.ts` and `src/secrets/runtime-web-tools.test.ts` already shipped via PR #380 (`50fcca0571`)
  - The remaining unique value is limited to:
    - `src/plugins/discovery.ts`
    - `src/plugins/loader.ts`
    - `src/plugins/manifest-registry.ts`
  - The clean extraction now lives in:
    - PR #392 targeting `main`
    - PR #393 targeting `codex/consumer-openclaw-project`
  - Do not merge the rescue PR as-is because it still carries already-shipped overlap from the dirty home-clone preservation pass
- Contains:
  - plugin discovery/loader timing traces
  - manifest-load reuse across discovery and manifest-registry
  - Firecrawl runtime web-tools test coverage
- Safe to delete later:
  - yes, after PR #392 and PR #393 merge or are intentionally abandoned

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
