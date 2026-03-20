# OpenClaw Consumer Execution Tracker

Last updated: 2026-03-20
Owner: consumer execution team
Status: Active

## Source of truth

Use these documents in this order when there is any ambiguity:

1. `CONSUMER.md` (branch identity, north star, week-1 boundaries)
2. `docs/consumer/openclaw-consumer-execution-spec.md` (week-1 execution spec)
3. `docs/consumer/CODEX-PROMPT.md` (browser-spike task framing)
4. `docs/consumer/openclaw-consumer-brutal-execution-board.md` (30-day cadence)
5. `docs/consumer/openclaw-consumer-go-to-market-plan.md` (architecture and launch context)
6. `docs/consumer/macos-consumer-app.md` (consumer macOS app identity, UX, and distribution assumptions)

## Locked decisions

- Week 1 scope follows `CONSUMER.md` + execution spec (power mode, no safety-profile build in week 1).
- Browser path priority is CDP first:
  1. `browser profile=user` (existing-session / Chrome MCP)
  2. `browser profile=openclaw` (managed isolated browser)
  3. Claude-in-Chrome investigation/adaptation
  4. Browserbase (currently credential-blocked; run when creds arrive)
- Benchmark output path is `docs/consumer/browser-spike-results.md`.
- Benchmark protocol is 2 runs per approach/task, using median time.
- Consumer runtime root is `~/Library/Application Support/OpenClaw Consumer`.
- Consumer state/config live under the consumer runtime root, not `~/.openclaw`.
- Consumer gateway port is `19001`.
- No migration or reads from founder state in week 1.
- Telegram v1 is guided BYOK; managed/shared bot stays roadmap-only.

## Consumer Bootstrap Tracker

Use this mini-checklist for the runtime/bootstrap work in this branch:

- Runtime isolation: implemented and verified on the isolated consumer runtime
- Bootstrap automation: implemented and verified through packaged app/bootstrap artifact checks
- Telegram onboarding: implemented as guided BYOK seam, awaiting live bot validation
- Seeded templates/default config: implemented and verified in the consumer runtime/workspace
- Verification/E2E notes: in progress

Notes:

- Keep the normal consumer path local-first.
- Do not touch founder `~/.openclaw` while validating consumer setup.
- Write down any setup decisions here before moving on to PR prep.
- Launchd identities are split now: the app autostart job uses `ai.openclaw.consumer`, and the gateway job uses `ai.openclaw.consumer.gateway`.
- The consumer runtime root is app-owned Application Support, not the repo checkout.
- Full Xcode (not just Command Line Tools) is required on this Mac for real macOS app packaging and E2E.
- Packaged app runtime now prefers the current worktree `dist/index.js` and seeds `OPENCLAW_FORK_ROOT`, so child commands do not accidentally fall back to a founder wrapper or a stale hoisted package on `PATH`.
- `PortGuardian` now recognizes runtime-shaped gateway commands (`node .../dist/index.js gateway`) as expected local listeners, so the consumer app does not kill its own isolated gateway during startup.
- `GatewayProcessManager` now skips redundant launch-agent ensure work while startup is already in progress, which reduced a packaged-app cold-start self-restart race.
- The consumer gateway health path is verified; the remaining CLI quirk is that bare `gateway status` still assumes profile-derived launchd labels unless the explicit consumer gateway label is present in the env.
- Consumer app runtime now sets `OPENCLAW_CONSUMER_MINIMAL_STARTUP=1`, which keeps first boot non-blocking by skipping founder-oriented sidecars (session lock cleanup, browser-control sidecar, Gmail watcher, internal hook loading, plugin services, memory backend bootstrap) and by backgrounding channel startup.
- Draft PR is open for review:
  - `https://github.com/artemgetmann/openclaw/pull/72`
  - head: `codex/simplify-consumer-bootstrap-flow-telegram`
  - base: `codex/consumer-openclaw-project`
  - merge gate remains: Telegram BYOK E2E on isolated consumer runtime

### 2026-03-20 runtime debug note

- Added targeted diagnostics and hardening in this branch:
  - startup path no longer references undefined gateway startup wrapper symbols
  - consumer launchd service env now forwards `OPENCLAW_CONSUMER_MINIMAL_STARTUP=1`
  - consumer minimal mode skips Telegram startup bot-probe preflight
