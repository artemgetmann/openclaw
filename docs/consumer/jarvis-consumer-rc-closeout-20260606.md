# Jarvis Consumer RC Closeout - 2026-06-06

## Goal

Finish Jarvis Consumer RC validation in strict gates without mixing failure layers.

## Current State

- Worktree: `/Users/user/Programming_Projects/openclaw/.worktrees/jarvis-final-release-20260601`
- Branch: `codex/jarvis-final-release-20260601`
- PR: `#840`
- Current local head when this recovery plan was added: `ca7f68e1c86aa36a619924d1f3eef6736cb10355`
- Installed RC app: `/Applications/Jarvis Consumer.app`
- Installed app embedded commit: `16dff99c10`
- Bundle id: `ai.openclaw.consumer.mac.consumer-rc`
- RC instance: `jarvis-consumer-rc`
- RC gateway label: `ai.openclaw.consumer.jarvis-consumer-rc.gateway`
- RC gateway port: `31417`
- Shared gateway `ai.openclaw.gateway` must not be touched.
- Existing unrelated dirty files remain. Do not commit or revert them unless separately assigned.

## Gates

1. Telegram onboarding UX proof.
2. Clean macOS-user permission proof.
3. PR `#840` CI and merge readiness.
4. Final notarized release.
5. Sparkle `N` to `N+1` update proof.

## Release Truth Refresh - 2026-06-09

- Same-user RC onboarding is accepted. Telegram copy now says
  `Return to the Jarvis app.`, the app copy restored `Wake up, my friend`, and
  the first reply path is good enough for this lane.
- Telegram UX issues from the same-user run are no longer release blockers. Do
  not reopen them unless the clean-user Gate2 run proves a regression.
- Sparkle implementation and release assets are merged on `main`, but update
  proof is still pending.
- Clean-user Gate2 proof is the next real blocker.
- Final release still needs a notarized DMG/ZIP plus Gatekeeper proof from the
  synced final head.

## Same-User RC Manual Run - 2026-06-09

Purpose: catch product/onboarding bugs on the normal macOS user before spending
time on the real clean-user proof.

Current app under test:

- App: `/Applications/Jarvis Consumer.app`
- Bundle id: `ai.openclaw.consumer.mac.consumer-rc`
- Instance id: `jarvis-consumer-rc`
- Gateway label: `ai.openclaw.consumer.jarvis-consumer-rc.gateway`
- Gateway port: `31417`
- Embedded commit observed during package verification: `a945dde0dc`

Setup proof:

- [x] Reset only the RC lane before launch: quit `Jarvis Consumer`, boot out only
      the RC gateway, delete only `jarvis-consumer-rc` runtime state, and delete
      only `ai.openclaw.consumer.mac.consumer-rc` prefs.
- [x] Rebuilt and installed `/Applications/Jarvis Consumer.app` with
      `bash scripts/package-jarvis-consumer-rc.sh --fast`.
- [x] Verifier passed for both `dist/Jarvis Consumer.app` and
      `/Applications/Jarvis Consumer.app`.
- [x] Confirmed app process and isolated gateway process were running.
- [x] Confirmed visible first-run window title: `Welcome to Jarvis`.
- [x] Confirmed `/Applications/Jarvis.app` and shared `ai.openclaw.gateway` were
      not replaced by this RC package flow.

Live issues found during the run:

- [x] ChatGPT auth fallback: `Trouble signing in?` must appear after roughly
      8-10 seconds while ChatGPT sign-in is pending, even when the default
      browser successfully opened. Reason: the user may be logged into ChatGPT
      in a different browser and needs copy/open-link recovery without waiting
      for the default browser path to fail.
- [x] Telegram copy: bot-side approval message must not repeat app-side button
      instructions. It should end with exactly `Return to the Jarvis app.` The
      app already owns the `Verify Telegram` button.
- [x] Telegram verification: after `/start`, the bot replied with the approval
      message and RC config persisted `dmPolicy=allowlist` plus
      `allowFrom=["1336356696"]`, but the app stayed on `Approving Telegram
chat...` for more than a minute and the first-task marker remained
      missing. The verifier must complete once pending pairing/allowFrom proves
      the private chat is approved; it must not require another DM or leave the
      user in a spinner.
