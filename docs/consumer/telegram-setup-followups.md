# Consumer Telegram Setup Follow-ups

Last updated: 2026-03-27
Scope: consumer macOS Telegram onboarding polish and adjacent consumer-shell cleanup

## Current Tracker

- Imported Telegram-first-task onboarding work: live-validated in the packaged app; PR #174 is open against `codex/consumer-openclaw-project`.
  - Validation completed on March 27, 2026 in the isolated lane `consumer-first-run-permissions-20260326`.
  - Proof:
    1. packaged and opened the isolated consumer app
    2. confirmed onboarding reached the Telegram step on the real lane runtime
    3. sent a real Telegram DM to `@jarvis_consumer_bot`
    4. confirmed onboarding reached `Telegram verified` and enabled `Finish`
  - Why it matters: this is the end-to-end proof that the setup flow now blocks on a real Telegram task instead of claiming setup is done too early.

- Blocker from live test: onboarding can still disappear into the regular settings window before Telegram verification is done.
  - Current behavior: while the user is mid-Telegram setup, the onboarding surface can vanish and leave only the General settings window behind.
  - Why it matters: this breaks the one-flow-at-a-time model and strands the user halfway through setup.

- Blocker from fresh consumer E2E: onboarding still asks the user to choose a model/auth provider.
  - Current behavior: the consumer MVP shows a provider list such as Alibaba Cloud, Anthropic, BytePlus, and others during first run.
  - Why it matters: this is internal plumbing, not a consumer decision. MVP should use our default provider and only surface a simple failure state if our auth is broken.

- Follow-up from fresh consumer E2E: Location permission refresh can stay stale after the user enables it in System Settings.
  - Current behavior: onboarding can keep showing Location as not granted even after the matching app row is enabled and the user clicks `Refresh`.
  - Temporary product decision: keep Location visible as recommended, but do not let it block Telegram/setup validation.
  - Why it matters: Location still matters for `near me` tasks, but it should not derail validation of the main remote-control onboarding path.

- Copy follow-up: the inline Telegram onboarding card is still too terse for first-time bot setup.
  - Current behavior: the card tells the user to verify the token and first task, but it no longer walks through the BotFather setup steps as explicitly as the older Channels version did.
  - Why it matters: the runtime flow is better now, but first-time consumer users still need more hand-holding in this one spot.

- Deeper local-gateway pairing repair fix: keep as a separate follow-up PR.
  - Current finding: one separate lane identified a same-Mac pairing repair bug where a `node` -> `ui/operator` upgrade could poison browser readiness with `pairing required` noise.
  - Why it matters: the onboarding-side fix is the safe unblocker now, but the gateway-side auto-heal is still worth preserving and reviewing separately.

- Add a thin CLI packaged-app smoke wrapper for consumer onboarding and Telegram runtime ownership.
  - Proposed path:
    1. package the isolated app
    2. verify the bundle identity and runtime root
    3. ensure the live Telegram runtime belongs to this worktree
    4. open the packaged app
    5. assert the exact bundle has a visible window
    6. run the existing Telegram first-reply smoke
    7. re-check window visibility after the Telegram roundtrip
  - Why it matters: the repo already has most of these pieces. A small wrapper would catch the class of "simple but embarrassing" runtime/window bugs before a human finds them in the GUI.

## Consumer app visibility debugging notes (2026-03-25)

- Split permissions work and app-visibility work into separate PRs.
  - Why it matters: the permissions/recovery fix was coherent and mergeable on its own, while the app-resurfacing lane was still flaky and needed deeper debugging.

- Real root cause for the "app disappeared" behavior:
  - `DockIconManager` was hiding the Dock icon whenever there were no visible windows.
  - In consumer first-run, that is too aggressive because the user can still be mid-setup or mid-permission recovery even when they accidentally close the window.
  - Why it matters: the app became effectively unreachable if the menu bar was crowded and the Dock icon vanished.

- Current visibility-branch fix:
  - keep the Dock icon visible while consumer onboarding is still pending
  - keep the Dock icon visible while Accessibility or Screen Recording are still unresolved
  - keep a short temporary Dock hold after surfacing Settings so the app does not vanish immediately if macOS steals focus into System Settings
  - Why it matters: this addresses the real first-run recoverability problem instead of stacking more reopen hacks on top.

