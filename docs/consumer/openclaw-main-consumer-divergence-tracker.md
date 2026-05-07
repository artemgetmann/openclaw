# OpenClaw Main / Consumer Divergence Tracker

Last updated: 2026-05-07

This tracker exists to prevent redoing consolidation work that already landed.
If a slice is marked completed here, future agents should treat it as `main`
truth and build on it instead of reopening branch-era design debates.

## Rule Now

New consumer/product work targets `main`.

`/Users/user/Programming_Projects/openclaw-consumer` and
`codex/consumer-openclaw-project` are legacy/emergency fallback surfaces. They
are not the default place to implement P0 launch work.

## Divergence Table

| Category                              | Status                           | Current truth in `main`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Remaining action                                                                                               |
| ------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Runtime identity / paths              | Completed                        | Shared runtime identity is in `main`; default state root is `~/Library/Application Support/OpenClaw/.openclaw`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Keep future runtime/path changes shared.                                                                       |
| Gateway ownership / port              | Completed                        | Default gateway is canonical `ai.openclaw.gateway` on `18789`. #597 keeps the consumer-style app from stopping an already-healthy canonical gateway during attach/setup paths. #599 keeps watchdog recovery from killing a healthy `/healthz` gateway because a deep CLI/RPC probe is slow or noisy. #613 allows the packaged app entrypoint to own the gateway; #614 allows the packaged launchd context; #615 makes the app prefer the bundled runtime root over stale saved dev roots. #620 repairs stale installed-app LaunchAgents to the packaged runtime entrypoint.                                                                                                                                                 | Run installed-release smoke from the public `v2026.3.14` artifact before claiming broad user replacement coverage. |
| LaunchAgent/service behavior          | Completed                        | Shared service install/restart behavior and takeover guardrails are in `main`. #597 narrowed packaged app gateway install env handling so provider keys/tokens are not persisted into the LaunchAgent plist from auth-profile env refs. #620 repaired a stale `ai.openclaw.gateway` plist pointing at `/Users/user/Programming_Projects/openclaw/dist/index.js` while the legacy watchdog was running from `/Users/user/Programming_Projects/openclaw/scripts/gateway-watchdog.sh`; after replacement, the plist and loaded service `ProgramArguments[1]` pointed at `/Applications/OpenClaw.app/Contents/Resources/OpenClawRuntime/openclaw/dist/index.js`, and `launchctl` could not find `ai.openclaw.gateway-watchdog`. | Verify the same path from the public `v2026.3.14` download; do not claim full GUI smoke from prior automation. |
| Consumer macOS shell parity           | Completed                        | Main has Consumer shell pieces: browser setup support/views, setup readiness, permissions, Telegram setup card/state/verifier, bootstrap, bundled runtime, helper bootstrap. Existing-user and isolated fresh-user app smokes passed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Keep future app/setup fixes in `main`.                                                                         |
| Update-safe setup resume              | Completed                        | Main has setup resume that skips onboarding only after browser, permissions, model, and Telegram checks pass. Real existing setup did not show onboarding in smoke; isolated fresh setup showed onboarding from clean state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Keep future setup fixes in `main`.                                                                             |
| Consumer packaging from main          | Completed for v2026.3.14         | Main produced the signed/notarized `v2026.3.14` release from `41f2868ad7a2f174aad7e385f0c28efe81f816c0`. Codesign stale-signature and DMG conversion failures are fixed. Packaging copies DMG/ZIP/dSYM ZIP handoff artifacts to the main checkout by default. Sparkle consumer release gates are in place. GitHub release assets are `OpenClaw.dmg`, `OpenClaw.zip`, `openclaw-consumer-appcast.xml`, and `OpenClaw-2026.3.14.dSYM.zip`.                                                                                                                                                                                                                                         | Verify installed-release smoke, live Sparkle update path, and public package/secrets audit.                    |
| App rename to `OpenClaw.app`          | Completed                        | Release packaging now ships the visible product as `OpenClaw.app` / `OpenClaw.dmg` / `OpenClaw.zip`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Keep old `OpenClaw Consumer` references only where they describe history or debug compatibility.               |
| Bundle id / TCC migration             | Deferred                         | Current Consumer bundle identity is preserved for continuity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Decide separately from visible rename. Changing bundle id can reset permissions and create support churn.      |
| `openclaw-consumer` branch retirement | Completed                        | Main has the code needed to stop using the consumer checkout for new implementation. Existing-user and isolated fresh-user main-built smokes passed. Older docs/workflows now label the old branch as historical or emergency-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Keep fallback available only for emergency recovery.                                                           |
| Consumer packaging wrappers           | Completed                        | `scripts/package-openclaw-mac-dist.sh` is the canonical main-built shipping command. `scripts/package-consumer-mac-dist.sh` remains as a compatibility wrapper for old automation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Keep compatibility wrapper behavior unless a later cleanup deliberately removes it.                            |
| Overlay/defaults policy               | Mostly completed                 | Core runtime/setup is shared. Telegram `/model` starts with Claude, ChatGPT, and More. #592 added the simplified family-first picker; #594 polished labels after live feedback by capitalizing `GPT`, removing duplicate/noisy ChatGPT rows, and using product-facing Claude labels such as `Sonnet 4.6`. Fresh consumer configs get broad useful bundled skills by default, and model-facing skills remain visible when setup/auth/bins are missing.                                                                                                                                                                                                                                                                       | Keep future onboarding presentation defaults explicit instead of scattering product conditionals.              |
| Branch/workflow docs                  | Completed                        | Primary and older workflow docs now target `main` for consumer/product work and treat `openclaw-consumer` as historical or legacy/emergency fallback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Keep future docs aligned with the main-first workflow.                                                         |

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

