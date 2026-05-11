# OpenClaw Main / Consumer Divergence Tracker

> Retired as an active tracker on 2026-05-11. Consumer/main consolidation is
> completed for normal workflow: new consumer-product work targets `main`, and
> `openclaw-consumer` / `codex/consumer-openclaw-project` are legacy/emergency
> fallback only. Remaining launch and release work now lives in
> `docs/research/jarvis-consumer-launch-plan.md`. Keep this document as
> historical proof; do not use it as a live task board.

Last updated: 2026-05-11

This tracker exists to prevent redoing consolidation work that already landed.
If a slice is marked completed here, future agents should treat it as `main`
truth and build on it instead of reopening branch-era design debates.

## Rule Now

New consumer/product work targets `main`.

`/Users/user/Programming_Projects/openclaw-consumer` and
`codex/consumer-openclaw-project` are legacy/emergency fallback surfaces. They
are not the default place to implement P0 launch work.

## Divergence Table

| Category                              | Status                              | Current truth in `main`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Remaining action                                                                                                                                                                                             |
| ------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime identity / paths              | Completed                           | Shared runtime identity is in `main`; default state root is `~/Library/Application Support/OpenClaw/.openclaw`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Keep future runtime/path changes shared.                                                                                                                                                                     |
| Gateway ownership / port              | Local installed proof passed        | Default gateway is canonical `ai.openclaw.gateway` on `18789`. #597/#599/#613/#614/#615/#620/#625/#638 landed the known packaged ownership and repair pieces. #650 fixed stale entrypoint mismatch detection. #651 preserves packaged `OpenClawRuntime` roots for gateway install/restart and `OPENCLAW_FORK_ROOT`. Latest default-installed proof from `849514bacc` built `dist/OpenClaw.app`, copied it to `/Applications/OpenClaw.app`, launched `ai.openclaw.consumer.mac`, and repaired `ai.openclaw.gateway` from source-checkout `ProgramArguments[1]` to `/Applications/OpenClaw.app/Contents/Resources/OpenClawRuntime/openclaw/dist/index.js`. `/healthz` on `127.0.0.1:18789` returned live. Local notarized/Sparkle recut from `1ec69a58fd` now carries the latest fixes. | Replace/upload the public `v2026.3.15` assets from the verified handoff artifacts after explicit approval.                                                                                                   |
| LaunchAgent/service behavior          | Local installed proof passed        | Shared service install/restart behavior and takeover guardrails are in `main`. #638 repairs stale `OPENCLAW_SERVICE_VERSION` env after Sparkle update. #650 repaired stale entrypoint mismatch detection. #651 repaired the install/root side. Validation before #651 merge: `swift test --filter GatewayLaunchAgentManagerTests` passed 22 tests, `swift test --filter CommandResolverTests` passed 14 tests, and `git diff --check` passed. Latest installed-app proof showed `launchctl print gui/$(id -u)/ai.openclaw.gateway` with packaged `ProgramArguments[1]` and `OPENCLAW_MAIN_REPO=/Applications/OpenClaw.app/Contents/Resources/OpenClawRuntime/openclaw`. Local notarized/Sparkle recut from `1ec69a58fd` includes this launchd behavior.                               | Replace/upload the public `v2026.3.15` assets from the verified handoff artifacts after explicit approval.                                                                                                   |
| Consumer macOS shell parity           | Completed                           | Main has Consumer shell pieces: browser setup support/views, setup readiness, permissions, Telegram setup card/state/verifier, bootstrap, bundled runtime, helper bootstrap. Existing-user and isolated fresh-user app smokes passed. Latest Computer Use proof showed the installed app Channels tab with Telegram Live and Telegram verified, including text that OpenClaw already finished a Telegram task on this Mac.                                                                                                                                                                                                                                                                                                                                                            | Keep future app/setup fixes in `main`.                                                                                                                                                                       |
| Update-safe setup resume              | Completed                           | Main has setup resume that skips onboarding only after browser, permissions, model, and Telegram checks pass. Real existing setup did not show onboarding in smoke; isolated fresh setup showed onboarding from clean state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Keep future setup fixes in `main`.                                                                                                                                                                           |
| Consumer packaging from main          | Local recut complete for v2026.3.15 | Main produced the signed/notarized public `v2026.3.15` release from `205d5f596602ff82270b1af5a3de24c33c32b532`; that public asset is now stale for latest provenance. A fresh local recut from `1ec69a58fd441e1c63a91e5af4468fd6fe53f272` produced `OpenClaw.dmg`, `OpenClaw.zip`, `openclaw-consumer-appcast.xml`, and `OpenClaw-2026.3.15.dSYM.zip` under `dist/release-handoff/`. App and DMG notarization passed, stapling passed, and Gatekeeper accepted both as Notarized Developer ID. Sparkle consumer release gates are in place. Public DMG install smoke and deterministic Sparkle non-UI update completion passed for the currently published asset.                                                                                                                     | Upload/replace public `v2026.3.15` assets from the verified handoff set, then rerun public install/update smoke if distribution claims require it. Interactive Sparkle dialog visual proof remains optional. |
| App rename to `OpenClaw.app`          | Completed                           | Release packaging now ships the visible product as `OpenClaw.app` / `OpenClaw.dmg` / `OpenClaw.zip`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Keep old `OpenClaw Consumer` references only where they describe history or debug compatibility.                                                                                                             |
| Bundle id / TCC migration             | Deferred                            | Current Consumer bundle identity is preserved for continuity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Decide separately from visible rename. Changing bundle id can reset permissions and create support churn.                                                                                                    |
| `openclaw-consumer` branch retirement | Completed                           | Main has the code needed to stop using the consumer checkout for new implementation. Existing-user and isolated fresh-user main-built smokes passed. Older docs/workflows now label the old branch as historical or emergency-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Keep fallback available only for emergency recovery.                                                                                                                                                         |
| Consumer packaging wrappers           | Completed                           | `scripts/package-openclaw-mac-dist.sh` is the canonical main-built shipping command. `scripts/package-consumer-mac-dist.sh` remains as a compatibility wrapper for old automation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Keep compatibility wrapper behavior unless a later cleanup deliberately removes it.                                                                                                                          |
| Overlay/defaults policy               | Mostly completed                    | Core runtime/setup is shared. Telegram `/model` starts with Claude, ChatGPT, and More. #592 added the simplified family-first picker; #594 polished labels after live feedback by capitalizing `GPT`, removing duplicate/noisy ChatGPT rows, and using product-facing Claude labels such as `Sonnet 4.6`. Fresh consumer configs get broad useful bundled skills by default, and model-facing skills remain visible when setup/auth/bins are missing.                                                                                                                                                                                                                                                                                                                                 | Keep future onboarding presentation defaults explicit instead of scattering product conditionals. This is hygiene, not a release blocker.                                                                    |
| Branch/workflow docs                  | Completed                           | Primary and older workflow docs now target `main` for consumer/product work and treat `openclaw-consumer` as historical or legacy/emergency fallback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Keep future docs aligned with the main-first workflow.                                                                                                                                                       |

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
- #650: stale LaunchAgent entrypoint mismatch detection
- #651: preserve packaged runtime roots during gateway install/restart

