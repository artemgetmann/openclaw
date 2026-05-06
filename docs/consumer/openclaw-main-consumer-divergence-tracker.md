# OpenClaw Main / Consumer Divergence Tracker

Last updated: 2026-05-06

This tracker exists to prevent redoing consolidation work that already landed.
If a slice is marked completed here, future agents should treat it as `main`
truth and build on it instead of reopening branch-era design debates.

## Rule Now

New consumer/product work targets `main`.

`/Users/user/Programming_Projects/openclaw-consumer` and
`codex/consumer-openclaw-project` are legacy/emergency fallback surfaces. They
are not the default place to implement P0 launch work.

## Divergence Table

| Category                              | Status                                | Current truth in `main`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Remaining action                                                                                                                                |
| ------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime identity / paths              | Completed                             | Shared runtime identity is in `main`; default state root is `~/Library/Application Support/OpenClaw/.openclaw`.                                                                                                                                                                                                                                                                                                                                                                           | Keep future runtime/path changes shared.                                                                                                        |
| Gateway ownership / port              | Mostly completed                      | Default gateway is canonical `ai.openclaw.gateway` on `18789`. #597 keeps the consumer-style app from stopping an already-healthy canonical gateway during attach/setup paths. #599 keeps watchdog recovery from killing a healthy `/healthz` gateway because a deep CLI/RPC probe is slow or noisy. #613 allows the packaged app entrypoint to own the gateway; #614 allows the packaged launchd context; #615 makes the app prefer the bundled runtime root over stale saved dev roots. | Fix automatic first-launch LaunchAgent repair so replacement installs pin the gateway to the packaged app entrypoint without manual CLI repair. |
| LaunchAgent/service behavior          | Mostly completed                      | Shared service install/restart behavior and takeover guardrails are in `main`. #597 narrowed packaged app gateway install env handling so provider keys/tokens are not persisted into the LaunchAgent plist from auth-profile env refs. The repaired local app can run the gateway from `/Applications/OpenClaw.app/Contents/Resources/OpenClawRuntime/openclaw/dist/index.js`.                                                                                                           | First launch of the replaced app still left a stale source-checkout LaunchAgent until manual packaged CLI install and app restart.              |
| Consumer macOS shell parity           | Completed                             | Main has Consumer shell pieces: browser setup support/views, setup readiness, permissions, Telegram setup card/state/verifier, bootstrap, bundled runtime, helper bootstrap. Existing-user and isolated fresh-user app smokes passed.                                                                                                                                                                                                                                                     | Keep future app/setup fixes in `main`.                                                                                                          |
| Update-safe setup resume              | Completed                             | Main has setup resume that skips onboarding only after browser, permissions, model, and Telegram checks pass. Real existing setup did not show onboarding in smoke; isolated fresh setup showed onboarding from clean state.                                                                                                                                                                                                                                                              | Keep future setup fixes in `main`.                                                                                                              |
| Consumer packaging from main          | App bundle passes; DMG follow-up open | Main can build and verify a signed `OpenClaw.app` bundle from the sacred checkout. Codesign stale-signature failure was fixed. Packaging copies DMG/ZIP/dSYM ZIP handoff artifacts to the main checkout by default. Sparkle consumer release gates are in place. The latest full distribution run failed late during DMG conversion with `hdiutil: convert failed - No such file or directory`.                                                                                           | Fix/retry full DMG/ZIP/dSYM packaging from current `origin/main`; public notarization/updater polish remains a separate follow-up.              |
| App rename to `OpenClaw.app`          | Completed                             | Release packaging now ships the visible product as `OpenClaw.app` / `OpenClaw.dmg` / `OpenClaw.zip`.                                                                                                                                                                                                                                                                                                                                                                                      | Keep old `OpenClaw Consumer` references only where they describe history or debug compatibility.                                                |
| Bundle id / TCC migration             | Deferred                              | Current Consumer bundle identity is preserved for continuity.                                                                                                                                                                                                                                                                                                                                                                                                                             | Decide separately from visible rename. Changing bundle id can reset permissions and create support churn.                                       |
| `openclaw-consumer` branch retirement | Completed                             | Main has the code needed to stop using the consumer checkout for new implementation. Existing-user and isolated fresh-user main-built smokes passed. Older docs/workflows now label the old branch as historical or emergency-only.                                                                                                                                                                                                                                                       | Keep fallback available only for emergency recovery.                                                                                            |
| Consumer packaging wrappers           | Completed                             | `scripts/package-openclaw-mac-dist.sh` is the canonical main-built shipping command. `scripts/package-consumer-mac-dist.sh` remains as a compatibility wrapper for old automation.                                                                                                                                                                                                                                                                                                        | Keep compatibility wrapper behavior unless a later cleanup deliberately removes it.                                                             |
| Overlay/defaults policy               | Mostly completed                      | Core runtime/setup is shared. Telegram `/model` starts with Claude, ChatGPT, and More. #592 added the simplified family-first picker; #594 polished labels after live feedback by capitalizing `GPT`, removing duplicate/noisy ChatGPT rows, and using product-facing Claude labels such as `Sonnet 4.6`. Fresh consumer configs get broad useful bundled skills by default, and model-facing skills remain visible when setup/auth/bins are missing.                                     | Keep future onboarding presentation defaults explicit instead of scattering product conditionals.                                               |
| Branch/workflow docs                  | Completed                             | Primary and older workflow docs now target `main` for consumer/product work and treat `openclaw-consumer` as historical or legacy/emergency fallback.                                                                                                                                                                                                                                                                                                                                     | Keep future docs aligned with the main-first workflow.                                                                                          |

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