## Queue Now

1. Run installed-release smoke from the public `v2026.3.14` DMG/ZIP assets.
2. Complete real Telegram first-task verification from the Channels tab.
3. Verify the Sparkle live update path from an older installed build to
   `v2026.3.14` or the next release.
4. Keep account/license/backend work and public package/secrets audit open.

## Release Proof: v2026.3.14

- Release: https://github.com/artemgetmann/openclaw/releases/tag/v2026.3.14
- Release tag target: `41f2868ad7a2f174aad7e385f0c28efe81f816c0`
- Current-main caveat: `v2026.3.14` is a real release but not current `main`
  HEAD. `main` advanced afterward, including #622 at
  `bed0de66fd3011b9c8a2d4f63b0ac59a9ef1b0a1` and the later #620 merge.
- Installed app: `/Applications/OpenClaw.app`
- App identity: `OpenClaw`, `ai.openclaw.consumer.mac`, variant `consumer`,
  version `2026.3.14`
- Release assets:
  - `OpenClaw.dmg`
  - `OpenClaw.zip`
  - `openclaw-consumer-appcast.xml`
  - `OpenClaw-2026.3.14.dSYM.zip`
- Handoff files copied to:
  - `/Users/user/Programming_Projects/openclaw/dist/consumer-handoff/`
- Trust status:
  - `OpenClaw.app` and `OpenClaw.dmg` were Developer ID signed
  - notarization passed
  - stapling passed
  - local Gatekeeper acceptance passed
- GUI automation:
  - confirmed menu-bar `Stop AI Operator`
  - did not expose a SwiftUI Settings content window, so this is not full
    visual GUI smoke
- Gateway proof:
  - stale plist initially pointed at
    `/Users/user/Programming_Projects/openclaw/dist/index.js`
  - legacy watchdog initially ran from
    `/Users/user/Programming_Projects/openclaw/scripts/gateway-watchdog.sh`
  - after replacement, plist and loaded service `ProgramArguments[1]` pointed at
    `/Applications/OpenClaw.app/Contents/Resources/OpenClawRuntime/openclaw/dist/index.js`
  - `launchctl` could not find `ai.openclaw.gateway-watchdog`
  - `/healthz` returned `{"ok":true,"status":"live"}` for 18 checks over 90s
- Packaging proof:
  - DMG conversion passed
  - `hdiutil verify` checksum was valid

## Things We Should Stop Saying

- Stop saying consumer implementation work should target
  `codex/consumer-openclaw-project`.
- Stop treating runtime identity, macOS shell parity, or setup resume as open
  consolidation problems. Gateway ownership code is landed, and automatic
  installed-app LaunchAgent repair has local proof.
- Stop saying Developer ID notarization remains open for `v2026.3.14`; the
  app and DMG were signed, notarized, stapled, and Gatekeeper accepted locally.
- Stop implying the final product is two apps: `OpenClaw` and
  `OpenClaw Consumer`.
- Stop treating the visible app rename as blocked. The visible rename is done;
  only bundle-id migration remains deferred.