## Historical Queue Imported To Launch Plan

These items have been imported into
`docs/research/jarvis-consumer-launch-plan.md`. They remain below as proof and
background, not as this document's active queue.

1. Use the deterministic release lane for the final package. Release scripts now
   support a local release-env file rooted under
   `~/Library/Application Support/OpenClaw/` for non-secret paths, with secrets
   kept in Keychain, plus explicit submit/poll/staple notarization steps so the
   agent lane does not block blindly on Apple's queue.
2. Publish the verified final recut only after the app work is done and
   final release approval is explicit. The local handoff artifacts were rebuilt
   from current `main` at `1ec69a58fd441e1c63a91e5af4468fd6fe53f272`, version
   `2026.3.15`, build `2026031590`, and passed app/DMG notarization, stapling,
   Gatekeeper, and Sparkle appcast generation. Until upload/replacement happens,
   the public GitHub release still points at the old
   `205d5f596602ff82270b1af5a3de24c33c32b532` asset provenance.
3. Run an interactive Sparkle UI smoke only if the product claim needs the exact
   dialog path. Deterministic Sparkle update completion from `v2026.3.14` to
   `v2026.3.15` already passed, so this is optional/final.
4. Keep account/license/backend/public package audit open as a separate launch
   audit. This is likely owned by the main/pane-6 launch plan, not the release
   automation lane.
