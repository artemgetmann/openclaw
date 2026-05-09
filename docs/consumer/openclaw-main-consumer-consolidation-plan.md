# OpenClaw Main + Consumer Consolidation Plan

Last updated: 2026-05-09

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

The main-built consumer artifact now uses the visible product name
`OpenClaw.app` while preserving the consumer bundle id/runtime identity. The
bundle-id migration remains deliberately separate because changing it can reset
TCC permissions and update identity.

## Release Proof: v2026.3.15

The signed macOS release is real and public:

- release: https://github.com/artemgetmann/openclaw/releases/tag/v2026.3.15
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
itself was not visually verified.

PR #620 fixed automatic packaged gateway LaunchAgent replacement repair. PR
#625 then fixed the remaining source-attach bypass where a packaged app could
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

Latest consolidation-lane GUI truth: installed-app Channels tab proof is
blocked at the packaged-entrypoint gate. PR #645 is open at
`https://github.com/artemgetmann/openclaw/pull/645`; the branch and installed
local app both report commit `15e000a19c`.

The first local rebuild/relaunch used isolated instance `gui-verify-20260508`.
It built and launched `dist/OpenClaw (gui-verify-20260508).app` at
`fd441d6135`, and `/healthz` on `39388` eventually returned live. That was the
wrong GUI proof target: the isolated config had no Telegram config, and its
LaunchAgent used a source-checkout entrypoint. Do not count it as a product
pass.

A default-identity current-main bundle was then built at `dist/OpenClaw.app`
and copied over `/Applications/OpenClaw.app`. The installed app reported
`OpenClawGitCommit` `fd441d6135` and bundle id
`ai.openclaw.consumer.mac`. This was a local smoke replacement, not
notarized/public release provenance. The default `ai.openclaw.gateway`
LaunchAgent pointed at
`/Applications/OpenClaw.app/Contents/Resources/OpenClawRuntime/openclaw/dist/index.js`,
and `/healthz` on `18789` returned `{"ok":true,"status":"live"}`.

Computer Use then showed the Channels tab still at `Telegram, Verify first
task` and `One task left`. Treat this as a FAIL for the installed-app GUI path.
Root-cause evidence from `channels status --json`: the default Telegram account
remained running/configured, but `lastInboundAt=1778243885824` and
`lastOutboundAt=1778236247270`, so outbound was older than inbound by about
`-7638554ms`. The GUI auto-verify code correctly refused to promote when
outbound was older than inbound. The root cause was Telegram bot replies
bypassing `sendMessageTelegram`, so successful auto-replies did not record
outbound channel activity into `lastOutboundAt`.

Live Telegram proof still passed against `@Jarvis_cl4w_bot`: sent
`OK GUIVERIFY-20260508T122756Z` as message `48740` and received bot reply
`OK GUIVERIFY-20260508T122756Z` as message `48741`. Channel status still did
not advance `lastOutboundAt`.

Local fix in PR #645: `extensions/telegram/src/bot/delivery.replies.ts` records
outbound activity once after a reply payload is delivered.
`extensions/telegram/src/bot/delivery.test.ts` proves successful
`deliverReplies` records outbound activity for `accountId`, while failed sends
do not. Focused proof after rebase passed:
`pnpm exec vitest run --config vitest.config.ts extensions/telegram/src/bot/delivery.test.ts src/infra/channel-activity.test.ts`
= 2 files / 37 tests passed, plus `git diff --check origin/main..HEAD`.

Post-PR-open packaged proof did not reach the Channels tab gate. The first
branch-isolated debug app built
`dist/OpenClaw (consolidation-gui-smoke-20260508).app` with bundle id
`ai.openclaw.consumer.mac.debug.consolidation-gui-smoke-20260508` on port
`24529`, but Gatekeeper rejected it because it was unnotarized, and it was the
wrong default-product target. The default bundle was then built as
`dist/OpenClaw.app`, copied to `/Applications/OpenClaw.app`, and the installed
app plist reported `OpenClawGitCommit=15e000a19c`, bundle id
`ai.openclaw.consumer.mac`, variant `consumer`. `/Applications/OpenClaw.app`
was running, but `launchctl print gui/$(id -u)/ai.openclaw.gateway` still showed
`ProgramArguments[1]` as `/Users/user/Programming_Projects/openclaw/dist/index.js`
and `OPENCLAW_MAIN_REPO=/Users/user/Programming_Projects/openclaw`. `/healthz`
on `18789` was live, but it proved the source-checkout runtime, not the
packaged runtime at
`/Applications/OpenClaw.app/Contents/Resources/OpenClawRuntime/openclaw/dist/index.js`.
Do not claim Channels GUI pass until the LaunchAgent repairs to the packaged
entrypoint and the installed-app Channels smoke passes.

