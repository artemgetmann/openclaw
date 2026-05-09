# OpenClaw Main / Consumer Divergence Tracker

Last updated: 2026-05-09

This tracker exists to prevent redoing consolidation work that already landed.
If a slice is marked completed here, future agents should treat it as `main`
truth and build on it instead of reopening branch-era design debates.

## Rule Now

New consumer/product work targets `main`.

`/Users/user/Programming_Projects/openclaw-consumer` and
`codex/consumer-openclaw-project` are legacy/emergency fallback surfaces. They
are not the default place to implement P0 launch work.

## Divergence Table

| Category                              | Status                   | Current truth in `main`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Remaining action                                                                                                                       |
| ------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime identity / paths              | Completed                | Shared runtime identity is in `main`; default state root is `~/Library/Application Support/OpenClaw/.openclaw`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Keep future runtime/path changes shared.                                                                                               |
| Gateway ownership / port              | Blocked on #650 proof    | Default gateway is canonical `ai.openclaw.gateway` on `18789`. #597/#599/#613/#614/#615/#620/#625/#638 landed the known packaged ownership and repair pieces. New blocker: `/Applications/OpenClaw.app` can run while `ai.openclaw.gateway` remains attached to `/Users/user/Programming_Projects/openclaw/dist/index.js`, so `/healthz` alone is insufficient. PR #650 (`https://github.com/artemgetmann/openclaw/pull/650`) makes packaged consumer LaunchAgent ownership prefer `/Applications/OpenClaw.app/Contents/Resources/OpenClawRuntime/openclaw/dist/index.js` when the bundled runtime exists, preserving source/dev fallback.                                        | Merge #650, rebuild/relaunch installed app from current `main`, prove loaded `ProgramArguments[1]` is packaged, then prove `/healthz`. |
| LaunchAgent/service behavior          | Blocked on #650 proof    | Shared service install/restart behavior and takeover guardrails are in `main`. #638 repairs stale `OPENCLAW_SERVICE_VERSION` env after Sparkle update. Current lane root cause is narrower: the installed app can be running while launchd still owns the source-checkout runtime. PR #650 is open on branch `codex/launchagent-packaged-takeover-20260509`, commit `d9b38bf7aef2106edae9b80fa28a509e689e1f6d`. Validation so far: `swift test --filter GatewayLaunchAgentManagerTests` passed 21 tests, `swift test --filter GatewayProcessManagerTests` passed 3 tests, and `git diff --check` passed.                                                                          | After merge, verify launchd packaged-runtime ownership before using `/healthz` or GUI state as proof.                                  |
| Consumer macOS shell parity           | Completed                | Main has Consumer shell pieces: browser setup support/views, setup readiness, permissions, Telegram setup card/state/verifier, bootstrap, bundled runtime, helper bootstrap. Existing-user and isolated fresh-user app smokes passed.                                                                                                                                                                                                                                                                                                                                                                                                                                             | Keep future app/setup fixes in `main`.                                                                                                 |
| Update-safe setup resume              | Completed                | Main has setup resume that skips onboarding only after browser, permissions, model, and Telegram checks pass. Real existing setup did not show onboarding in smoke; isolated fresh setup showed onboarding from clean state.                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Keep future setup fixes in `main`.                                                                                                     |
| Consumer packaging from main          | Completed for v2026.3.15 | Main produced the signed/notarized `v2026.3.15` release from `205d5f596602ff82270b1af5a3de24c33c32b532`. Codesign stale-signature and DMG conversion failures are fixed. Packaging copies DMG/ZIP/dSYM ZIP handoff artifacts to the main checkout by default. Sparkle consumer release gates are in place. GitHub release assets are `OpenClaw.dmg`, `OpenClaw.zip`, `openclaw-consumer-appcast.xml`, and `OpenClaw-2026.3.15.dSYM.zip`. The public appcast resolves to `v2026.3.15`. Public DMG install smoke passed from the GitHub asset; Sparkle non-UI update completion from `v2026.3.14` to `v2026.3.15` passed and the updated app launched with a live packaged gateway. | Interactive Sparkle dialog visual proof remains open if product claims require the exact UI path.                                      |
| App rename to `OpenClaw.app`          | Completed                | Release packaging now ships the visible product as `OpenClaw.app` / `OpenClaw.dmg` / `OpenClaw.zip`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Keep old `OpenClaw Consumer` references only where they describe history or debug compatibility.                                       |
| Bundle id / TCC migration             | Deferred                 | Current Consumer bundle identity is preserved for continuity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Decide separately from visible rename. Changing bundle id can reset permissions and create support churn.                              |
| `openclaw-consumer` branch retirement | Completed                | Main has the code needed to stop using the consumer checkout for new implementation. Existing-user and isolated fresh-user main-built smokes passed. Older docs/workflows now label the old branch as historical or emergency-only.                                                                                                                                                                                                                                                                                                                                                                                                                                               | Keep fallback available only for emergency recovery.                                                                                   |
| Consumer packaging wrappers           | Completed                | `scripts/package-openclaw-mac-dist.sh` is the canonical main-built shipping command. `scripts/package-consumer-mac-dist.sh` remains as a compatibility wrapper for old automation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Keep compatibility wrapper behavior unless a later cleanup deliberately removes it.                                                    |
| Overlay/defaults policy               | Mostly completed         | Core runtime/setup is shared. Telegram `/model` starts with Claude, ChatGPT, and More. #592 added the simplified family-first picker; #594 polished labels after live feedback by capitalizing `GPT`, removing duplicate/noisy ChatGPT rows, and using product-facing Claude labels such as `Sonnet 4.6`. Fresh consumer configs get broad useful bundled skills by default, and model-facing skills remain visible when setup/auth/bins are missing.                                                                                                                                                                                                                             | Keep future onboarding presentation defaults explicit instead of scattering product conditionals.                                      |
| Branch/workflow docs                  | Completed                | Primary and older workflow docs now target `main` for consumer/product work and treat `openclaw-consumer` as historical or legacy/emergency fallback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Keep future docs aligned with the main-first workflow.                                                                                 |