- [x] Telegram instruction copy: onboarding must preserve the original first-task
      phrase: `Tap Start in Telegram, send "Wake up, my friend", then click
Verify Telegram.`
- [x] Telegram first-message replay: after `/start`, the user's first real DM can
      arrive while the bot is still in pairing mode and before `allowFrom` is
      saved. `Verify Telegram` must approve the sender and replay that captured
      first real DM so the bot replies without requiring a second message.
- [x] Partial-approval preflight: launch preflight no longer suppresses
      onboarding only because Telegram `allowFrom` exists; it now requires the
      first-task marker to match the configured bot id.

Fix proof:

- [x] `swift test --package-path apps/macos --filter TelegramSetupBootstrapTests`
      passed 36 tests after the bot-copy, original first-task copy, and pending
      first-DM replay fixes.
- [x] `swift test --package-path apps/macos --filter ConsumerSetupResumeTests`
      passed 9 tests.
- [x] `swift test --package-path apps/macos --filter ConsumerSetupReadinessTests`
      passed 39 tests.
- [x] `pnpm exec vitest run src/pairing/pairing-messages.test.ts` passed 8
      tests after the bot-side copy fix.
- [x] `pnpm exec vitest run src/pairing/pairing-messages.test.ts
src/commands/models/consumer-auth.test.ts` passed 15 tests in the earlier
      ChatGPT fallback/copy batch.
- [x] Rebuilt and installed `/Applications/Jarvis Consumer.app`; verifier passed
      for `dist/Jarvis Consumer.app` and `/Applications/Jarvis Consumer.app`.
- [x] Same-user recovery proof: with Telegram config already containing
      `allowFrom=["1336356696"]` and the first-task marker missing, clicking
      `Verify Telegram` set
      `OpenClawConsumerTelegramFirstTaskVerified.jarvis-consumer-rc=8818357939`,
      showed `Telegram verified`, enabled `Next`, and onboarding finished.
- [x] Installed binary proof: `/Applications/Jarvis Consumer.app` from build
      timestamp `2026-06-09T06:11:00Z` contains the original `Wake up, my
friend` instruction and the runtime JS was rebuilt with bot copy
      `Return to the Jarvis app.`

Iteration rule:

- Do not spend a 30-40 minute RC package cycle to validate small copy/UI logic
  changes unless the packaged artifact itself is the thing under test. First use
  the fastest lane that exercises the changed layer:
  - Swift app/UI-only changes: targeted Swift tests plus
    `bash scripts/rebuild-relaunch-consumer-mac-app.sh --instance jarvis-consumer-rc`
    or `bash scripts/package-jarvis-consumer-rc.sh --fast --reuse-runtime` when
    the bundled runtime is unchanged.
  - Runtime TypeScript changes: targeted `pnpm exec vitest ...` plus one direct
    runtime/local gateway proof where possible; pay a full `SKIP_TSC=0`
    package only after batching runtime changes.
  - Final artifact proof: full RC package/notarized DMG only after the same-user
    walkthrough stops producing product bugs.
- If a package run is unavoidable, state why before starting it. The expected
  reasons are: runtime JS changed and must be embedded, signing/notarization is
  under test, TCC/LaunchAgent identity is under test, or clean-user Gate2 proof
  is starting.

Manual run rule:

- Keep moving through onboarding and append issues here. Fix the batch after the
  walkthrough unless a blocker prevents reaching the next step.
- 2026-06-09 same-user verdict: accepted for RC. The bot-side copy is now
  correct (`Return to the Jarvis app.`), the app instruction is back to `Wake
up, my friend`, and Telegram replies after verification. Minor first-message
  timing friction is not worth another package rebuild. Do not reopen Telegram
  onboarding polish unless clean-user proof exposes a blocker.

## Recovery Checklist - 2026-06-07

This checklist supersedes the Gate 2 notes below until a new isolated Gate2 run proves otherwise.

Historical note: the open bullets below capture the 2026-06-07 pre-fix state.
Use `Release Truth Refresh - 2026-06-09` and `Same-User RC Manual Run - 2026-06-09`
as the current release truth.

Status:

- [x] Preserve the failed clean-user-ish finding as evidence, not proof.
- [x] Mark the latest `jarvistest` run invalid because port `31417` was owned by the normal `user` gateway. That means `jarvistest` likely talked to stale current-user runtime state.
- [ ] Keep PR `#840` draft until product fixes, real Gate2 proof, and current-head CI are green.
- [ ] Do not count the contaminated `31417` run as Gate 2.
- [ ] Do not reuse the `jarvis-consumer-rc` identity for the next clean-user proof.
- [ ] Do not touch `/Applications/Jarvis.app` or the shared `ai.openclaw.gateway`.
- [ ] Do not commit unrelated packaging cleanup files unless a separate packaging cleanup slice is explicitly opened.

Current blockers to fix before another clean-user test:

- [ ] Telegram state: root-cause and fix the case where the UI shows `Telegram verified` but `Next` stays disabled.
- [ ] Telegram tests: add focused Swift coverage that verified Telegram state allows advancing.
- [ ] Telegram copy: bot approval copy must end with `Return to Jarvis.`
- [ ] Telegram copy: remove duplicate bot-side instruction to click `Verify Telegram`.
- [ ] ChatGPT auth fallback: keep default-browser launch, but show `Trouble signing in?` after roughly 8-10 seconds while auth is pending.
- [ ] ChatGPT auth fallback: expanded fallback should offer copy sign-in link and browser recovery.
- [ ] Permissions: treat Location as optional and do not block `Next` on it.
- [ ] Permissions: do not change Accessibility or Screen Recording gating until the real Gate2 harness proves their behavior.

Gate2 harness requirements:

- [ ] Package a distinct app identity for the next clean-user proof:
  - Display name: `Jarvis Consumer Gate2`
  - Bundle id: `ai.openclaw.consumer.mac.gate2`
  - Instance id: `jarvis-consumer-gate2`
  - Expected gateway port: `25229`
  - Expected launchd label: `ai.openclaw.consumer.jarvis-consumer-gate2.gateway`
- [ ] Stage the app under the `jarvistest` Desktop, not `/Applications`.
- [ ] Prove no process owns port `25229` before launch.
- [ ] Add or run a `/Users/Shared` log collector that captures:
  - `jarvistest` runtime identity
  - LaunchAgent state
  - port owner
  - redacted config
  - relevant logs
- [ ] After launch as `jarvistest`, prove port `25229` is owned by `jarvistest`.
- [ ] Prove state lives under `/Users/jarvistest/Library/Application Support/OpenClaw/instances/jarvis-consumer-gate2`.
- [ ] Prove `/Applications/Jarvis.app` and shared `ai.openclaw.gateway` were untouched.

Work lanes:

- Coordinator lane:
  - Own Gate2 harness, packaging identity, runtime ownership proof, and final clean-user validation.
  - Do not delegate LaunchAgent, gateway restart, `/Applications/Jarvis.app`, or live runtime ownership work.
- PR conflict/CI lane:
  - Use a separate worktree from `origin/codex/jarvis-final-release-20260601`.
  - Resolve the current or last-known merge conflict in `src/browser/server-context.existing-session.test.ts`.
  - Push with `git push origin HEAD:codex/jarvis-final-release-20260601`.
  - Watch CI, but do not mark ready, enable automerge, or merge while Gate2 is incomplete.
- Telegram blocker lane:
  - Use a separate worktree and focused Swift/code tests.
  - Fix only Telegram verify/advance/copy behavior.
- ChatGPT fallback lane:
  - Use a separate worktree or combine with the UI lane only if there is no overlap.
  - Implement delayed fallback and test on the normal user. No clean-user proof is needed for this slice.

Required local validation before final Gate2:

```bash
swift test --package-path apps/macos --filter TelegramSetupBootstrapTests
```

Add and run focused tests for:

- onboarding readiness after Telegram verification
- pairing message copy
- ChatGPT fallback timing, if this is testable in Swift

Final clean-user retest criteria:

- Build Gate2 app with `APP_INSTANCE_ID=jarvis-consumer-gate2`.
- Verify `Info.plist` bundle id, instance id, and embedded commit.
- Prove port `25229` is free before launch.
- Validate first-run bootstrap, Gatekeeper behavior, Accessibility, Screen Recording, optional Location, Telegram completion, and no disabled-`Next` dead end.
- Treat required CI truth as `CI / pr-required` plus `Workflow Sanity / actionlint`; queued `Labeler` or `Install Smoke` jobs are not readiness proof.

## Gate 1 - Telegram Onboarding UX

Status: passed on rebuilt RC. Copy, managed-bot creation, first-click `Verify Telegram`, `Next` enablement, final config, runtime health, and first-task marker are proven.

