# OpenClaw Main + Consumer Consolidation Plan

> Retired as an active tracker on 2026-05-11. Consumer/main consolidation is
> completed for normal workflow: new consumer-product work targets `main`, and
> `openclaw-consumer` / `codex/consumer-openclaw-project` are legacy/emergency
> fallback only. Remaining launch and release work now lives in
> `docs/research/jarvis-consumer-launch-plan.md`. Keep this document as
> historical proof; do not use it as a live task board.

Last updated: 2026-05-11

## North Star

OpenClaw should ship as one product from `main`.

The old `openclaw-consumer` checkout and `codex/consumer-openclaw-project`
branch are now legacy safety nets, not the place for new product work. New
consumer launch work should start from current `origin/main`, use temporary
worktrees, and open PRs against `main`.

## Current Truth

The old PR #549 consolidation checkpoint is historical context only. The
reviewable consolidation slices have now landed through smaller PRs:

- #552: runtime / gateway identity foundation
- #553: shared skills root
- #554: Telegram tester/model guardrails
- #555: canonical gateway env hotfix
- #556: Consumer macOS app parity in `main`
- #557: update-safe setup resume
- #558: repeatable packaging codesign fix
- #572: preserve already-loaded gateway on app enable
- #573: keep canonical gateway listener instead of replacing it
- #574: suppress repeat Consumer setup on healthy existing installs
- #575: keep titled `openclaw-gateway` listener during delayed port sweeps
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
- #613: allow packaged app gateway ownership
- #614: allow packaged app launchd context
- #615: prefer bundled app runtime root
- #620: automatic packaged gateway LaunchAgent replacement repair
- #625: packaged gateway source-attach bypass repair
- #634: Channels tab first-task verifier auto-marks verified from recent live
  Telegram activity
- #638: LaunchAgent service-version drift repair
- #641: docs refresh for post-#634 consolidation truth
- #645: Telegram outbound bot reply activity telemetry
- #650: stale LaunchAgent entrypoint mismatch detection
- #651: preserve packaged runtime roots during gateway install/restart

The main-built consumer artifact now uses the visible product name
`OpenClaw.app` while preserving the consumer bundle id/runtime identity. The
bundle-id migration remains deliberately separate because changing it can reset
TCC permissions and update identity.

## Release Proof: v2026.3.15

The signed macOS release is real and public:

- release: <https://github.com/artemgetmann/openclaw/releases/tag/v2026.3.15>
- release tag target: `205d5f596602ff82270b1af5a3de24c33c32b532`
- assets: `OpenClaw.dmg`, `OpenClaw.zip`,
  `openclaw-consumer-appcast.xml`, `OpenClaw-2026.3.15.dSYM.zip`
- trust status: `OpenClaw.app` and `OpenClaw.dmg` were Developer ID signed,
  notarized, stapled, and accepted by Gatekeeper locally
- public appcast resolves to `v2026.3.15`

This proves the full DMG/ZIP packaging path from `main` completed for
`v2026.3.15`.

Installed-release smoke from the published `v2026.3.15` DMG passed. Sparkle
non-UI update completion from the public `v2026.3.14` build to `v2026.3.15`
passed through Sparkle's update installer path. The interactive Sparkle dialog
itself was not visually verified; that smoke stays optional/final.

PR #620 fixed automatic packaged gateway LaunchAgent replacement repair.
PR #625 fixed the remaining source-attach bypass where a packaged app could
accept a healthy gateway still carrying stale source-checkout runtime
environment. Local replacement proof started from a stale `ai.openclaw.gateway`
plist pointing at
`/Users/user/Programming_Projects/openclaw/dist/index.js`, with
`ai.openclaw.gateway-watchdog` running from
`/Users/user/Programming_Projects/openclaw/scripts/gateway-watchdog.sh`. After
replacing `/Applications/OpenClaw.app` with the rebuilt package, both the plist
and the loaded service `ProgramArguments[1]` pointed at
`/Applications/OpenClaw.app/Contents/Resources/OpenClawRuntime/openclaw/dist/index.js`.
The watchdog was unloaded; `launchctl` could not find
`ai.openclaw.gateway-watchdog`. `/healthz` returned
`{"ok":true,"status":"live"}` for 18 checks over 90 seconds.

