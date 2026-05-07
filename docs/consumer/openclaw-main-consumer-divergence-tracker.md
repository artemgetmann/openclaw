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
| Gateway ownership / port              | PR #620 open; local proof passed | Default gateway is canonical `ai.openclaw.gateway` on `18789`. #597 keeps the consumer-style app from stopping an already-healthy canonical gateway during attach/setup paths. #599 keeps watchdog recovery from killing a healthy `/healthz` gateway because a deep CLI/RPC probe is slow or noisy. #613 allows the packaged app entrypoint to own the gateway; #614 allows the packaged launchd context; #615 makes the app prefer the bundled runtime root over stale saved dev roots. #620 repairs stale installed-app LaunchAgents to the packaged runtime entrypoint.                                                                                                                                                 | Merge #620, then rebuild release artifacts from merged `main`.                                                 |
| LaunchAgent/service behavior          | PR #620 open; local proof passed | Shared service install/restart behavior and takeover guardrails are in `main`. #597 narrowed packaged app gateway install env handling so provider keys/tokens are not persisted into the LaunchAgent plist from auth-profile env refs. #620 repaired a stale `ai.openclaw.gateway` plist pointing at `/Users/user/Programming_Projects/openclaw/dist/index.js` while the legacy watchdog was running from `/Users/user/Programming_Projects/openclaw/scripts/gateway-watchdog.sh`; after replacement, the plist and loaded service `ProgramArguments[1]` pointed at `/Applications/OpenClaw.app/Contents/Resources/OpenClawRuntime/openclaw/dist/index.js`, and `launchctl` could not find `ai.openclaw.gateway-watchdog`. | Rebuild from merged `main` after #620 lands; do not claim full GUI smoke from this automation run.             |
| Consumer macOS shell parity           | Completed                        | Main has Consumer shell pieces: browser setup support/views, setup readiness, permissions, Telegram setup card/state/verifier, bootstrap, bundled runtime, helper bootstrap. Existing-user and isolated fresh-user app smokes passed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Keep future app/setup fixes in `main`.                                                                         |
| Update-safe setup resume              | Completed                        | Main has setup resume that skips onboarding only after browser, permissions, model, and Telegram checks pass. Real existing setup did not show onboarding in smoke; isolated fresh setup showed onboarding from clean state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Keep future setup fixes in `main`.                                                                             |
| Consumer packaging from main          | Local full package passed        | Main can build and verify a signed `OpenClaw.app` bundle from the sacred checkout. Codesign stale-signature failure was fixed. Packaging copies DMG/ZIP/dSYM ZIP handoff artifacts to the main checkout by default. Sparkle consumer release gates are in place. The PR #620 run passed `SKIP_NOTARIZE=1 ALLOW_DEFAULT_SPARKLE_KEY_FOR_CONSUMER_SMOKE=1 bash scripts/package-openclaw-mac-dist.sh`; DMG conversion passed and `hdiutil verify` checksum was valid.                                                                                                                                                                                                                                                          | After #620 lands, rebuild from merged `main`; public notarization/updater polish remains a separate follow-up. |
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
- #620: automatic packaged gateway LaunchAgent replacement repair (open)

## Queue Now

1. Merge #620, then rebuild release artifacts from merged `main` so artifact
   provenance includes the final code and docs.
2. Complete real Telegram first-task verification from the Channels tab.
3. Public release polish: Developer ID notarization and real Sparkle key/feed.

## Latest Local Smoke Truth

- PR: #620, open from `codex/main-consumer-packaged-launchagent-repair-20260506`
- Source commit for built artifact: `5ed9f8c841` before final doc/code commit
- Installed app: `/Applications/OpenClaw.app`
- App identity: `OpenClaw`, `ai.openclaw.consumer.mac`, variant `consumer`,
  version `2026.3.14`
- Current app-bundle artifact:
  - `/Users/user/Programming_Projects/openclaw/dist/OpenClaw.app`
- Handoff artifacts:
  - `/Users/user/Programming_Projects/openclaw/dist/consumer-handoff/OpenClaw.dmg`
  - `/Users/user/Programming_Projects/openclaw/dist/consumer-handoff/OpenClaw.zip`
  - `/Users/user/Programming_Projects/openclaw/dist/consumer-handoff/OpenClaw-2026.3.14.dSYM.zip`
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
  - `SKIP_NOTARIZE=1 ALLOW_DEFAULT_SPARKLE_KEY_FOR_CONSUMER_SMOKE=1 bash scripts/package-openclaw-mac-dist.sh`
    passed
  - DMG conversion passed
  - `hdiutil verify` checksum was valid
- Trust caveat: latest verified artifacts were built before the final PR #620
  doc/code commit. Release provenance requires a rebuild from merged `main`.

## Things We Should Stop Saying

- Stop saying consumer implementation work should target
  `codex/consumer-openclaw-project`.
- Stop treating runtime identity, macOS shell parity, or setup resume as open
  consolidation problems. Gateway ownership code is landed, and automatic
  installed-app LaunchAgent repair has local proof in open PR #620.
- Stop implying the final product is two apps: `OpenClaw` and
  `OpenClaw Consumer`.
- Stop treating the visible app rename as blocked. The visible rename is done;
  only bundle-id migration remains deferred.