## Completed PRs To Build From

- #552: runtime/gateway identity
- #553: shared skills root
- #554: Telegram tester/model guardrails
- #555: canonical gateway env hotfix
- #556: Consumer app parity port into `main`
- #557: update-safe setup resume
- #558: packaging codesign stale-signature fix
- #572: preserve loaded gateway on app enable
- #573: keep canonical gateway listener
- #574: suppress repeat Consumer setup on attach
- #575: keep titled gateway listener
- #579: canonical Consumer packaging handoff copy
- #580: isolated fresh-user Consumer macOS app smoke
- #583: consumer Sparkle release gates
- #584: docs/workflow cleanup for main-first consumer work
- #588: conservative product rename to `OpenClaw.app`
- #589: consumer smoke handoff default
- #590: OpenClaw macOS distribution wrapper promotion
- #592: simplified consumer model picker defaults
- #594: model picker label polish
- #597: packaged app smoke fixes for gateway/env/setup preservation
- #599: shallow gateway watchdog health probe
- #613: packaged app gateway ownership
- #614: packaged app launchd context
- #615: bundled app runtime root preference
- #620: automatic packaged gateway LaunchAgent replacement repair
- #625: packaged gateway source-attach bypass repair
- #634: Channels tab first-task verifier auto-marks verified from recent live
  Telegram activity
- #638: LaunchAgent service-version drift repair
- #641: docs refresh for post-#634 consolidation truth
- #645: Telegram outbound bot reply activity telemetry

## Queue Now

1. Merge/prove PR #650
   (`https://github.com/artemgetmann/openclaw/pull/650`), then rerun the
   Computer Use Channels tab smoke. PR #645 merged as
   `ab9c9de42df9bb8058d75528f9e6dbb77bef7a6c`, so Telegram outbound activity
   telemetry is fixed. The current blocker is LaunchAgent ownership:
   `/Applications/OpenClaw.app` can run while `ai.openclaw.gateway` still
   points at the source-checkout runtime.