- Verification state:
  - `pnpm build` passed
  - `swift test --package-path apps/macos --filter SettingsViewSmokeTests` passed
  - `swift test --package-path apps/macos --filter OnboardingViewSmokeTests` passed
  - `pnpm test -- extensions/telegram/src/channel.test.ts` passed
  - `pnpm test -- src/daemon/service-env.test.ts` passed
  - `bash -n scripts/package-mac-app.sh` passed
- Active blocker for final E2E sign-off:
  - In this local environment, enabling Telegram on the consumer runtime can drive a high-CPU gateway hot loop and RPC timeouts.
  - Paused stack sampling points to `jiti` module resolution while Telegram startup is active.
  - Consumer runtime remains healthy when Telegram channel is disabled.
  - Next required validation is a fresh Telegram BYOK run with a dedicated bot token (no parallel poller) and captured diagnostics.

## Current baseline snapshot

- Branch: `codex/consumer-openclaw-project`
- `consumer...origin/main`: ahead 17, behind 27
- `codex/consumer-openclaw-project...origin/main`: ahead 22, behind 5
- `origin/main...upstream/main`: ahead 88, behind 220
- Phase A merge and runtime validation are complete.
- Phase B status now:
  - `profile=user` control lane passes (`start/status/tabs`) after remote debugging enablement.
  - `profile=openclaw` control lane passes (`start/status/tabs`) on isolated runtime.
  - Local `agent --local` prompt execution now exits cleanly in the isolated runtime after teardown fixes.
  - Remaining blocker is provider/auth health for full task-matrix execution:
    - `openai-codex:default` returns `API rate limit reached`.
    - `openai-codex:notblockedamazon` returns `API rate limit reached`.
    - lower-priority Codex OAuth profiles previously surfaced `refresh_token_reused`.
    - Anthropic fallback previously surfaced `overloaded`.
  - LaunchAgent route was tested and reverted: it binds `19001` but runs against `~/.openclaw` state instead of the consumer runtime root, so isolated auth/state checks fail.

## Execution phases and gates

### Worktree A: Consumer macOS app simplification and isolation

- [x] Consumer app uses a separate app/runtime identity
  - [x] Separate bundle/app identity documented
  - [x] Separate state dir + port defaults implemented
  - [x] Separate launch labels/log roots implemented
- [x] Consumer onboarding is local-first
  - [x] Remote setup hidden behind Advanced
  - [x] Consumer-facing copy avoids gateway jargon in the main flow
- [x] Consumer default surface is simplified
  - [x] Menu bar trimmed to status/chat/settings/pause/quit
  - [x] Default settings tabs reduced to General/Permissions/About
  - [x] Advanced toggle reveals hidden power-user surfaces
- [x] Docs updated for the consumer app
  - [x] Tracker kept current
  - [x] Consumer app doc explains isolation and direct-download assumptions
  - [x] Safe local testing instructions included

Gate to exit Worktree A:

- [x] Consumer app can coexist with founder app on the same Mac without sharing runtime state unintentionally
- [x] Consumer default UX is materially simpler while advanced controls remain accessible
- [x] Docs match the implemented consumer behavior

Worktree A validation notes (2026-03-19):

- `swift build -c debug --product OpenClaw --build-path .build --arch arm64 -Xlinker -rpath -Xlinker @executable_path/../Frameworks` passed after fixing a missing `return` in `OnboardingView+Pages.swift`.
- `swift test --package-path apps/macos --filter GatewayEnvironmentTests` passed.
- `swift test --package-path apps/macos --filter SettingsViewSmokeTests` passed.
- A consumer bundle was packaged manually at `dist/OpenClaw Consumer.app` with:
  - bundle identifier `ai.openclaw.consumer.mac.debug`
  - URL scheme `openclaw-consumer`
  - app variant `consumer`
- Same-Mac isolation smoke passed with the founder gateway still active on `18789`:
  - consumer app process launched from `dist/OpenClaw Consumer.app`
  - consumer defaults plist written to `~/Library/Preferences/ai.openclaw.consumer.mac.debug.plist`
  - consumer runtime socket created at `~/Library/Application Support/OpenClaw Consumer/.openclaw/exec-approvals.sock`
  - consumer app held no TCP listener and did not take over the founder gateway launch label
