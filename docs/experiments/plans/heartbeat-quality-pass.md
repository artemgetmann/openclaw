# Heartbeat Quality Pass

## Summary

Implement this in two stages:

1. Land and review the fix on `main`
2. Port the validated fix to `codex/consumer-openclaw-project`

The pass has three goals:

- enable sane default heartbeat active hours so it does not ping at night
- give heartbeat awareness of its own recent delivered alerts so it can reason about repeats
- tighten heartbeat guidance so it prefers net-new action-needed items and shorter repeat nudges

Chosen defaults:

- active hours: daily `09:00` to `20:00`
- active-hours timezone: `user`
- recent-heartbeat memory shape: bounded internal session metadata buffer

## Current-state facts

- Heartbeat currently supports `activeHours`, but it is optional and off by default.
- Heartbeat currently dedupes only exact same-text alerts within 24 hours via `lastHeartbeatText` and `lastHeartbeatSentAt`.
- Daily memory is event-driven, not guaranteed every calendar day.
- Dated memory files are created by:
  - personal-session daily rollover after the configured daily boundary
  - non-heartbeat, non-CLI pre-compaction memory flush
- Heartbeat does not currently have a built-in readable history of its own recent delivered outputs; it only stores the last exact delivered text for dedupe.

## Implementation

### 1. Active-hours defaults

- Add default heartbeat active hours:
  - `start: "09:00"`
  - `end: "20:00"`
  - `timezone: "user"`
- Keep cadence unchanged at `1h` for now.
- Apply the same default behavior in fork `main` and consumer after validation.

### 2. Recent-heartbeat memory

- Extend session heartbeat state beyond the single last-text dedupe fields.
- Store the last `3-5` delivered heartbeat alerts in session metadata.
- Each history item should include:
  - sent timestamp
  - status
  - delivery channel / target
  - short normalized text preview
- Keep the current exact-text dedupe logic as a safety net.

### 3. Prompt behavior

- Inject recent heartbeat history into the heartbeat turn context.
- Update heartbeat guidance so it:
  - prefers net-new action-needed items
  - avoids repeating the same unresolved blocker unless status changed materially
  - uses a shorter nudge when resurfacing the same blocker
  - explicitly calls out items blocked on Artem input / approval / decision
  - still continues pending work automatically when no fresh input is required

### 4. Daily-memory clarification

- Do not use daily memory as the source of truth for heartbeat repeat suppression.
- Document clearly that dated memory files are event-driven and may be absent on quiet days.
- Leave daily-memory architecture unchanged in this pass.

## Validation

- Active-hours tests:
  - heartbeat allowed at `09:00`
  - heartbeat blocked at `20:00` and later
  - `timezone: "user"` resolves through current user/host behavior
- Recent-history tests:
  - first alert stores a history item
  - exact same text within 24h still suppresses
  - bounded history trims older entries
  - prompt includes recent-history context on subsequent heartbeat runs
- Behavior tests:
  - unresolved blocker across hourly runs does not resend the same full alert every time
  - materially changed blocker can still surface
  - no nightly delivery when active-hours gate is active

## Rollout

- Merge `main` first
- Review prompt wording and behavior
- Port to `codex/consumer-openclaw-project`