- Important remaining bug:
  - a fresh isolated consumer app instance can still launch with zero visible windows until `Settings…` is triggered explicitly
  - Why it matters: this is separate from the Dock-hide bug. Do not confuse "the Dock icon stayed visible" with "the app actually surfaced a usable window."

- False leads that wasted time:
  - `open -b <bundle-id>` returning success does not mean a visible window exists
  - AppleScript `activate` calls can succeed while the app still has zero windows
  - manually forcing `Settings…` from the app menu can make the app look "fixed" even when the initial launch path is still broken
  - Why it matters: always verify actual windows, not just process state or activation success

- Short verification path for future agents:
  1. Run `swift test --package-path apps/macos --filter ConsumerAppActivationTests`
  2. Run `swift test --package-path apps/macos --filter SettingsViewSmokeTests`
  3. Package a unique isolated instance:
     `bash scripts/package-consumer-mac-app.sh --instance <unique-id>`
  4. Open that exact instance:
     `bash scripts/open-consumer-mac-app.sh --instance <unique-id> --replace`
  5. Prove whether a window exists:
     `osascript -e 'tell application "System Events" to tell (first process whose bundle identifier is "<bundle-id>") to count windows'`
  6. If needed, force the app menu path explicitly:
     click `Settings…` on the app menu, then re-check window count/titles
  7. Only after that should you judge close/reopen behavior

- Temporary local verification unblock:
  - if `apps/macos/Sources/OpenClaw/AgentWorkspace.swift` is failing the build because of duplicate `memoryFilename` / `defaultMemoryTemplate()` definitions, remove those duplicates locally to unblock verification, then revert that file before preparing the app-visibility PR
  - Why it matters: that compile break is unrelated to the visibility lane and should not get mixed into the PR

## Immediate follow-ups

- Fix the stale `General` health pane after the consumer gateway recovers.
  - Current bug: the General tab can still show `Cannot reach gateway at localhost:19001` even while the consumer gateway is healthy and listening.
  - Why it matters: it makes the app look broken even after setup actually succeeded.

- Make `Retry now` trigger local consumer gateway recovery before rerunning health.
  - Current bug: the button can just reprobe a dead listener and keep the stale failure visible.
  - Why it matters: a normal user expects Retry to heal, not to merely confirm the app is still broken.

- Stop the Telegram consumer pane from showing `Checking...` after setup is already saved locally.
  - Current bug: the Telegram BYOK flow can be persisted correctly while the channel list still looks unconfigured if the latest status snapshot is late or missing.
  - Why it matters: this makes a working setup look fake-broken.

## Copy and layout polish

- Add an explicit loading indicator while `Verify token` is in progress.
  - Why it matters: verification currently looks frozen because the buttons gray out but there is no obvious in-progress animation.

- Reduce `Verify token` latency and investigate any long-running verify hang.
  - Current behavior: verification can sit for around a minute or more, which feels broken.
  - Why it matters: token verification should feel near-instant in the normal case.

- Move the threaded-mode recommendation above the power-user groups/topics note.
  - Why it matters: it is a near-default recommendation, not an afterthought.

- Make the threaded-mode recommendation visually stronger than muted gray helper text.
  - Why it matters: it is optional, but important for user experience.

- Tighten or relocate the `Token verified for @...` status text.
  - Why it matters: step 5 already explains what to do next, so the current status line is partly redundant.

- Review whether `Verify token` should auto-open the bot.
  - Why it matters: the current consumer flow is easier to follow when `Open your bot` stays an explicit step-5 action.

- Review the Telegram setup copy once the runtime flow is stable.
  - Why it matters: copy polish is only worth doing after the underlying setup behavior stops lying.

## Consumer app shell follow-ups

- Make clicking the `OpenClaw Consumer` app icon open the settings window directly.
  - Current behavior: the app can activate in the menu bar without surfacing the settings window.
  - Why it matters: this feels broken to normal users.