- Gateway auto-bootstrap on consumer port `19001` was not exercised in Worktree A; that remains Worktree B scope.

### Phase A: Branch convergence (blocking)

- [x] Merge `origin/main` into `consumer`
- [x] Resolve conflicts (runtime/browser behavior follows merged mainline)
- [x] Validate:
  - [x] `pnpm install`
  - [x] `pnpm build`
  - [x] `pnpm openclaw gateway --port 19001 --bind loopback` (after `gateway.mode=local` bootstrap)
- [x] Push updated `consumer`
- [x] Merge updated `origin/consumer` into this worktree branch

Gate to exit Phase A:

- [x] `consumer` no longer materially behind `origin/main` for runtime/browser work

Phase A validation notes (2026-03-16):

- Consumer profile configured: `gateway.mode=local`.
- Gateway probe on isolated runtime passed (`Gateway reachable`) on `19001`.
- `browser --browser-profile openclaw status` passed.
- `browser --browser-profile user status|tabs` failed with `Could not find DevToolsActivePort` (existing-session readiness not satisfied).

### Phase B: Browser spike (week 1, days 1-3)

- [ ] Finalize benchmark matrix in `docs/consumer/browser-spike-results.md`
- [ ] Run approach: `user` existing-session path
  - Control lane verified; task execution now blocked by model auth health, not browser attach.
- [ ] Run approach: `openclaw` managed profile path
  - Control lane verified; task execution now blocked by model auth health, not browser attach.
- [ ] Run approach: Claude-in-Chrome investigation/adaptation
- [ ] Mark Browserbase rows `credential-blocked` until credentials are available
- [ ] Re-run Browserbase rows once credentials are provided
- [ ] Select primary + fallback browser architecture

Gate to exit Phase B:

- [ ] Clear recommendation with evidence
- [ ] Reliability threshold met or explicit fix-loop declared

### Phase C: Consumer loop integration (week 1, days 4-5)

- [ ] Start isolated consumer runtime on port `19001`
- [ ] Confirm Telegram bot responds in isolated runtime
- [ ] Confirm Telegram -> agent -> browser -> Telegram roundtrip
- [ ] Confirm observability with `openclaw logs --follow`
- [ ] Document the consumer runtime root and setup flow in this tracker before PR

Gate to exit Phase C:

- [ ] End-to-end loop works without manual intervention
- [ ] Another engineer can read this tracker and reproduce the consumer setup without guesswork

### Phase D: Killer task hardening (week 1, days 6-7)

- [ ] Implement/test: "Find flights NYC to London in April"
- [ ] Run 3 consecutive attempts
- [ ] Ensure each run is < 3 minutes

Gate to exit Phase D:

- [ ] 3/3 consecutive successful autonomous runs

## Runbook commands

### Consumer runtime baseline

```bash
pnpm install && pnpm build
OPENCLAW_HOME=/tmp/openclaw-consumer \
OPENCLAW_PROFILE=consumer-test \
pnpm openclaw gateway run --port 19001 --bind loopback
```

### Health and probes

```bash
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test pnpm openclaw channels status --probe
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test pnpm openclaw logs --follow
```

### Browser verification (post-merge)

```bash
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test pnpm openclaw browser --browser-profile user status
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test pnpm openclaw browser --browser-profile user tabs
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test pnpm openclaw browser --browser-profile openclaw status
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test pnpm openclaw browser --browser-profile openclaw start
```

## Benchmark tracker template

| Approach                | Task 1 Flight | Task 2 Form | Task 3 Web Summary | Task 4 X Summary | Task 5 Multi-step | Status             | Notes                                                                                        |
| ----------------------- | ------------- | ----------- | ------------------ | ---------------- | ----------------- | ------------------ | -------------------------------------------------------------------------------------------- |
| user (existing-session) | blocked       | blocked     | blocked            | blocked          | blocked           | blocked            | control lane passes; local agent run works; current blocker is model rate limits/auth health |
| openclaw (managed)      | blocked       | blocked     | blocked            | blocked          | blocked           | blocked            | control lane passes; local agent run works; current blocker is model rate limits/auth health |
| Claude-in-Chrome        | TODO          | TODO        | TODO               | TODO             | TODO              | pending            | feasibility + adaptation                                                                     |
| Browserbase             | blocked       | blocked     | blocked            | blocked          | blocked           | credential-blocked | run after creds                                                                              |