GUI automation confirmed only the menu-bar `Stop AI Operator` state. The
SwiftUI Settings window did not expose a content window through automation, so
do not overclaim full visual GUI smoke from this run.

The public `v2026.3.15` artifacts are signed, notarized, stapled, and accepted
by Gatekeeper. A rebuilt branch artifact from
`fe05c860a87411709effdf83050c1bae2ad601cd` proved the post-#625 packaged
gateway repair locally before #625 was squash-merged. The public release is
anchored at `205d5f596602ff82270b1af5a3de24c33c32b532`, so keep provenance
claims tied to the published release rather than an older tag.

Latest consolidation-lane GUI truth: default-identity installed proof passed
from `849514bacc`. The bundle was built at `dist/OpenClaw.app`, copied to
`/Applications/OpenClaw.app`, and launched as `ai.openclaw.consumer.mac`.

The previous delay was a stale installed service, not a GUI blocker:
`ai.openclaw.gateway` initially kept
`ProgramArguments[1]=/Users/user/Programming_Projects/openclaw/dist/index.js`.
After app repair/CLI takeover, launchd rewrote the service to the packaged
runtime:
`/Applications/OpenClaw.app/Contents/Resources/OpenClawRuntime/openclaw/dist/index.js`.
`/healthz` on `127.0.0.1:18789` returned `{"ok":true,"status":"live"}`.

Computer Use works for the installed app. The Channels tab shows Telegram Live
and Telegram verified, including text that OpenClaw already finished a Telegram
task on this Mac. There is no remaining local GUI proof blocker.

The remaining public-release blocker is upload/provenance replacement, not local
packaging. A fresh signed/notarized/Sparkle recut completed locally from current
`main` at `1ec69a58fd441e1c63a91e5af4468fd6fe53f272`, with version
`2026.3.15` and build `2026031590`. The generated handoff artifacts are:

- `dist/release-handoff/OpenClaw.dmg`
- `dist/release-handoff/OpenClaw.zip`
- `dist/release-handoff/OpenClaw-2026.3.15.dSYM.zip`
- `dist/release-handoff/openclaw-consumer-appcast.xml`

App notarization was accepted as
`2110d556-1a8b-4f40-86af-ca32d404f0cd`; DMG notarization was accepted as
`ba1faf85-92aa-47d6-bd8d-dec0c669a636`. App and DMG stapling passed, and both
were accepted by Gatekeeper as Notarized Developer ID.

Do not claim the public GitHub release has this provenance until those assets
are explicitly uploaded/replaced on `v2026.3.15`.

After #579, new Consumer package runs also copy `.dmg`, `.zip`, and dSYM `.zip`
handoff artifacts to `dist/consumer-handoff` under the main checkout by default
when packaging is invoked from a temp worktree. Override with
`OPENCLAW_CONSUMER_DIST_HANDOFF_DIR`.

## Status Snapshot