5. Keep overlay/defaults cleanup as non-urgent hygiene, not a release blocker.

## External Release Lane

Sparkle live update-path verification, notarization credentials, real Sparkle
key/feed handling, and the published `v2026.3.15` release artifact are owned by
the release lane. This tracker consumes that lane's artifact provenance instead
of duplicating packaging work.

Latest release-lane truth: local signed/notarized/Sparkle handoff artifacts are
ready from `1ec69a58fd441e1c63a91e5af4468fd6fe53f272`, but the public GitHub
release has not yet been replaced/uploaded with those assets. Public upload is
deferred until the app work is done and final release approval is explicit.

## Release Proof: v2026.3.15

- Release: <https://github.com/artemgetmann/openclaw/releases/tag/v2026.3.15>
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
- Sparkle interactive dialog visual proof: still open and treated as optional/final

## Local Recut Proof: v2026.3.15

- Source commit: `1ec69a58fd441e1c63a91e5af4468fd6fe53f272`
- Version/build: `2026.3.15` / `2026031590`
- Handoff directory:
  `/Users/user/Programming_Projects/openclaw/.worktrees/consolidation-gui-smoke-20260508/dist/release-handoff`
- Trust status:
  - app notarization accepted:
    `2110d556-1a8b-4f40-86af-ca32d404f0cd`
  - DMG notarization accepted:
    `ba1faf85-92aa-47d6-bd8d-dec0c669a636`
  - app and DMG stapling passed
  - app and DMG Gatekeeper acceptance passed as Notarized Developer ID
- Artifact hashes:
  - `OpenClaw.dmg`:
    `ed06aab578300ea914b8c244c8aa862cabac86e62bed7ffdfdc84b93914f6ced`
  - `OpenClaw.zip`:
    `08f62f1fa884560d7b8d83df9b1f94d5851deb60a811ee1b9dbf37509ce869c9`
  - `OpenClaw-2026.3.15.dSYM.zip`:
    `5c98861957ebb8759d4001b94a6ea85b278bc733fcbda71a717a226c291534f7`
  - `openclaw-consumer-appcast.xml`:
    `a03e414223f969a41afeffa4c7ab3a85f30618546564941db58deb28b70b1f5e`

Status: local recut is complete. Public release replacement is still pending
final approval after the app work is done.

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

- PR: <https://github.com/artemgetmann/openclaw/pull/625>
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
  `https://github.com/artemgetmann/openclaw/pull/650`, merged as
  `4d01d8af6e4be91c4009818314c64c1e8838bb57`. It fixed stale entrypoint
  mismatch detection, but live proof after #650 still failed because launchd
  install wrote source-checkout `ProgramArguments[1]`.
- PR #651:
  `https://github.com/artemgetmann/openclaw/pull/651`, merged as
  `f2382618524142ea0023d9d3a2fbff9cc61d8f61`. It preserves packaged
  `OpenClawRuntime` roots for gateway install/restart and
  `OPENCLAW_FORK_ROOT`.
- #651 validation before merge:
  `swift test --filter GatewayLaunchAgentManagerTests` passed 22 tests,
  `swift test --filter CommandResolverTests` passed 14 tests, and
  `git diff --check` passed.
