# Jarvis Consumer RC Closeout - 2026-06-06

## Goal

Finish Jarvis Consumer RC validation in strict gates without mixing failure layers.

## Current State

- Worktree: `/Users/user/Programming_Projects/openclaw/.worktrees/jarvis-final-release-20260601`
- Branch: `codex/jarvis-final-release-20260601`
- PR: `#840`
- Current pushed head: `16dff99c10b752867d68f48b6ea89241595e7932`
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