| Area                                | Status                              | What is done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | What remains                                                                                                                                                                                                         |
| ----------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime identity / paths            | Completed                           | Runtime root, state/config/workspace/log paths, gateway label, and port behavior are shared in `main`. Default runtime is `~/Library/Application Support/OpenClaw/.openclaw`; gateway is `ai.openclaw.gateway` on `18789`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Keep future changes in shared runtime code. Do not recreate branch-specific runtime rules.                                                                                                                           |
| Gateway ownership / launch behavior | Local installed proof passed        | Shared gateway/service ownership is canonical in `main`, with takeover guardrails and canonical env fixes merged. #597 prevents the consumer app from stopping an already-healthy canonical gateway during setup/attach paths. #599 keeps watchdog recovery shallow. #613/#614 allow packaged app ownership and launchd context. #615 prefers the bundled runtime root. #620/#625/#638 repaired stale LaunchAgent, source-attach, and service-version drift cases. #650 fixed stale entrypoint mismatch detection, and #651 preserves packaged `OpenClawRuntime` roots for gateway install/restart and `OPENCLAW_FORK_ROOT`. Latest default-installed proof from `849514bacc` repaired `ai.openclaw.gateway` from source-checkout `ProgramArguments[1]` to `/Applications/OpenClaw.app/.../OpenClawRuntime/openclaw/dist/index.js`, and `/healthz` on `127.0.0.1:18789` returned live. Local notarized/Sparkle recut from `1ec69a58fd` now carries these fixes. | Replace/upload the public `v2026.3.15` assets from the verified handoff artifacts after explicit approval.                                                                                                           |
| Consumer macOS shell parity         | Completed                           | Consumer setup shell pieces were ported into `main`: browser setup, readiness, permissions, Telegram setup card/state/verifier, bundled runtime/bootstrap, and packaging entrypoints. Existing-user and isolated fresh-user smokes passed. #645 fixes Telegram outbound bot reply activity telemetry. Latest Computer Use proof showed the installed app's Channels tab with Telegram Live and Telegram verified, including text that OpenClaw already finished a Telegram task on this Mac.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Keep future app/setup fixes in `main`.                                                                                                                                                                               |
| Update-safe setup resume            | Completed                           | Existing installs can skip setup only after browser, permissions, model, and Telegram health checks pass. Broken configs resume to relevant blockers. Existing-user smoke confirmed setup did not repeat. Isolated fresh-user smoke confirmed first-run onboarding appears from clean state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Keep future setup fixes in `main`.                                                                                                                                                                                   |
| Packaging from main                 | Local recut complete for v2026.3.15 | `main` produced the signed/notarized public `v2026.3.15` release from `205d5f596602ff82270b1af5a3de24c33c32b532`; that public asset is now stale for latest provenance. A fresh local recut from `1ec69a58fd441e1c63a91e5af4468fd6fe53f272` produced `OpenClaw.dmg`, `OpenClaw.zip`, `openclaw-consumer-appcast.xml`, and `OpenClaw-2026.3.15.dSYM.zip` under `dist/release-handoff/`. App and DMG notarization passed, stapling passed, and Gatekeeper accepted both as Notarized Developer ID. Codesign retry and DMG conversion blockers are fixed. The canonical command remains `scripts/package-openclaw-mac-dist.sh`; `scripts/package-consumer-mac-dist.sh` remains a compatibility wrapper. Public DMG install smoke and deterministic Sparkle non-UI update completion passed for the currently published asset.                                                                                                                                      | Upload/replace public `v2026.3.15` release assets from the verified handoff set, then rerun public install/update smoke if distribution claims require it. Interactive Sparkle dialog visual proof remains optional. |
| App name / bundle identity          | Completed for visible name          | Release packaging now ships as `OpenClaw.app` / `OpenClaw.dmg` / `OpenClaw.zip` while preserving `ai.openclaw.consumer.mac`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Bundle-id migration needs a stronger reason and a migration plan.                                                                                                                                                    |
| `openclaw-consumer` retirement      | Completed for normal workflow       | `main` is now the target for new work. Consumer branch is no longer the default implementation surface. Existing-user and isolated fresh-user main-built app smokes passed. Older docs/workflows now label the old branch as historical or emergency-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Keep `openclaw-consumer` only as an emergency fallback.                                                                                                                                                              |
| Overlay/defaults contract           | Mostly completed                    | Core setup/runtime pieces are shared. Telegram `/model` now starts with Claude, ChatGPT, and More. Model labels were polished after live feedback: `GPT` is capitalized, duplicate/noisy ChatGPT entries are removed, and Claude family labels use product-facing names such as `Sonnet 4.6`. Fresh consumer configs get broad useful bundled skills by default, and model-facing skills remain visible when setup/auth is missing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Keep future onboarding presentation defaults explicit instead of scattering product conditionals. This is hygiene, not a release blocker.                                                                            |
| Docs / workflow cleanup             | Completed                           | Primary and older workflow docs now point normal consumer work at `main` and label `codex/consumer-openclaw-project` as historical or emergency-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Keep future docs aligned with the main-first workflow.                                                                                                                                                               |