Sparkle live update-path verification and notarized public release rebuild are
owned by the separate Sparkle/release lane. Do not duplicate that work from this
consolidation lane.

After #579, new Consumer package runs also copy `.dmg`, `.zip`, and dSYM `.zip`
handoff artifacts to `dist/consumer-handoff` under the main checkout by default
when packaging is invoked from a temp worktree. Override with
`OPENCLAW_CONSUMER_DIST_HANDOFF_DIR`.

## Status Snapshot

| Area                                | Status                        | What is done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | What remains                                                                                      |
| ----------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Runtime identity / paths            | Completed                     | Runtime root, state/config/workspace/log paths, gateway label, and port behavior are shared in `main`. Default runtime is `~/Library/Application Support/OpenClaw/.openclaw`; gateway is `ai.openclaw.gateway` on `18789`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Keep future changes in shared runtime code. Do not recreate branch-specific runtime rules.        |
| Gateway ownership / launch behavior | Completed                     | Shared gateway/service ownership is canonical in `main`, with takeover guardrails and canonical env fixes merged. #597 prevents the consumer app from stopping an already-healthy canonical gateway during setup/attach paths. #599 keeps the watchdog health probe shallow so a healthy `/healthz` gateway is not killed by an overly deep CLI/RPC probe. #613 and #614 allow the packaged app entrypoint and packaged launchd context to manage the canonical gateway. #615 makes the app prefer its bundled runtime root over stale saved dev roots. #620 repairs stale installed-app LaunchAgents to the packaged runtime entrypoint and unloads the legacy watchdog. #625 rejects source-checkout owned gateway state when the packaged app needs to own the runtime. #638 repairs stale `OPENCLAW_SERVICE_VERSION` LaunchAgent env after app updates by treating version drift as an install-repair signal. Public `v2026.3.15` installed-release smoke passed with `/Applications/OpenClaw.app` at commit `205d5f5966`, LaunchAgent `ProgramArguments[1]` pointing at the packaged runtime, and `/healthz` live. | Recut the next artifact from `main` before claiming the service-version repair ships publicly.    |
| Consumer macOS shell parity         | Completed                     | Consumer setup shell pieces were ported into `main`: browser setup, readiness, permissions, Telegram setup card/state/verifier, bundled runtime/bootstrap, and packaging entrypoints. Existing-user main-built app smoke passed. Isolated fresh-user smoke passed. Local current-main replacement at `fd441d6135` proved packaged runtime ownership and live `/healthz`, but the Channels tab still failed to auto-verify because `lastOutboundAt` did not advance after a real bot reply. PR #645 now records outbound activity after successful reply delivery and focused tests passed after rebase. Post-PR-open default installed app at `15e000a19c` is running, but LaunchAgent stayed on the source-checkout runtime, so installed-app GUI proof is blocked before the Channels tab.                                                                                                                                                                                                                                                                                                                            | Fix/prove LaunchAgent repair to the packaged entrypoint, then rerun GUI Channels smoke.           |
| Update-safe setup resume            | Completed                     | Existing installs can skip setup only after browser, permissions, model, and Telegram health checks pass. Broken configs resume to relevant blockers. Existing-user smoke confirmed setup did not repeat. Isolated fresh-user smoke confirmed first-run onboarding appears from clean state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Keep future setup fixes in `main`.                                                                |
| Packaging from main                 | Completed for v2026.3.15      | `main` produced the signed/notarized `v2026.3.15` release from `205d5f596602ff82270b1af5a3de24c33c32b532`. Codesign retry and DMG conversion blockers are fixed. The canonical command is `scripts/package-openclaw-mac-dist.sh`; `scripts/package-consumer-mac-dist.sh` remains a compatibility wrapper. GitHub release assets are `OpenClaw.dmg`, `OpenClaw.zip`, `openclaw-consumer-appcast.xml`, and `OpenClaw-2026.3.15.dSYM.zip`. The public appcast resolves to `v2026.3.15`. Public DMG install smoke passed from the GitHub asset. Sparkle non-UI update completion from `v2026.3.14` to `v2026.3.15` passed and the updated app launched with a live packaged gateway.                                                                                                                                                                                                                                                                                                                                                                                                                                        | Interactive Sparkle dialog visual proof remains open if product claims require the exact UI path. |
| App name / bundle identity          | Completed for visible name    | Release packaging now ships as `OpenClaw.app` / `OpenClaw.dmg` / `OpenClaw.zip` while preserving `ai.openclaw.consumer.mac`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Bundle-id migration needs a stronger reason and a migration plan.                                 |
| `openclaw-consumer` retirement      | Completed for normal workflow | `main` is now the target for new work. Consumer branch is no longer the default implementation surface. Existing-user and isolated fresh-user main-built app smokes passed. Older docs/workflows now label the old branch as historical or emergency-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Keep `openclaw-consumer` only as an emergency fallback.                                           |
| Overlay/defaults contract           | Mostly completed              | Core setup/runtime pieces are shared. Telegram `/model` now starts with Claude, ChatGPT, and More. Model labels were polished after live feedback: `GPT` is capitalized, duplicate/noisy ChatGPT entries are removed, and Claude family labels use product-facing names such as `Sonnet 4.6`. Fresh consumer configs get broad useful bundled skills by default, and model-facing skills remain visible when setup/auth is missing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Keep future onboarding presentation defaults explicit instead of scattering product conditionals. |
| Docs / workflow cleanup             | Completed                     | Primary and older workflow docs now point normal consumer work at `main` and label `codex/consumer-openclaw-project` as historical or emergency-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Keep future docs aligned with the main-first workflow.                                            |