## Scope guardrails (week 1)

In scope:

- Branch/runtime isolation
- Browser spike and recommendation
- Telegram end-to-end loop
- Flight killer task reliability

Out of scope:

- Safety profile implementation
- Irreversible confirmation gate implementation
- Billing/licensing
- Onboarding wizard polish
- WhatsApp and managed hosting expansion

## Daily log template

```md
### YYYY-MM-DD

- Done:
- Blocked:
- Evidence links:
- Next 3 actions:
```

## Daily log

### 2026-03-18

- Done:
  - Confirmed `profile=user` and `profile=openclaw` control lanes remain healthy.
  - Confirmed isolated `agent --local` turns now complete and exit cleanly after CLI teardown fixes.
  - Landed consumer runtime isolation helpers, first-run bootstrap defaults, and consumer onboarding copy updates.
  - Split the consumer app autostart launchd label from the gateway launchd label so the two jobs do not collide.
  - Added bundle packaging for the consumer workspace templates so shipped app builds can load the consumer bootstrap ritual directly.
  - Added a guided Telegram setup panel with token verification, BotFather launch, and first-DM allow-list capture.
  - Direct typecheck sanity passed for `ConsumerRuntime.swift`, `ConsumerBootstrap.swift`, `OpenClawPaths.swift`, `ConnectionModeResolver.swift`, `ProcessInfo+OpenClaw.swift`, `TelegramSetupVerifier.swift`, and the guided Telegram setup extension using local stubs.
  - Pinned `openai-codex` auth order per agent to test individual profiles directly.
- Blocked:
  - `openai-codex:default` returns `⚠️ API rate limit reached. Please try again later.`
  - `openai-codex:notblockedamazon` returns `⚠️ API rate limit reached. Please try again later.`
  - Historical isolated logs show lower-priority Codex profiles hitting `refresh_token_reused`.
  - Historical isolated logs show Anthropic fallback surfacing `overloaded`.
  - `swift test --filter ConsumerRuntimeTests` and `swift test --disable-experimental-prebuilts --filter ConsumerRuntimeTests` both fail on this machine because the installed Command Line Tools do not include the Xcode macro plugins required by `swiftui-math`.
- Evidence links:
  - `/tmp/openclaw-profile-default.out`
  - `/tmp/openclaw-profile-default.err`
  - `/tmp/openclaw-profile-nba.out`
  - `/tmp/openclaw-profile-nba.err`
  - `/tmp/openclaw-codex.err`
  - `/tmp/openclaw-agent-local.err`
  - `/tmp/consumer-bootstrap-check.swift`
- Next 3 actions:
  - Keep only the least-bad Codex profiles in isolated auth order so future runs skip known-bad refresh tokens.
  - Update `docs/consumer/browser-spike-results.md` so benchmark state reflects provider-auth blockage rather than browser failure.
  - Finish the app build on a machine with Xcode installed, then run the consumer runtime and onboarding E2E.

### 2026-03-19