2. Recut the next public artifact from current `main`/newer before broad
   distribution. Public `v2026.3.15` still contains the old service-version
   repair predicate and the pre-#634 Channels tab verifier behavior, and public
   artifacts do not contain #645 or #650. Sparkle/final public artifacts must
   be rebuilt from current `main` after #650 if it merges and installed-app
   proof passes.
3. Run an interactive Sparkle UI smoke if the product claim needs the exact
   dialog path. Deterministic Sparkle update completion from `v2026.3.14` to
   `v2026.3.15` already passed.
4. Keep account/license/backend work and public package/secrets audit open.

## External Release Lane

Sparkle live update-path verification, notarization credentials, real Sparkle
key/feed handling, and the published `v2026.3.15` release artifact are owned by
the separate Sparkle/release lane. This tracker should consume that lane's
published artifact provenance instead of duplicating the work here.

## Release Proof: v2026.3.15

- Release: https://github.com/artemgetmann/openclaw/releases/tag/v2026.3.15
- Release tag target: `205d5f596602ff82270b1af5a3de24c33c32b532`
- Public appcast resolves to `v2026.3.15`
- Release assets:
  - `OpenClaw.dmg`
  - `OpenClaw.zip`
  - `openclaw-consumer-appcast.xml`
  - `OpenClaw-2026.3.15.dSYM.zip`
- Trust status:
  - `OpenClaw.app` and `OpenClaw.dmg` were Developer ID signed
  - notarization passed
  - stapling passed
  - local Gatekeeper acceptance passed
- Installed-release smoke: passed from the public `v2026.3.15` DMG
- Sparkle update completion: passed from public `v2026.3.14` to `v2026.3.15`
  through Sparkle's non-UI installer path
- Sparkle interactive dialog visual proof: still open/optional

## Public v2026.3.15 Installed Smoke

- Public DMG: `https://github.com/artemgetmann/openclaw/releases/download/v2026.3.15/OpenClaw.dmg`
- Installed app: version `2026.3.15`, build `2026031590`, commit `205d5f5966`
- Trust: DMG and installed app accepted by Gatekeeper as Notarized Developer ID
- Gateway: loaded `ai.openclaw.gateway` pointed at `/Applications/OpenClaw.app/Contents/Resources/OpenClawRuntime/openclaw/dist/index.js`
- Health: `/healthz` returned `{"ok":true,"status":"live"}`
- Isolated smoke: `fresh_user_smoke=passed`, `onboarding_window=observed`, `real_user_config_unchanged=yes`
- Sparkle update: old public `v2026.3.14` build `2026031490` updated through Sparkle to public `v2026.3.15` build `2026031590`; Sparkle downloaded the signed `OpenClaw.zip` enclosure, extracted to 100%, printed `Installing Update...`, then `Installation Finished. Exiting.`
- Sparkle result: `/Applications/OpenClaw.app` became version `2026.3.15`, build `2026031590`, commit `205d5f5966`, and launched with `/healthz` live.
- Sparkle caveat: interactive dialog visual proof remains open; loaded launchd env still reported `OPENCLAW_SERVICE_VERSION => 2026.3.14` even though the app and packaged entrypoint were updated. #638 fixes that repair predicate in `main`; a new artifact is still required before the fix ships to users.

## Post-#625 Local Proof

- PR: https://github.com/artemgetmann/openclaw/pull/625
- Merge commit: `5ce43d8538e223db4390733c01611f0684d12541`
- Rebuilt branch artifact commit before squash merge:
  `fe05c860a87411709effdf83050c1bae2ad601cd`
- Packaging command passed:
  `SKIP_NOTARIZE=1 ALLOW_DEFAULT_SPARKLE_KEY_FOR_CONSUMER_SMOKE=1 bash scripts/package-openclaw-mac-dist.sh`