- Verify whether the live Telegram card should also show a "test reply" affordance or other post-setup action.
  - Why it matters: the user still needs to validate that the agent actually replies, not just that the token/poller is healthy.
  - Current reality: the first real reply is now proven through the Telegram
    userbot harness, but the app still does not give the user a dead-simple
    way to trigger or confirm that behavior after setup.

- After `Capture first message`, automatically trigger the first real bot reply instead of waiting for the user to send a second message.
  - Proposed behavior: once the first inbound Telegram DM is captured, use that message to kick off the first bootstrap/identity response.
  - Why it matters: the user has already done the hard part. Making them send another message is wasted friction.
  - Important behavior detail: this should work for any first inbound DM, not
    only `/start` or `hi`.

- Make the bootstrap identity copy suggest a branded default name.
  - Proposed behavior: in the first-run ritual, the bot should offer something
    like `Jarvis` as the default name while still allowing the user to rename
    it.
  - Why it matters: consumer branding should feel distinct from generic
    `OpenClaw`, and the first conversation is where that identity lands.
  - Tighten the options:
    - prefer `Jarvis` as the clear default suggestion
    - do not dump a random list of multiple persona names unless the user asks
      for alternatives
  - Why it matters: too many default-name options make the identity feel
    unfocused instead of branded.

- Fix the first-run bootstrap ritual stopping after the rename step.
  - Current behavior:
    - user confirms their name
    - user renames the bot to `Jarvis`
    - the bot writes `IDENTITY.md` and `USER.md`
    - then it stops with `Good. I'm Jarvis now.`
  - Expected behavior:
    - continue the ritual until all first-run identity questions are complete
    - for example: tone, emoji, communication style, or any other fields we
      actually expect to persist
  - Why it matters: the current flow feels broken and incomplete even though the
    underlying runtime is healthy.

- Make the first "what should I call you?" question deterministic when Telegram
  metadata exists.
  - Current bug: the same sender metadata can produce different first questions
    across runs.
  - Required behavior:
    - if Telegram metadata has a plausible name, explicitly offer stable options
      such as first name, short nickname when obvious, full name, and
      `something else`
    - only fall back to the generic question when usable metadata is missing
  - Why it matters: consumer onboarding should feel intentional, not random.

- Simplify the Telegram slash-command surface for consumers.
  - Proposed behavior: show only the few consumer-relevant commands by default
    and gate the rest behind `/help`, `/commands`, or a similar advanced path.
  - Why it matters: a giant command list makes the product feel like a dev tool
    instead of a consumer app.

- Seed an empty `MEMORY.md` during consumer bootstrap.
  - Current behavior: consumer bootstrap seeds `AGENTS.md`, `BOOTSTRAP.md`,
    `IDENTITY.md`, `USER.md`, and related files, but not `MEMORY.md`.
  - Expected behavior:
    - create `MEMORY.md` even when empty
    - make it available from the first run as the durable-notes file for stable
      user preferences and long-term facts
  - Why it matters: the agent already knows how to use `MEMORY.md` if it
    exists, so not seeding it makes the bootstrap surface look incomplete.

- Remove Git-repo leakage from the consumer bootstrap conversation.
  - Current behavior: the bot can say things like `this workspace isn't a Git
repo, so there was nothing to commit`.
  - Expected behavior:
    - the consumer lane should either auto-initialize any required repo state
      before the first run
    - or suppress commit/repo language entirely in the normal consumer flow
  - Why it matters: normal users should never have to know or care what a Git
    repo is during setup.

- Remove internal prompt/context leakage from the consumer conversation surface.
  - Current behavior: system/debug payloads such as bootstrap suggestion blocks,
    system metadata, or internal context can appear inline in the user-visible
    chat surface.
  - Expected behavior:
    - user-visible Telegram replies should contain only the actual assistant
      message
    - internal prompt scaffolding, system metadata, and bootstrap helper blocks
      must stay hidden
  - Why it matters: this is a hard product break. It makes the bot feel broken
    and exposes implementation detail to end users.

