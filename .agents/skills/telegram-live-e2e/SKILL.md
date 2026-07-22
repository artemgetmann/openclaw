---
name: telegram-live-e2e
description: "OpenClaw-specific checklist for Telegram live verification. Use when validating Telegram behavior against a live bot, especially thread/topic behavior, runtime ownership, userbot CLI probes, or model-picker callback flows."
---

# Telegram Live E2E

Use this skill only for live Telegram verification in this repository.

Do not use it as the default E2E path for non-Telegram bugs. For most browser,
tool-routing, or local agent issues, use the local OpenClaw/browser validation
flow first and bring in Telegram only when the Telegram bot/runtime itself is
part of the feature or the failure.

This skill exists because Telegram validation here has two failure classes:

1. real product bugs
2. fake failures caused by wrong runtime ownership, wrong bot token, cold caches, or flaky callback payloads

Do not skip the preflight.

## Lane policy

Choose one lane before doing anything live:

1. Pre-merge or risky Telegram behavior uses an isolated tester bot, state,
   config, port, and worktree runtime.
2. The daily `ai.jarvis.gateway` bot is only a serialized post-merge,
   post-deployment acceptance canary in a disposable Jarvis Lab topic.

Most parallel agents run local tests. Telegram-sensitive branches claim
exclusive tester lanes. Never replace tester lanes with the daily bot, and
never allow concurrent daily-bot canaries: topics do not isolate token polling,
cursor state, global config, provider quotas, or the gateway process.

Choose the deployed source explicitly:

- After a packaged release, omit `--runtime-source` or pass
  `--runtime-source jarvis-managed-bundle`. This strict default rejects a
  protected source hotfix.
- After `scripts/ship-jarvis-hotfix.sh`, pass
  `--runtime-source jarvis-break-glass-hotfix`. This requires the exact commit,
  complete protection marker/compatibility/backup receipts, Jarvis Application
  Support identity, PID/listener ownership, and deep RPC health.
- Use tester-lane warm-up only for isolated worktree bots. It is not a daily
  `ai.jarvis.gateway` provenance repair.

Always run `--dry-run` first. `--execute` requires fresh approval in the active
Codex chat. There is no automatic source fallback. This harness, not
`prove-main-telegram-runtime.sh`, owns the daily `ai.jarvis.gateway` canary.

## Read first

1. `docs/agent-guides/telegram-live.md`
2. `scripts/telegram-e2e/README.md`
3. `docs/agent-guides/runtime-ops.md` when the shared gateway or LaunchAgent is involved

When progress/status/final/TTS behavior is under test, also read
`docs/agent-guides/telegram-progress-proof.md` before running live proof.

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

Telegram-as-user must resolve one machine-local canonical session and shared
lock. Explicit session/lock overrides are only for hermetic tests or a
deliberately separate account. Treat divergent implicit legacy sessions as a
hard ambiguity; never repair that by copying, deleting, rotating, or
reauthenticating credentials.

## Preferred operator path

Use the repo-local CLI first:

- `openclaw telegram-user precheck ...`
- `openclaw telegram-user send ...`
- `openclaw telegram-user read ...`
- `openclaw telegram-user wait ...`

Use lower-level scripts only when the CLI path is missing the required feature.

## Temporary Forum Topics

When a live proof creates a Telegram forum topic, record the returned
`topic_anchor` and every message id created during the proof. Cleanup must be
bounded to that topic anchor and the proof's exact message ids only. Do not run
broad history deletion to remove a topic.

For temporary test topics, prefer:

```bash
openclaw telegram-user topic-delete --chat <forum-chat> --topic-anchor <topic_anchor> --json
```

Use exact message deletion only as a fallback when topic deletion fails or the
local checkout does not yet expose `topic-delete`. If falling back, report the
remaining topic anchor plainly so a follow-up can remove it. Do not claim cleanup
is complete when an empty test topic remains.

Deleting the Telegram topic does not remove its local OpenClaw session. For a
managed canary, use the harness's exact-key `sessions.delete` cleanup and verify
that key is absent afterward. The API archives the transcript as
`*.deleted.<timestamp>`; report that residual archive and never rewrite the
production session index or delete runtime files directly.

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