- Installed-over-stale-source proof:
  - stale `ProgramArguments[1]` before launch:
    `/Users/user/Programming_Projects/openclaw/dist/index.js`
  - repaired `ProgramArguments[1]` after first launch:
    `/Applications/OpenClaw.app/Contents/Resources/OpenClawRuntime/openclaw/dist/index.js`
  - `ai.openclaw.gateway-watchdog` absent from `launchctl`
  - `/healthz` returned `{"ok":true,"status":"live"}` for 18 checks over 90s
- Real Telegram behavioral proof:
  - bot: `@Jarvis_cl4w_bot`
  - sent token: `FIRSTTASK-20260508T062445Z`
  - sent message id: `48670`
  - matched reply id: `48671`
  - reply text: `OK FIRSTTASK-20260508T062445Z`
- GUI caveat:
  - #634 merged as `5515ce9c4373d7056b6c961c654c25c3490804b1` and fixes the
    false Channels tab Telegram verifier state by auto-marking first-task
    verified from recent live activity
  - #634 validation passed:
    `swift test --filter TelegramSetupBootstrapTests`,
    `swift test --filter ConsumerSetupResumeTests`, and `git diff --check`
  - Later current-main installed-app smoke showed this was not enough: the GUI
    path still failed because channel status did not advance `lastOutboundAt`
    after a real bot reply.
  - Local root-cause fix: `extensions/telegram/src/bot/delivery.replies.ts`
    records outbound activity once after a reply payload is delivered.
    `extensions/telegram/src/bot/delivery.test.ts` proves successful
    `deliverReplies` records outbound activity for `accountId`, while failed
    sends do not. Focused proof passed:
    `pnpm exec vitest run --config vitest.config.ts extensions/telegram/src/bot/delivery.test.ts src/infra/channel-activity.test.ts`
    = 2 files / 37 tests passed, plus `git diff --check`.

## Current-Main GUI Smoke: Installed Path Failed

- Worktree state: fast-forwarded to `origin/main` at
  `9d64a4ea5942cf1bb71a618fce081f35e14c8119`.
- Docs baseline: PR #641 had already merged as
  `fd441d61358c97303c3119c6c3bcf439792d145b`, recording post-#634 truth.
- Wrong first target: isolated instance `gui-verify-20260508` built and
  launched `dist/OpenClaw (gui-verify-20260508).app` at `fd441d6135`, and
  `/healthz` on `39388` eventually returned live. Do not count this as a
  product pass because the isolated config had no Telegram config and its
  LaunchAgent used a source-checkout entrypoint.
- Correct local target: default-identity current-main bundle built at
  `dist/OpenClaw.app`, copied over `/Applications/OpenClaw.app`, and reported
  `OpenClawGitCommit` `fd441d6135` with bundle id
  `ai.openclaw.consumer.mac`. This was a local smoke replacement, not
  notarized/public release provenance.
- Runtime proof: default `ai.openclaw.gateway` pointed at
  `/Applications/OpenClaw.app/Contents/Resources/OpenClawRuntime/openclaw/dist/index.js`;
  `/healthz` on `18789` returned `{"ok":true,"status":"live"}`.
- GUI result: Computer Use Channels tab still showed `Telegram, Verify first
task` and `One task left`. This is a FAIL for the installed-app GUI path, not
  a stale-app-build caveat.
- Root cause evidence: `channels status --json` showed the default Telegram
  account remained running/configured with `lastInboundAt=1778243885824` and
  `lastOutboundAt=1778236247270`, so outbound was older than inbound by about
  `-7638554ms`. The GUI auto-verify code correctly refuses to promote in that
  state.
- Live Telegram proof: `@Jarvis_cl4w_bot` received
  `OK GUIVERIFY-20260508T122756Z` as message `48740` and replied
  `OK GUIVERIFY-20260508T122756Z` as message `48741`. Channel status still did
  not advance `lastOutboundAt`.