- Audit consumer bundled-skill coverage against the actual useful starter set.
  - Current behavior: consumer seeds a small bundled-skill allowlist, but we
    have not yet validated that it includes the skills actually needed for the
    first MVP users.
  - Expected behavior:
    - compare the shipped allowlist against the real consumer/founder-used skill
      set
    - keep the current bundled baseline explicit:
      `consumer-setup`, `apple-notes`, `apple-reminders`, `gog`,
      `goplaces`, `himalaya`, `peekaboo`, `summarize`, `weather`
    - keep `himalaya` in the starter pack because consumer email triage/drafting
      is too core to leave out of the default surface
    - keep `gog` in the starter pack because Gmail/Calendar/Drive/Docs maps
      directly to consumer operator tasks like email draft replies and calendar
      draft creation
  - Why it matters: setup can look correct while the product still feels weak
    if key skills are absent.

- Simplify the consumer menubar app so it reads like a product, not a dev tool.
  - Current behavior: the menubar app still exposes too much developer-facing
    state and workflow.
  - Expected behavior:
    - reduce it to the few controls/statuses a normal user actually needs
    - move advanced/debug surfaces out of the default consumer path
    - for MVP, keep Telegram as the visible chat surface and hide the local
      menubar chat entrypoints so one transcript does not have two different
      delivery models
  - Why it matters: the menubar app is part of first-run trust. If it looks
    like an internal tool, the product feels unfinished.

- Run a dedicated GUI-control stability pass for the consumer macOS app.
  - Current need: validate whether core controls, tab switches, retry flows,
    and post-setup actions stay stable under real usage instead of drifting
    into stale or inconsistent states.
  - Why it matters: even if the runtime is healthy, the product still feels
    broken if the GUI control layer is flaky.

- Stop leaking internal bootstrap/debug blocks into the consumer chat surface.
  - Current behavior: internal context blocks such as `Bootstrap name
suggestions...` and system metadata can appear in the visible chat stream.
  - Expected behavior:
    - keep internal bootstrap context in hidden prompt state only
    - never render internal JSON, system metadata, or prompt scaffolding to the
      end user
  - Why it matters: this makes the product look broken and immediately exposes
    implementation internals to normal users.

- Expand the consumer bundled-skill set to include the useful default skills we
  actually expect early testers to need.
  - Current baseline now includes:
    `consumer-setup`, `apple-notes`, `apple-reminders`, `gog`, `goplaces`,
    `himalaya`, `peekaboo`, `summarize`, `weather`
  - Expected behavior:
    - treat `himalaya` as the default provider-agnostic email lane
    - treat `gog` as the default Google Workspace lane for Gmail/Calendar/Drive
      work
    - keep the list curated rather than dumping every skill into consumer
  - Why it matters: onboarding feels incomplete if the bot is live but missing
    obvious built-in capabilities.

- Make the consumer menubar app materially less developer-facing.
  - Current behavior: the menu/settings surfaces still expose diagnostics,
    runtime jargon, and controls that read like an internal tool.
  - Expected behavior:
    - trim or hide developer-oriented controls in the normal consumer lane
    - keep only product-relevant actions visible by default
  - Why it matters: the consumer shell should feel like a product, not a debug
    console with branding on top.

- Keep the consumer LaunchAgent pinned to the current worktree.
  - Current failure mode: `~/Library/LaunchAgents/ai.openclaw.consumer.gateway.plist`
    can drift to another worktree's `dist/index.js`.
  - Why it matters: launchd can revive the wrong gateway and make the app look
    randomly inconsistent even when the current bundle is correct.
  - Current status: fixed in this branch, but keep it on the follow-up list
    until it survives the next clean E2E pass.

- Clean up the leftover old `Permissions` internals that still leak into the simplified consumer shell.
  - Why it matters: the shell should not look partially simplified.

- Fix Accessibility granted-state detection in the consumer macOS app.
  - Current behavior: Accessibility can be enabled in System Settings, but the app does not reliably reflect the granted state.
  - Why it matters: this was the main known leftover bug from the consumer-shell pass.

## Notes

- Do not reopen a broad UI redesign while Telegram setup persistence is still being fixed.
- The hard blocker remains: one clean consumer Telegram BYOK flow that persists allowlist state on the isolated consumer runtime.
- The next real product check is a fresh-user walkthrough that verifies:
  - the seeded workspace/bootstrap files are correct,
  - the app ships the consumer defaults it claims to ship,
  - the bot actually replies on the first real Telegram turn.
