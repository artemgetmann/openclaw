# Consumer Next Pass Plan

Last updated: 2026-03-21
Owner: Codex worktree `codex/simplify-consumer-bootstrap-flow-telegram`
Status: active

## Goal

Finish the consumer Telegram lane on top of the latest
`codex/consumer-openclaw-project` app shell, then re-run the consumer setup flow
as if we were a brand-new user.

## Order of operations

1. Add the missing steady-state Telegram affordance.
   - Add an `Open your bot` action on the live Telegram card.
   - Why: once Telegram is already configured, the app should still let users
     jump back into the bot without walking through onboarding again.

2. Sync this branch forward from `codex/consumer-openclaw-project`.
   - Merge the latest consumer integration branch into this worktree branch.
   - Resolve UI/runtime conflicts here instead of letting the branch drift.
   - Why: future validation should happen on the newest consumer shell, not on a
     stale fork of it.

3. Rebuild and reopen the guarded consumer app.
   - Use:
     - `scripts/package-consumer-mac-app.sh`
     - `scripts/open-consumer-mac-app.sh`
   - Why: this is the only reliable way to avoid launching the wrong app bundle.

4. Run one fresh-user walkthrough.
   - Start from the packaged consumer app.
   - Walk the Telegram flow exactly as a new user would see it.
   - Capture any friction points, confusing copy, or stale health/UI state.

5. Record the findings before any more polish.
   - Update the tracker and Telegram follow-ups doc with what still feels
     clunky.
   - Why: if context compacts, the next pass should not depend on memory.

## Current known non-blockers

- `General` can still show stale gateway health even when Telegram is healthy.
- The simplified consumer shell still has leftover `Permissions` internals to
  clean later.
- Native SwiftUI app GUI E2E is still manual-first; backend/runtime/log E2E is
  already scriptable.