- #651 debug proof:
  fast rebuild/relaunch from `origin/main` at `f238261852` passed bundle
  verification/opened app with
  `ALLOW_SINGLE_ARCH_CONSUMER_SMOKE=1 bash scripts/rebuild-relaunch-consumer-mac-app.sh --instance gui-verify-20260508`.
  Gatekeeper rejected because it was an unnotarized debug smoke.
- LaunchAgent proof:
  isolated debug label `ai.openclaw.consumer.gui-verify-20260508.gateway`
  loaded `ProgramArguments[1]` as
  `/Users/user/Programming_Projects/openclaw/.worktrees/consolidation-gui-smoke-20260508/dist/OpenClaw (gui-verify-20260508).app/Contents/Resources/OpenClawRuntime/openclaw/dist/index.js`.
  `/healthz` passed on `127.0.0.1:39388` with
  `{"ok":true,"status":"live"}`.
- Superseded gate:
  this debug-app GUI block was later cleared by proving the default installed
  app with Computer Use. Keep this section as historical root-cause evidence,
  not current status.
- Release caveat: public release lane remains separate. A later local recut
  from `1ec69a58fd` completed, but the public GitHub release assets still need
  explicit replacement/upload before public provenance is current.

## Post-#651 Default Installed Proof: Passed

- Worktree branch: `codex/default-installed-smoke-after-653-20260509`
- Base/provenance: `origin/main` at `849514bacc3d`
- Bundle: built default-identity `dist/OpenClaw.app`, bundle id
  `ai.openclaw.consumer.mac`, variant `consumer`, `OpenClawGitCommit=849514bacc`
- Install: copied the rebuilt bundle to `/Applications/OpenClaw.app` and
  launched `ai.openclaw.consumer.mac`
- Initial root cause: the app was running, but `ai.openclaw.gateway` initially
  remained pinned to
  `/Users/user/Programming_Projects/openclaw/dist/index.js`
- Repair result: app/CLI takeover rewrote the loaded LaunchAgent so
  `ProgramArguments[1]` became
  `/Applications/OpenClaw.app/Contents/Resources/OpenClawRuntime/openclaw/dist/index.js`
  and `OPENCLAW_MAIN_REPO` became
  `/Applications/OpenClaw.app/Contents/Resources/OpenClawRuntime/openclaw`
- Health: `/healthz` on `127.0.0.1:18789` returned
  `{"ok":true,"status":"live"}`
- GUI proof: Computer Use works for the installed app. The Channels tab showed
  Telegram Live and Telegram verified, with text that OpenClaw already finished
  a Telegram task on this Mac.
- Remaining blocker at that time: public release provenance only. A later local
  notarized/Sparkle recut from `1ec69a58fd` completed, but public asset
  replacement/upload remains separate.

## Things We Should Stop Saying

- Stop saying consumer implementation work should target
  `codex/consumer-openclaw-project`.
- Stop treating runtime identity, macOS shell parity, or setup resume as open
  consolidation problems. Gateway ownership code is landed, and automatic
  installed-app LaunchAgent repair has local proof.
- Stop saying Developer ID notarization, public installed-release smoke, or
  Sparkle update completion remains open for `v2026.3.15`; those gates passed.
  Only literal interactive Sparkle dialog visual proof remains optional/final.
- Stop describing the Channels tab blocker as unproven. #634 merged the SwiftUI
  verifier fix, #645 merged the outbound activity gap fix, #650 merged stale
  entrypoint mismatch detection, and #651 merged packaged-root preservation.
  Latest Computer Use proof from installed default app commit `849514bacc`
  showed Telegram Live and Telegram verified. `/healthz` and LaunchAgent proof
  are still required for future runtime smokes, but this local GUI gate is now
  closed.
- Stop implying the final product is two apps: `OpenClaw` and
  `OpenClaw Consumer`.
- Stop treating the visible app rename as blocked. The visible rename is done;
  only bundle-id migration remains deferred.