## Retirement Gate

Retirement gate is complete for normal workflow:

- [x] Main-built app smoke passes for an existing user setup.
- [x] Main-built app smoke passes for an isolated fresh setup path.
- [x] Main full DMG/ZIP packaging completed for public release `v2026.3.15`.
- [x] New consumer/product work is documented to target `main` in primary and older workflow docs.
- [x] Conservative visible product rename to `OpenClaw.app` is implemented
      without changing runtime/gateway identity.

## Historical Implementation Slices Imported To Launch Plan

These items have been imported into
`docs/research/jarvis-consumer-launch-plan.md`. They remain below as proof and
background, not as this document's active queue.

### 1. Use the deterministic release lane for the final package

The manual release recut proved the flow, but it also exposed a workflow bug:
`notarytool submit --wait` can block the whole agent lane while Apple performs
server-side analysis. The release scripts now have deterministic release-env
loading plus explicit submit/poll/staple support; use that flow for the final
package instead of rediscovering credentials or blocking blindly. The default
auth path should be App Store Connect API key auth through `NOTARYTOOL_KEY`,
`NOTARYTOOL_KEY_ID`, and `NOTARYTOOL_ISSUER`; `NOTARYTOOL_PROFILE` is fallback
only. Artem still must create/provide the actual ASC API key if it is not
present locally.

Release env defaults to
`~/Library/Application Support/OpenClaw/release.env` for non-secret settings and
secret file pointers. Secrets stay outside Git and out of `~/.openclaw`; use
the release env to point at local key material rather than committing it.

### 2. Publish the verified final recut

PR #638 fixes the stale LaunchAgent `OPENCLAW_SERVICE_VERSION` env observed after
the public `v2026.3.14` -> `v2026.3.15` Sparkle update. #634 fixes the stale
Channels tab first-task verifier state, #645 fixes the outbound activity
telemetry gap, #650 fixes stale entrypoint mismatch detection, and #651 fixes
packaged runtime root preservation during gateway install/restart. A local
release recut from `1ec69a58fd441e1c63a91e5af4468fd6fe53f272` now includes
those fixes and passed notarization/Gatekeeper verification.

Public upload is deferred until the app work is done and final release approval
is explicit. Only then should a fresh `OpenClaw.dmg`, `OpenClaw.zip`,
`OpenClaw-2026.3.15.dSYM.zip`, and `openclaw-consumer-appcast.xml` replace the
public `v2026.3.15` assets. Until then, the public GitHub release still points
at the old `205d5f596602ff82270b1af5a3de24c33c32b532` asset provenance.

### 3. Interactive Sparkle UI smoke

Sparkle update completion from the public `v2026.3.14` build to `v2026.3.15`
passed through a deterministic non-UI Sparkle proof. The remaining dialog-path
smoke is optional/final, only if the product claim needs that exact UI.

### 4. Launch audit handoff

Keep the commercial spine open as a separate launch audit: account/trial/license
state, backend-managed surfaces, bundled secrets/config audit, and public
package audit. This is likely owned by the main/pane-6 launch plan, not this
release-automation slice.

### 5. Overlay/defaults hygiene

Keep future onboarding presentation defaults explicit instead of scattering
product conditionals. This cleanup is useful, but it is non-urgent hygiene and
not a release blocker.

## Completed Implementation Slices

### Automatic packaged LaunchAgent repair

The replaced `/Applications/OpenClaw.app` now repairs the canonical
`ai.openclaw.gateway` LaunchAgent to the packaged runtime entrypoint on first
launch. #625 also prevents the packaged app from accepting a healthy
source-checkout owned gateway when the persisted launchd environment still
points at the source runtime. The proven entrypoint is:

- `/Applications/OpenClaw.app/Contents/Resources/OpenClawRuntime/openclaw/dist/index.js`