## Queue Now

1. Fix automatic installed-app LaunchAgent repair so `/Applications/OpenClaw.app`
   pins `ai.openclaw.gateway` to the packaged app runtime without manual CLI
   repair.
2. Fix/retry full DMG/ZIP/dSYM packaging from current `origin/main`; the latest
   full run failed late during DMG conversion.
3. Complete real Telegram first-task verification from the Channels tab.
4. Investigate `/healthz` liveness jitter only if it repeats; the latest
   post-repair hold was mostly live but had one transient timeout.
5. Public release polish: Developer ID notarization and real Sparkle key/feed.

## Latest Local Smoke Truth

- Source commit: `41f2868ad7`
- Installed app: `/Applications/OpenClaw.app`
- App identity: `OpenClaw`, `ai.openclaw.consumer.mac`, variant `consumer`
- Current app-bundle artifact:
  - `/Users/user/Programming_Projects/openclaw/dist/OpenClaw.app`
- Visible GUI parity after manual repair:
  - `Stop AI Operator` visible
  - `Launch at login` checked
  - `Show Dock icon` checked
  - AI access ready
  - Channels shows configured Telegram only
- Gateway proof after manual repair:
  - `ai.openclaw.gateway` runs from the packaged app entrypoint
  - `/healthz` stayed live for most of a 60-second hold, with one transient
    timeout
- Trust caveat: latest verified app bundle is Developer ID signed but not
  notarized. Full DMG/ZIP handoff is not refreshed from this final state yet.
- Replacement caveat: first launch did not automatically repair the stale
  LaunchAgent; manual packaged CLI install plus app restart was required.

## Things We Should Stop Saying

- Stop saying consumer implementation work should target
  `codex/consumer-openclaw-project`.
- Stop treating runtime identity, macOS shell parity, or setup resume as open
  consolidation problems. Gateway ownership code is mostly landed, but
  automatic installed-app LaunchAgent repair remains open.
- Stop implying the final product is two apps: `OpenClaw` and
  `OpenClaw Consumer`.
- Stop treating the visible app rename as blocked. The visible rename is done;
  only bundle-id migration remains deferred.