Scope:

- Patch Telegram onboarding copy only.
- Required copy: `Tap Start in Telegram, send "Wake up, my friend", then click Verify Telegram.`
- Keep button label `Verify Telegram`.
- Do not refactor onboarding or runtime ownership.

Proof commands:

```bash
swift test --package-path apps/macos --filter TelegramSetupBootstrapTests
```

Result: passed on 2026-06-06 after the copy patch with 31 `TelegramSetupBootstrapTests` tests passing.

Result after the auto-restart patch: passed on 2026-06-06 with 32 `TelegramSetupBootstrapTests` tests passing. Added proof that enabled Telegram bootstrap restarts the managed gateway before reconnect/probe.

Result after the pending-pairing route patch: passed on 2026-06-06 with 33 `TelegramSetupBootstrapTests` tests passing. Added proof that `Verify Telegram` prefers pending pairing before generic live-activity wait.

```bash
SKIP_TSC=0 SKIP_UI_BUILD=1 SKIP_PNPM_INSTALL=1 BUILD_CONFIG=release \
  bash scripts/package-jarvis-consumer-rc.sh --fast
```

Result: passed on 2026-06-06 after the pending-pairing fix. Latest installed fast RC has build timestamp `2026-06-06T12:25:47Z`. Installed `/Applications/Jarvis Consumer.app`; verifier reported bundle id `ai.openclaw.consumer.mac.consumer-rc`, instance `jarvis-consumer-rc`, isolated gateway label `ai.openclaw.consumer.jarvis-consumer-rc.gateway`, port `31417`, and shared gateway untouched. Gatekeeper rejection was expected for the fast unnotarized Developer ID build.

Note: the preflight cleanup script warned with `syntax error near unexpected token ']]'`, but the package wrapper continued and completed. Treat that cleanup warning separately unless it starts blocking packaging.

```bash
/usr/libexec/PlistBuddy -c 'Print :OpenClawGitCommit' \
  '/Applications/Jarvis Consumer.app/Contents/Info.plist'
```

Result: `16dff99c10`.

Installed binary copy proof:

```bash
strings '/Applications/Jarvis Consumer.app/Contents/MacOS/OpenClaw' | rg 'Wake up, my friend|Tap Start in Telegram|Verify Telegram'
```

Result: installed binary contains `Tap Start in Telegram, send "Wake up, my friend", then click Verify Telegram.`

Live UI proof:

- Fresh RC onboarding was reset to the Telegram step only.
- Human created and approved managed bot `@jarvis_37b97f44_bot`.
- Jarvis UI displayed the corrected copy: `Tap Start in Telegram, send "Wake up, my friend", then click Verify Telegram.`
- Human sent Telegram DMs and the bot replied.
- First `Verify Telegram` showed the runtime had saved config but could not confirm reply activity.
- Terminal proof at that moment showed the persisted config was correct, but live `channels status --probe --json` still had `channelOrder: []`.
- Agent restarted only the isolated RC gateway with `launchctl kickstart -k gui/$(id -u)/ai.openclaw.consumer.jarvis-consumer-rc.gateway`.
- Without another Telegram message, `Verify Telegram` passed, Jarvis showed `Telegram verified`, and `Next` enabled.

Root cause and fix:

- Root cause: after onboarding saved enabled Telegram/plugin config, the app reconnected to the old gateway process. The running gateway stayed healthy but had loaded zero channels, so first-task proof could not observe Telegram reply activity until restart.
- Fix: `applyTelegramSetupBootstrap(... enabled: true)` now restarts the managed consumer gateway before reconnect/probe. The restart is scoped to the consumer RC LaunchAgent and does not touch shared `ai.openclaw.gateway`.
- Second root cause: `Verify Telegram` checked `consumerTelegramLooksLive()` before pending pairing. A pairing-mode Telegram provider is healthy, but the first DM is stored in `telegram-pairing.json`, not normal inbound/outbound activity. The app entered the generic live-activity wait and spun.
- Second fix: `Verify Telegram` now routes pending pairing before live-activity wait, then saves `dmPolicy=allowlist` and the captured sender id.

Runtime proof:

```bash
STATE="$HOME/Library/Application Support/OpenClaw/instances/jarvis-consumer-rc/.openclaw"

OPENCLAW_HOME="$HOME/Library/Application Support/OpenClaw/instances/jarvis-consumer-rc" \
OPENCLAW_STATE_DIR="$STATE" \
OPENCLAW_CONFIG_PATH="$STATE/openclaw.json" \
OPENCLAW_GATEWAY_PORT=31417 \
OPENCLAW_LAUNCHD_LABEL=ai.openclaw.consumer.jarvis-consumer-rc.gateway \
"$STATE/bin/openclaw" gateway status --deep --require-rpc

OPENCLAW_HOME="$HOME/Library/Application Support/OpenClaw/instances/jarvis-consumer-rc" \
OPENCLAW_STATE_DIR="$STATE" \
OPENCLAW_CONFIG_PATH="$STATE/openclaw.json" \
OPENCLAW_GATEWAY_PORT=31417 \
OPENCLAW_LAUNCHD_LABEL=ai.openclaw.consumer.jarvis-consumer-rc.gateway \
"$STATE/bin/openclaw" channels status --probe --json
```

Result: RPC probe OK on `31417`; runtime identity branch `codex/jarvis-final-release-20260601`, worktree `/Users/user/Programming_Projects/openclaw/.worktrees/jarvis-final-release-20260601`; Telegram configured, running, polling, connected, probe OK; latest bot username `jarvis_43bc79fc_bot`; latest bot id `8721062486`; webhook URL empty.

Final config proof:

```bash
jq '{telegram: .channels.telegram | {enabled, dmPolicy, allowFrom, defaultAccount}}' \
  "$HOME/Library/Application Support/OpenClaw/instances/jarvis-consumer-rc/.openclaw/openclaw.json"
```

Result: `enabled=true`, `dmPolicy=allowlist`, `allowFrom=["1336356696"]`, `defaultAccount=default`.

First-task marker proof:

```bash
defaults read ai.openclaw.consumer.mac.consumer-rc OpenClawConsumerTelegramFirstTaskVerified.jarvis-consumer-rc
```

Result after latest proof: `8721062486`.

Onboarding completion proof:

```bash
defaults read ai.openclaw.consumer.mac.consumer-rc \
  openclaw.consumer.instances.jarvis-consumer-rc.onboardingSeen
defaults read ai.openclaw.consumer.mac.consumer-rc \
  openclaw.consumer.instances.jarvis-consumer-rc.onboardingVersion
```

Result: `1` and `7`.

Pass condition:

- Copy is honest and visible.
- After the human sends `Wake up, my friend`, `Verify Telegram` enables and passes.
- `Next` enables.
- Onboarding advances past Telegram.
- No extra-message confusion after the correct message.

Blocker: none for Gate 1. Note: this proves onboarding approval and no-stranding. It does not claim the fast RC is a final notarized release artifact.

Next gate: clean macOS-user permission proof.

## Guardrails

## Gate 2 - Clean macOS-User Permission Proof

Status: blocked on human/admin setup for a true clean macOS user session.

Preflight proof:

```bash
dscl . -list /Users
```

Result: only the normal `user` account is present; no existing clean test user found.

```bash
sudo -n true
```

Result: noninteractive sudo is blocked.

Relevant repo note:

- `docs/consumer/fresh-user-mac-app-smoke.md` and `scripts/smoke-consumer-fresh-user-mac-app.sh` can prove fake-home bootstrap, isolated runtime, gateway startup, and onboarding visibility.
- They explicitly do not prove true separate macOS account login or TCC permissions.

Required next action:

- Human/admin must create or provide access to a clean macOS user session.
- Run `/Applications/Jarvis Consumer.app` from that clean user.
- Validate Accessibility, Screen Recording, Location, relaunch/reopen after permission changes, and that onboarding does not strand the user.

Do not count current-user Settings, current-user TCC state, or fake-home smoke as this gate.

- Do not touch `/Applications/Jarvis.app`.
- Do not boot out or replace shared `ai.openclaw.gateway`.
- Do not use coordinate automation in Telegram.
- Do not create repeated managed bots if Telegram or BotFather friction appears.
- Do not commit unrelated dirty files.
- Do not continue to permissions before Telegram onboarding proof passes.
- Do not use current-user Settings permissions as clean-user proof.
- Do not wait on CI before Telegram and clean-user gates are done.
- Do not start notarized release or Sparkle proof before all prior gates pass.
- Do not claim final release readiness from a fast RC build.
