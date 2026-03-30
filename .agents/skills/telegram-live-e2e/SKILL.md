---
name: telegram-live-e2e
description: "OpenClaw-specific checklist for Telegram live verification. Use when validating Telegram behavior against a live bot, especially thread/topic behavior, runtime ownership, userbot CLI probes, or model-picker callback flows."
---

# Telegram Live E2E

Use this skill for live Telegram verification in this repository.

This skill exists because Telegram validation here has two failure classes:

1. real product bugs
2. fake failures caused by wrong runtime ownership, wrong bot token, cold caches, or flaky callback payloads

Do not skip the preflight.

## Read first

1. `docs/agent-guides/telegram-live.md`
2. `scripts/telegram-e2e/README.md`
3. `docs/agent-guides/runtime-ops.md` when the shared gateway or LaunchAgent is involved

## Mandatory preflight

Before trusting any Telegram result, print:

- `branch=<branch>`
- `runtime_worktree=<absolute-path>`
- `runtime_commit=<sha>`
- `current_lane_bot=<bot username if known>`

Then prove:

1. the current branch is a real branch, not detached `HEAD`
2. the runtime process belongs to the intended worktree
3. the intended tester bot token is claimed by this worktree
4. the userbot/session tooling is pointed at the same bot you think you are testing

## Preferred operator path

Use the repo-local CLI first:

- `pnpm openclaw:local telegram-user precheck ...`
- `pnpm openclaw:local telegram-user send ...`
- `pnpm openclaw:local telegram-user read ...`
- `pnpm openclaw:local telegram-user wait ...`

Use lower-level scripts only when the CLI path is missing the required feature.

## Validation rule for /model and similar UX

Do not treat text-command success as callback success.

For model switching, think in separate lanes:

1. text command path
   - `/model openai-codex/gpt-5.4`
2. callback path
   - `/model`
   - provider button
   - model button

If the feature relies on buttons, validate the button path explicitly.

## Restart-aware verification

For Telegram callback/session bugs, validate both:

1. hot runtime behavior
2. post-restart behavior

If it only works before restart, the bug is not fixed.

## Evidence to capture on callback bugs

- `message_thread_id`
- `direct_messages_topic.topic_id`
- `reply_to_msg_id`
- `reply_to_top_id`
- sent-message metadata hit/miss
- session key used for the write

If those are missing, you are debugging Telegram blind.