- Done:
  - Installed full Xcode locally, accepted the license, and unblocked real macOS package/test execution.
  - Focused macOS verification passed:
    - `swift test --filter GatewayEnvironmentTests`
    - `swift test --filter ConsumerRuntimeTests`
    - `swift test --filter OnboardingViewSmokeTests`
    - `swift build -c debug --product OpenClaw`
  - Packaged the mac app successfully with `scripts/package-mac-app.sh`.
  - Verified the packaged app/bootstrap path creates the isolated consumer runtime under `~/Library/Application Support/OpenClaw Consumer/.openclaw`.
  - Verified isolated consumer artifacts exist and are separate from founder state:
    - consumer config at `~/Library/Application Support/OpenClaw Consumer/.openclaw/openclaw.json`
    - consumer workspace at `~/Library/Application Support/OpenClaw Consumer/.openclaw/workspace`
    - consumer logs at `~/Library/Application Support/OpenClaw Consumer/.openclaw/logs`
  - Verified the generated consumer config defaults:
    - `gateway.mode=local`
    - `gateway.bind=loopback`
    - `gateway.port=19001`
    - consumer workspace path under the consumer runtime root
    - curated bundled skill allowlist present
  - Found and fixed an extra launchd-label bug during E2E:
    - the consumer gateway daemon was being installed as `ai.openclaw.consumer`
    - the app now passes an explicit gateway launchd label override
    - the shared daemon install helper now preserves explicit `OPENCLAW_LAUNCHD_LABEL` overrides instead of silently re-deriving from profile
  - Added a focused regression test for the explicit launchd-label override path:
    - `pnpm test -- src/commands/daemon-install-helpers.test.ts`
  - Added consumer-minimal startup mode wiring:
    - mac app bootstrap exports `OPENCLAW_CONSUMER_MINIMAL_STARTUP=1`
    - gateway sidecars now honor that mode so consumer first-run startup is non-blocking and isolated from founder-oriented sidecars
    - channel startup is backgrounded in consumer-minimal mode so gateway liveness does not depend on Telegram connect timing
  - Found and fixed additional packaged-app runtime/bootstrap failures:
    - repo-root inference: packaged app commands now discover the real worktree root and export `OPENCLAW_FORK_ROOT`, avoiding `could not resolve an OpenClaw repo root` failures.
    - stale runtime resolution: command selection now prefers the current worktree `dist/index.js` over a hoisted `node_modules/openclaw` wrapper, which corrected the service version and preserved the custom consumer gateway label.
    - self-kill bug: `PortGuardian` now treats runtime gateway commands as expected listeners instead of terminating the consumer gateway on `19001`.
    - startup race: `GatewayProcessManager` now skips launch-agent ensure work while the gateway is already `.starting`.
  - Added focused regression coverage for the packaged-app fixes:
    - `swift test --filter CommandResolverTests`
    - `swift test --filter PortGuardianTests`
    - `swift test --filter GatewayProcessManagerTests`
    - `swift test --filter GatewayLaunchAgentManagerTests`
  - Verified the stabilized packaged-app consumer gateway with direct machine evidence:
    - `launchctl list` shows `ai.openclaw.consumer.gateway`
    - `launchctl print gui/$(id -u)/ai.openclaw.consumer.gateway` shows the correct plist, `dist/index.js`, `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, and `OPENCLAW_LAUNCHD_LABEL`
    - `lsof -nP -iTCP:19001 -sTCP:LISTEN` shows the consumer gateway listening on loopback
    - consumer `gateway.log` records runtime identity at `~/Library/Application Support/OpenClaw Consumer/.openclaw` with `serviceLabel=ai.openclaw.consumer.gateway`
  - Tightened the consumer bootstrap/runtime follow-through after the first E2E pass exposed stale state:
    - `ConsumerBootstrap` now fills in missing consumer defaults on existing installs instead of only seeding brand-new configs.
    - consumer bootstrap now writes `discovery.mdns.mode=off`, which removes unnecessary local Bonjour advertising from the consumer runtime.
    - `ConfigStore.save` now refreshes the resolved gateway endpoint and shared connection immediately after config writes, so the app does not keep reconnecting with a stale gateway token.
    - `GatewayConnectivityCoordinator` now treats auth changes as endpoint changes and refreshes the control channel when token/password state changes, not only when the URL changes.
  - Added focused regression coverage for the bootstrap/default refresh path:
    - `swift test --filter ConsumerBootstrapTests`
    - `swift test --filter ConfigStoreTests`
  - Verified the live consumer config is updated by the packaged app on launch:
    - `~/Library/Application Support/OpenClaw Consumer/.openclaw/openclaw.json` now includes `discovery.mdns.mode=off`
  - Verified the old failure signatures stopped reproducing after the consumer config/default refresh:
    - no fresh consumer `token_mismatch` reconnect storm after the new packaged app launch
    - no fresh consumer Bonjour/`ciao` conflict lines after `discovery.mdns.mode=off` landed in the live consumer config
- Blocked:
  - Live Telegram onboarding E2E is still not complete.
  - The remaining blocker is now narrower and more specific:
    - the isolated consumer gateway can bind `127.0.0.1:19001`, but it can still wedge before becoming RPC-healthy when launched from the current runtime path.
    - this reproduces both through the consumer LaunchAgent and a direct `node dist/index.js gateway run --bind loopback --port 19001 --force` launch with consumer env.
    - symptom: the process listens on `19001`, but `gateway status --deep --require-rpc` and `channels status --probe` time out or close before a healthy WS/RPC handshake completes.
    - current evidence suggests this is a runtime/startup wedge after bind, not the original stale-token or Bonjour-collision failure.
  - During Telegram validation, other local worktrees can still claim the same tester bot and create `getUpdates` conflicts.
    - `d3b8` was observed doing this during validation and had to be stopped.
    - founder `~/.openclaw` is still isolated from the consumer runtime, but tester-bot contention across worktrees remains an operational footgun for live E2E.
  - Bare CLI `gateway status` still narrates the profile-derived app label unless `OPENCLAW_LAUNCHD_LABEL=ai.openclaw.consumer.gateway` is supplied explicitly; runtime behavior is correct, but this diagnostic path still assumes profile -> label on macOS.
- Evidence links:
  - `~/Library/Application Support/OpenClaw Consumer/.openclaw/openclaw.json`
  - `~/Library/Application Support/OpenClaw Consumer/.openclaw/workspace/BOOTSTRAP.md`
  - `~/Library/Application Support/OpenClaw Consumer/.openclaw/logs/gateway.log`
  - `/tmp/openclaw/openclaw-2026-03-19.log`
  - `~/Library/LaunchAgents/ai.openclaw.consumer.gateway.plist`
- Next 3 actions:
  - Isolate and fix the post-bind consumer gateway wedge on `19001` so RPC health succeeds again.
  - Re-run the packaged mac app + guided Telegram BYOK path after that runtime fix.
  - Decide whether to fix the custom-label CLI status quirk before PR prep or leave it documented for this branch.

### 2026-03-19 verification addendum

- Resolved:
  - Consumer launchd cold-start is green after allowing for real first-start warm-up time.
  - Verified end-to-end daemon health with:
    - launchd label `ai.openclaw.consumer.gateway`
    - listener on `127.0.0.1:19001`
    - `node dist/index.js gateway status --deep --require-rpc`
    - runtime identity now logs `serviceLabel=ai.openclaw.consumer.gateway`
- Important nuance:
  - First cold start can spend extra time building missing Control UI assets.
  - Early probes can therefore fail even though the runtime is healthy a few seconds later.
  - This is a startup-latency issue, not a consumer runtime-isolation failure.
  - Direct terminal proof is strongest via `launchctl print`, `lsof`, and consumer `gateway.log`; `gateway status` is accurate only when the explicit consumer gateway launchd label is supplied in env.

### 2026-03-19 gateway-bisect addendum

- New finding:
  - The remaining consumer E2E blocker is a reproducible high-CPU gateway spin after startup, not a bootstrap/config collision.
  - It reproduces on the isolated consumer runtime even when the gateway is moved to an off-port debug lane (`19123`), so it is not caused by the app or another local client polling `19001`.
  - It also reproduces with no external client connections on the debug port (`lsof` showed only the listening sockets).
- Narrowed shape:
  - The process reaches `listening on ws://127.0.0.1:<port>`.
  - It can also finish the reduced `startGatewaySidecars()` path and log `[startup/sidecars] complete`.
  - It then pegs CPU and never reaches the outer `[startup] sidecars started` log in `src/gateway/server.impl.ts`.
  - `/healthz` and `/readyz` time out while the process stays alive at ~90%+ CPU.