The stale pre-repair state pointed at
`/Users/user/Programming_Projects/openclaw/dist/index.js` and had the legacy
`ai.openclaw.gateway-watchdog` loaded from
`/Users/user/Programming_Projects/openclaw/scripts/gateway-watchdog.sh`. After
replacement, the plist and loaded service pointed at the packaged entrypoint,
the watchdog was absent from `launchctl`, and `/healthz` returned
`{"ok":true,"status":"live"}` for 18 checks over 90 seconds.

Status: #620 and #625 are merged to `main`. Local post-#625 proof passed from
branch artifact `fe05c860a87411709effdf83050c1bae2ad601cd`; a public artifact
rebuilt from merge commit `5ce43d8538e223db4390733c01611f0684d12541` or newer
remains the release-lane responsibility.

### Real Telegram first-task behavioral verification

A live Telegram DM proof passed against `@Jarvis_cl4w_bot`:

- sent token: `FIRSTTASK-20260508T062445Z`
- sent message id: `48670`
- matched reply id: `48671`
- reply text: `OK FIRSTTASK-20260508T062445Z`

Status: behavioral Telegram request/response gate complete. The exact SwiftUI
Channels tab path has merged code fixes in #634 and #645. Latest Computer Use
proof from installed default app commit `849514bacc` showed Telegram Live and
Telegram verified, with text that OpenClaw already finished a Telegram task on
this Mac.

### Full distribution packaging repair

The full distribution package path now completes from `main`. DMG conversion
passed, `hdiutil verify` checksum was valid, and `.dmg`, `.zip`, and dSYM
`.zip` artifacts were copied to
`/Users/user/Programming_Projects/openclaw/dist/consumer-handoff`.

Status: completed for public release `v2026.3.15` from
`205d5f596602ff82270b1af5a3de24c33c32b532`.

### Published `v2026.3.15` installed-release smoke

The published GitHub `v2026.3.15` DMG installed over `/Applications/OpenClaw.app`
and passed the isolated fresh-user smoke:

- public DMG: `https://github.com/artemgetmann/openclaw/releases/download/v2026.3.15/OpenClaw.dmg`
- installed app: version `2026.3.15`, build `2026031590`, commit `205d5f5966`
- trust: DMG and installed app accepted by Gatekeeper as Notarized Developer ID
- gateway: loaded `ai.openclaw.gateway` pointed at `/Applications/OpenClaw.app/Contents/Resources/OpenClawRuntime/openclaw/dist/index.js`
- health: `/healthz` returned `{"ok":true,"status":"live"}`
- smoke: `fresh_user_smoke=passed`, `onboarding_window=observed`, `real_user_config_unchanged=yes`

Status: public installed-release smoke passed. Sparkle update completion passed
through the deterministic non-UI installer proof.

### Sparkle update completion proof

The public `v2026.3.14` app updated to public `v2026.3.15` through Sparkle's
non-UI installer path:

- start: public `v2026.3.14` DMG installed `/Applications/OpenClaw.app` at version `2026.3.14`, build `2026031490`, commit `41f2868ad7`
- feed: `https://github.com/artemgetmann/openclaw/releases/latest/download/openclaw-consumer-appcast.xml`
- update: Sparkle found `2026.3.15`, downloaded the `539310484` byte `OpenClaw.zip` enclosure, extracted to 100%, printed `Installing Update...`, then `Installation Finished. Exiting.`
- result: `/Applications/OpenClaw.app` became version `2026.3.15`, build `2026031590`, commit `205d5f5966`
- trust: updated app remained accepted as Notarized Developer ID
- runtime: launch brought `/healthz` back live with `{"ok":true,"status":"live"}`
- launchd: loaded `ai.openclaw.gateway` `ProgramArguments[1]` pointed at `/Applications/OpenClaw.app/Contents/Resources/OpenClawRuntime/openclaw/dist/index.js`

Caveat from the public `v2026.3.15` artifact: the loaded launchd environment
still reported `OPENCLAW_SERVICE_VERSION => 2026.3.14` after the update, even
though the loaded entrypoint and installed app were `v2026.3.15`. #638 fixes
that repair predicate in `main`; a new artifact is still required before the
fix ships to users.

Status: deterministic Sparkle update completion passed. Interactive Sparkle UI
dialog visual proof remains optional/open.