- Root cause: Telegram bot auto-replies bypassed `sendMessageTelegram`, so
  successful bot replies were not recorded into `lastOutboundAt`.
- PR #645:
  `https://github.com/artemgetmann/openclaw/pull/645`, merged as
  `ab9c9de42df9bb8058d75528f9e6dbb77bef7a6c`. Reply delivery now records
  outbound activity after successful payload delivery. Failed sends do not
  record activity. Focused tests after rebase passed:
  `pnpm exec vitest run --config vitest.config.ts extensions/telegram/src/bot/delivery.test.ts src/infra/channel-activity.test.ts`
  = 2 files / 37 tests.
- New packaged proof blocker: branch-isolated debug app
  `dist/OpenClaw (consolidation-gui-smoke-20260508).app` used bundle id
  `ai.openclaw.consumer.mac.debug.consolidation-gui-smoke-20260508` on port
  `24529`, but Gatekeeper rejected it because it was unnotarized and it was the
  wrong default GUI proof target. The default bundle then installed as
  `/Applications/OpenClaw.app` with plist `OpenClawGitCommit=15e000a19c`,
  bundle id `ai.openclaw.consumer.mac`, and variant `consumer`.
- Runtime blocker: `/Applications/OpenClaw.app` was running, but
  `launchctl print gui/$(id -u)/ai.openclaw.gateway` still showed
  `ProgramArguments[1]` `/Users/user/Programming_Projects/openclaw/dist/index.js`
  and `OPENCLAW_MAIN_REPO=/Users/user/Programming_Projects/openclaw`. `/healthz`
  on `18789` was live, but it proved the source-checkout runtime, not
  `/Applications/OpenClaw.app/Contents/Resources/OpenClawRuntime/openclaw/dist/index.js`.
- PR #650:
  `https://github.com/artemgetmann/openclaw/pull/650`, branch
  `codex/launchagent-packaged-takeover-20260509`, commit
  `d9b38bf7aef2106edae9b80fa28a509e689e1f6d`. It makes packaged consumer
  LaunchAgent ownership prefer
  `/Applications/OpenClaw.app/Contents/Resources/OpenClawRuntime/openclaw/dist/index.js`
  when the bundled runtime exists, preserving source/dev fallback.
- #650 validation so far:
  `swift test --filter GatewayLaunchAgentManagerTests` passed 21 tests,
  `swift test --filter GatewayProcessManagerTests` passed 3 tests, and
  `git diff --check` passed.
- Remaining gate: after #650 merges, rebuild/relaunch installed app from
  current `main`, prove loaded LaunchAgent `ProgramArguments[1]` is the
  packaged runtime, prove `/healthz`, then prove GUI Channels Telegram verified
  state.
- Release caveat: public release lane remains separate. Public artifacts must
  be recut from current `main` after #650 if it merges and installed-app proof
  passes.

## Things We Should Stop Saying

- Stop saying consumer implementation work should target
  `codex/consumer-openclaw-project`.
- Stop treating runtime identity, macOS shell parity, or setup resume as open
  consolidation problems. Gateway ownership code is landed, and automatic
  installed-app LaunchAgent repair has local proof.
- Stop saying Developer ID notarization, public installed-release smoke, or
  Sparkle update completion remains open for `v2026.3.15`; those gates passed.
  Only literal interactive Sparkle dialog visual proof remains open/optional.
- Stop describing the Channels tab blocker as only an unimplemented verifier,
  an unclicked verifier button, a stale installed app, or an unfixed telemetry
  root cause. #634 merged the SwiftUI verifier fix, #645 merged the outbound
  activity gap fix, and the latest blocker is LaunchAgent packaged-entrypoint
  takeover for the default installed app. `/healthz` is insufficient unless
  launchd also points at the packaged runtime.
- Stop implying the final product is two apps: `OpenClaw` and
  `OpenClaw Consumer`.
- Stop treating the visible app rename as blocked. The visible rename is done;
  only bundle-id migration remains deferred.