- Reduction results:
  - Reproduced with the real isolated consumer config on `19001`.
  - Reproduced again on `19123` with all of these bypassed:
    - channels
    - cron
    - canvas host
    - browser control server
    - Gmail watcher
    - internal hook loading
    - plugin services
    - memory-backend startup
    - delivery recovery
    - Tailscale exposure
    - session-lock cleanup
  - This means the current startup spin is deeper than the original plugin/hook suspicion and is now isolated to code after the reduced sidecar function returns.
- Temporary debugging seams added to support the bisect:
  - `OPENCLAW_DEBUG_SKIP_TAILSCALE_EXPOSURE`
  - `OPENCLAW_DEBUG_SKIP_SESSION_LOCK_CLEANUP`
  - `OPENCLAW_DEBUG_SKIP_GMAIL_WATCHER_PHASE`
  - `OPENCLAW_DEBUG_SKIP_INTERNAL_HOOK_LOADING`
  - `OPENCLAW_DEBUG_SKIP_PLUGIN_SERVICES`
  - `OPENCLAW_DEBUG_SKIP_MEMORY_BACKEND_STARTUP`
- Evidence links:
  - `/tmp/openclaw-tailscale-hang.sample.txt`
  - `/tmp/openclaw-report-run.log`

### 2026-03-19 startup-order isolation fix