### Model and skill defaults

Telegram `/model` starts with consumer-friendly families: Claude, ChatGPT, More.
Claude and ChatGPT open family screens with the recommended model first and a
family-level More button for variants. Top-level More opens the full provider
browser for raw providers such as Anthropic, OpenAI/OpenAI Codex, Claude Bridge,
Google/Gemini, Kimi/Moonshot/Minimax, and other configured providers.

Bundled skills stay model-facing even when setup is missing. Missing auth,
config, or binaries should route the model toward setup/explanation instead of
hiding useful capability hints. Fresh consumer configs include `consumer-setup`,
`apple-notes`, `apple-reminders`, `gog`, `goplaces`, `himalaya`, `peekaboo`,
`summarize`, `weather`, `wacli`, `mcporter`, `nano-banana-pro`, `telegram-user`,
`notion`, `obsidian`, `things-mac`, `github`, `slack`, `discord`,
`openai-image-gen`, `openai-whisper`, and `nano-pdf`.

Status: completed for the current model/skill default slice by #592 and #594.
If the live Jarvis bot still shows stale model rows, treat that as runtime
deployment/config state, not an open consolidation-plan question.

### Conservative `OpenClaw.app` product rename

Release packaging now uses the visible product name `OpenClaw.app` /
`OpenClaw.dmg` / `OpenClaw.zip` while preserving the current consumer bundle id
and runtime identity.

Status: completed by #588.

### Packaging wrapper cleanup

Promote `scripts/package-openclaw-mac-dist.sh` as the canonical main-built
shipping command while keeping `scripts/package-consumer-mac-dist.sh` as a
compatibility wrapper for old automation.

Status: completed by #590.

Why this matters:

- The product should no longer look like a forked second app.
- Keeping the existing bundle id avoids turning a visible rename into a
  permissions/state migration.

### Docs / workflow source-of-truth cleanup

Update `CONSUMER.md`, workflow docs, and older consumer execution docs so agents
stop targeting `openclaw-consumer` or `codex/consumer-openclaw-project` for new
P0 work.

Status: completed. Stale branch-era execution docs are preserved as historical
context and now point normal work at `main`.

Completed by #584.

Why this matters:

- Stale docs create duplicated implementation lanes.
- Agents will keep redoing branch-era work if the docs still say the old branch
  is the product branch.

### Main-built app smoke

Run the main-built app in a fresh local user/profile or equivalent isolated
state. Prove the onboarding path still works from zero.

Why this is first now:

- Existing-user setup preservation already passed.
- Fresh-user setup is the remaining branch-retirement gate.

Status: completed by #580. True separate macOS account validation still requires
manual admin/password-driven setup; the automated harness uses fake home,
isolated instance id, isolated gateway label, and isolated port.

### Packaging handoff cleanup

Change the packaging command so the blessed distributable lands in the sacred
`/Users/user/Programming_Projects/openclaw` handoff directory automatically,
not only under the worktree-local `dist/` directory.

Why this matters:

- Humans should not have to remember which temporary worktree produced the DMG.
- The shipping artifact should live in the canonical main checkout by default.

Status: completed by #579 for `.dmg`, `.zip`, and dSYM `.zip` handoff copies.

### Packaged app gateway/setup preservation

Fix the packaged app path so attaching the consumer-style `OpenClaw.app` to an
existing healthy setup does not tear down the canonical gateway, persist
secret-looking provider env vars into the LaunchAgent plist, or trigger watchdog
recovery loops.

Status: completed by #597 and #599. Earlier packaged replacement proof kept the
canonical gateway healthy on `/healthz` for 90 seconds; #620 extends that path
to automatic stale LaunchAgent repair during replacement installs.

## Guardrails

- Do not target `openclaw-consumer` for new work unless we explicitly declare an
  emergency backport.
- Do not change the consumer bundle id without a separate migration plan.
- Do not run old `OpenClaw.app` and a new main-built app as if side-by-side is
  automatically safe; verify gateway/runtime ownership first.
- Do not count docs cleanup as product progress unless it prevents real branch
  drift or follows landed code.
