# Consumer Next Pass Plan

Last updated: 2026-03-21
Owner: Codex worktree `codex/simplify-consumer-bootstrap-flow-telegram`
Status: active

## Goal

Lock the consumer Telegram lane as genuinely working, then run the consumer
setup flow as if we were a brand-new user and record the remaining friction
without reopening random architecture debates.

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

4. Verify what is actually seeded into the consumer runtime.
   - Check the consumer runtime root at
     `~/Library/Application Support/OpenClaw Consumer/.openclaw`.
   - Confirm which workspace files are seeded automatically.
   - Confirm whether consumer "pre-bundled skills" means real shipped skill
     files or only a config allowlist for bundled skills.
   - Why: the product claim needs to match reality before we run the full
     walkthrough.

5. Run one fresh-user walkthrough.
   - Start from the packaged consumer app.
   - Walk the Telegram flow exactly as a new user would see it.
   - Reuse the existing consumer Telegram bot for speed unless a clean-bot run
     is needed to isolate a bug.
   - Explicitly verify the first real Telegram reply path:
     - does the bot answer?
     - does bootstrap ask "who am I / who are you" style first-run questions?
     - does the workspace ritual complete or get silently skipped?
   - Current reality:
     - Telegram setup and delivery lane are healthy.
     - First real reply is now self-verified through the repo's Telegram
       userbot harness:
       - a userbot DM was sent to `@jarvis_consumer_bot`
       - the bot replied in the same DM
       - the reply asked identity/bootstrap questions and offered a name
         choice, which is the product behavior we wanted to prove
     - Remaining work is no longer "make the bot reply at all."
     - Remaining work is to evaluate whether the first-reply behavior is the
       right consumer UX and whether the surrounding app states still lie.
   - Capture any friction points, confusing copy, stale health/UI state, or
     missing bootstrap behavior.
   - Current infrastructure bug to resolve during this pass:
     - the consumer LaunchAgent can still point at a stale sibling worktree
       (for example `f65c`) instead of this worktree's `dist/index.js`
     - when that happens, the app and Telegram lane feel randomly inconsistent
       even though the user did nothing wrong
     - fix this before trusting any "fresh-user" walkthrough results
   - Telegram command surface also needs a consumer pass:
     - default slash commands should be reduced to only the few commands normal
       consumer users actually need
     - the rest should move behind `/help`, `/commands`, or another advanced
       discovery path
   - Why: dumping a giant slash-command menu on first-time users is product
     sabotage, not power.

6. Record the findings before any more polish.
   - Update the tracker and Telegram follow-ups doc with what still feels
     clunky.
   - Why: if context compacts, the next pass should not depend on memory.

## Current known non-blockers

- `General` can still show stale gateway health even when Telegram is healthy.
- The simplified consumer shell still has leftover `Permissions` internals to
  clean later.
- Clicking the app in the Dock can still activate the app without surfacing the
  settings window.
- The live Telegram card should keep an `Open your bot` action after relaunch.
- The consumer LaunchAgent can drift to another worktree path and revive the
  wrong gateway binary on port `19001`.
- Consumer workspace templates are seeded today, but actual shipped
  pre-bundled skill files still need explicit verification.
- Native SwiftUI app GUI E2E is still manual-first; backend/runtime/log E2E is
  already scriptable.
- Browser should still become part of the first-install validation checklist in
  a later pass, but it is not the current onboarding blocker.

## Product decisions to test next

1. Auto-kick the first Telegram reply after setup.
   - Proposed behavior:
     - user sends any first DM to the bot (not hardcoded to `/start` or `hi`)
     - app captures that DM
     - app immediately triggers the first real agent reply instead of leaving the
       user to manually send a second message
   - Why: Telegram bots cannot start the conversation from nothing, but once the
     user has sent the first message we should remove the extra friction and let
     the bot naturally begin the bootstrap ritual.
   - Validation question:
     - should the first reply always start the `BOOTSTRAP.md` ritual, or should
       it only do that when the workspace still looks uninitialized?

2. Clarify what "pre-bundled skills" means in consumer.
   - Today:
     - the consumer config seeds a curated bundled-skill allowlist
     - the consumer workspace does not currently expose a `skills/` folder
   - Decision needed:
     - keep the runtime-managed allowlist model
     - or ship visible/editable consumer skill files too

3. Defer provider/auth strategy until onboarding flow is stable.
   - Do not mix billing/auth architecture work into the current onboarding pass.
   - Questions to resolve later:
     - founder-managed shared credentials for early testers
     - user-owned ChatGPT / Claude auth
     - dedicated project-owned test accounts
     - API-key versus account-auth tradeoffs
   - Current recommendation:
     - for MVP testing, prefer the lowest-friction temporary setup
     - but keep it isolated from the Telegram/bootstrap UX work so we can judge
       onboarding on its own merits
   - Verified current state:
     - consumer main agent auth was re-authenticated successfully
     - a self-driven Telegram userbot E2E now proves the consumer runtime can
       generate a first real reply after setup

4. Add browser reliability to the first-install checklist later.
   - Browser should be part of the initial consumer setup validation path.
   - Why: a "working" install is not actually working if the browser lane is dead.
   - Not the next blocker; keep it parked until Telegram/bootstrap is stable.