## Retirement Gate

Do not fully retire `openclaw-consumer` until all of these are true:

- [x] Main-built app smoke passes for an existing user setup.
- [x] Main-built app smoke passes for an isolated fresh setup path.
- [x] Main full DMG/ZIP packaging completed for public release `v2026.3.15`.
- [x] New consumer/product work is documented to target `main` in primary and older workflow docs.
- [x] Conservative visible product rename to `OpenClaw.app` is implemented
      without changing runtime/gateway identity.

## Next Implementation Slices

### 1. Repair packaged-entrypoint takeover and rerun Channels tab smoke

The telemetry root cause is fixed in PR #645 and focused tests pass after
rebase. The default installed app at `15e000a19c` launches, but the
`ai.openclaw.gateway` LaunchAgent stayed on the source-checkout runtime. Fix or
prove packaged LaunchAgent repair first, then rerun the Computer Use Channels
tab smoke. Do not claim installed-app GUI proof until the LaunchAgent entrypoint
is packaged and the Channels tab auto-promotes after a live Telegram bot reply.

### 2. Recut from post-#638/#634 `main`

#638 fixes the stale LaunchAgent `OPENCLAW_SERVICE_VERSION` env observed after
the public `v2026.3.14` -> `v2026.3.15` Sparkle update. #634 fixes the stale
Channels tab first-task verifier state, and PR #645 fixes the outbound activity
telemetry gap. The already-published `v2026.3.15` artifacts do not contain
#638/#634/#645, and public artifacts must be recut from `main` after #645 merges
and after the LaunchAgent/default installed-app proof issue is handled.

### 3. Interactive Sparkle UI smoke

Sparkle update completion from the public `v2026.3.14` build to `v2026.3.15`
passed through a deterministic non-UI Sparkle proof. The remaining optional gate
is observing the literal Sparkle dialog path if the product claim requires that
exact UI.

### 4. Account, license, backend, and public package audit

Keep the commercial spine open: account/trial/license state, backend-managed
surfaces, bundled secrets/config audit, and public package audit before broader
distribution.

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
Channels tab path has a merged code fix in #634, validated by
`swift test --filter TelegramSetupBootstrapTests`,
`swift test --filter ConsumerSetupResumeTests`, and `git diff --check`.
The first installed-app GUI smoke failed because channel status did not record
the bot reply into `lastOutboundAt`. PR #645 records outbound activity after
successful reply delivery and focused tests pass. The latest default installed
app at `15e000a19c` is blocked earlier because LaunchAgent stayed on the
source-checkout runtime. Do not claim installed-app GUI proof until the
LaunchAgent points at the packaged runtime and the Channels tab auto-promotes.

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
`summarize`, `weather`, `wacli`, `nano-banana-pro`, `telegram-user`, `notion`,
`obsidian`, `things-mac`, `github`, `slack`, `discord`, `openai-image-gen`,
`openai-whisper`, and `nano-pdf`.

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