- Fixed:
  - `OpenClawApp` now bootstraps consumer runtime env before any shared singleton is touched.
  - This removed an early-init race where app singletons were resolving founder defaults (`~/.openclaw`, `18789`) before consumer env overrides were applied.
  - `GatewayConnectivityCoordinator.shared.start()` is now invoked after bootstrap, and singleton references in `OpenClawApp` are resolved lazily.
  - Added focused diagnostics for faster future triage:
    - `GatewayProcessManager` now logs startup snapshots (`context`, mode, port, launchd label, profile, config path, state dir, fork root) and appends port-guardian summaries on readiness timeouts.
    - `ControlChannel` now logs endpoint state context when endpoint refresh fails, so failures show `ready|connecting|unavailable` plus the resolved URL/detail.
- Verified:
  - Packaged app was rebuilt with `SKIP_TSC=1 SKIP_UI_BUILD=1 bash scripts/package-mac-app.sh`.
  - Fresh `dist/OpenClaw.app` launch no longer logs new connects to `ws://127.0.0.1:18789`; it targets `ws://127.0.0.1:19001`.
  - With `openclaw.onboardingSeen=true` and local mode set, consumer gateway comes up on `19001` while founder runtime remains on `18789`:
    - `lsof -nP -iTCP:19001 -sTCP:LISTEN` -> consumer gateway listener present
    - `lsof -nP -iTCP:18789 -sTCP:LISTEN` -> founder gateway listener still present
  - Logging patch compiles cleanly:
    - `swift build --package-path apps/macos -c debug --product OpenClaw`
- Notes:
  - This addresses runtime cross-talk and keeps consumer/founder lanes isolated at app startup.
  - A separate node-service command warning (`Did you mean devices?`) still appears in logs and should be handled as a follow-up, but it no longer forces consumer to attach to founder runtime.

### 2026-03-20 PR + consumer onboarding alignment

- Done:
  - Opened draft PR for this branch against `codex/consumer-openclaw-project`:
    - https://github.com/artemgetmann/openclaw/pull/72
  - Merged `codex/worktree-a-minimal` into this branch and resolved conflicts in consumer onboarding/runtime files.
  - Fixed a merge regression in `Onboarding.pageOrder` (remote branch missing `return`).
  - Aligned consumer settings navigation with Telegram onboarding:
    - consumer now keeps `Channels` visible without forcing full Advanced mode
    - normal consumer channel list is Telegram-only; other channels remain behind Advanced
  - Added in-app Telegram setup help entry points:
    - written guide button (docs link)
    - video walkthrough button (default link + override seam)
  - Updated consumer app doc to reflect current tabs and Telegram onboarding behavior.
- Verified:
  - `swift build --package-path apps/macos -c debug --product OpenClaw`
  - `pnpm build`
  - `bash -n scripts/package-mac-app.sh`
- Blocked / pending:
  - Full manual Telegram BYOK E2E as a real novice user flow is still in progress for this PR gate.
- Next 3 actions:
  - Run isolated runtime launch check on `19001` with founder runtime untouched.
  - Walk full in-app Telegram BYOK flow (token verify + first DM capture) and collect logs/evidence.
  - Update PR #72 checklist and switch from draft only after E2E is green.
