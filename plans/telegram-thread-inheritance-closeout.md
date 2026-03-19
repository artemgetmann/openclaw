# Telegram Thread Inheritance Closeout Plan

## Summary

Use manual Telegram verification as the ship gate for `/model` and `/think`
future-thread inheritance. Treat automation hardening as a separate reliability
task so flaky probe behavior does not block product closure.

The inheritance candidate code already compiles and targeted tests pass. The
remaining uncertainty is in the Telethon/userbot probe, not the core
Telegram-thread inheritance logic.

## Current State

- Feature candidate:
  - topic/thread session seeding is implemented for Telegram topic creation
  - future-thread defaults for Telegram model picker callbacks are persisted
- Local validation status:
  - `pnpm build` passes
  - `pnpm test -- extensions/telegram/src/thread-session-seeding.test.ts` passes
  - `pnpm test -- src/auto-reply/reply/session.test.ts -t "future-thread"` passes
- Live evidence:
  - `Jarvis Exec` replied in the exact DM thread anchors created by the probe
  - commit `1a7a619` was serving those replies from the correct worktree
  - earlier E2E false negatives were caused by measurement/tooling issues

## Workstreams

### 1. Product closeout via manual Telegram validation

Do not modify inheritance logic again unless manual validation disproves the
current behavior.

#### DM threaded mode on `Jarvis Exec`

1. Create thread `Z`
2. Create thread `X`
3. In `X`, send:
   - `/model anthropic/claude-sonnet-4-6`
   - `/think off`
   - `/status`
4. Create new thread `Y`
5. In `Y`, send `/status`
6. In pre-existing thread `Z`, send `/status`

Expected:

- `X`: `anthropic/claude-sonnet-4-6`, `Think: off`
- `Y`: same as `X` (inherits)
- `Z`: stays on prior/default values and does not inherit

#### Group forum topic flow

Repeat the same pattern in a Telegram forum group:

- old topic `C`
- changed topic `A`
- new topic `B`

Expected:

- `A`: changed values
- `B`: inherits
- `C`: unchanged

#### Main bot confirmation

After `Jarvis Exec` passes, repeat the DM threaded check once on the main
Jarvis bot. Use this only to confirm production wiring, not to debug logic.

## Automation Hardening

Treat the current probe as convenience tooling, not the source of truth, until
all items below are complete.

### Probe fixes

- Remove hard-coded bot identity assumptions from
  `scripts/telegram-e2e/probe_dm_thread_inheritance.py`
- Resolve the target bot dynamically via `get_entity(...)`
- Broaden reply matching to accept real Telegram DM-thread reply shapes instead
  of only one exact `reply_to_top_id` + `sender_id` combination
- Print explicit diagnostics:
  - resolved bot username and id
  - matched reply fields
  - ignored messages and why they were ignored

### Userbot session safety

- Enforce single-owner access to `scripts/telegram-e2e/tmp/userbot.session`
- Fail fast if another Telethon process already holds the session
- Do not run probe and ad hoc inspection commands concurrently against the same
  session file

### Runtime-isolation precheck

Before any live Telegram validation, print:

- current branch
- current worktree path
- assigned bot username and id
- whether another worktree already claims the same Telegram bot token

Fail fast if the token is shared across multiple live worktrees.

### Gateway observability rule

Treat gateway RPC/status probe failures as non-authoritative for Telegram
message-serving validation unless they correlate with missing bot replies in the
same lane.

## Acceptance Criteria

Ship closure is complete when all of the following are true:

- targeted local checks still pass:
  - `pnpm build`
  - `pnpm test -- extensions/telegram/src/thread-session-seeding.test.ts`
  - `pnpm test -- src/auto-reply/reply/session.test.ts -t "future-thread"`
- manual Telegram DM-thread validation passes on `Jarvis Exec`
- manual Telegram main-bot validation passes once
- no further inheritance logic edits are made unless manual validation shows a
  real behavior miss

Automation hardening is complete when:

- probe resolves bot identity dynamically
- probe observes the same replies already seen manually
- userbot session is single-owner during each run
- probe output is trustworthy enough to use as a convenience check

## Working Assumptions

- The screenshot showing replies from commit `1a7a619` in the E2E-created DM
  threads is valid evidence that the correct worktree runtime was serving
  `Jarvis Exec`
- The remaining problem is probe reliability, not inheritance logic
- Manual Telegram verification is the release gate for this task
