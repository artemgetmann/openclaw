# OpenClaw Main + Consumer Consolidation Plan

Last updated: 2026-05-08

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

The main-built consumer artifact now uses the visible product name
`OpenClaw.app` while preserving the consumer bundle id/runtime identity. The
bundle-id migration remains deliberately separate because changing it can reset
TCC permissions and update identity.

## Release Proof: v2026.3.14

The signed macOS release is real and public:

- release: https://github.com/artemgetmann/openclaw/releases/tag/v2026.3.14
- release tag target: `41f2868ad7a2f174aad7e385f0c28efe81f816c0`
- assets: `OpenClaw.dmg`, `OpenClaw.zip`,
  `openclaw-consumer-appcast.xml`, `OpenClaw-2026.3.14.dSYM.zip`
- handoff: copied to
  `/Users/user/Programming_Projects/openclaw/dist/consumer-handoff/`
- trust status: `OpenClaw.app` and `OpenClaw.dmg` were Developer ID signed,
  notarized, stapled, and accepted by Gatekeeper locally

This proves the full DMG/ZIP packaging path from `main` completed for
`v2026.3.14`. It does not mean the release tag is current `main` HEAD. The
release is anchored at `41f2868ad7a2f174aad7e385f0c28efe81f816c0`; `main`
advanced afterward, including #622 at
`bed0de66fd3011b9c8a2d4f63b0ac59a9ef1b0a1`, #620, and the later #625 merge at
`5ce43d8538e223db4390733c01611f0684d12541`.

The installed release app reports:

- display name: `OpenClaw`
- bundle id: `ai.openclaw.consumer.mac`
- variant: `consumer`
- version: `2026.3.14`
- git commit: `41f2868ad7a2f174aad7e385f0c28efe81f816c0`

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

The public release no longer needs Developer ID notarization for the
`v2026.3.14` artifacts; that gate passed. A rebuilt branch artifact from
`fe05c860a87411709effdf83050c1bae2ad601cd` proved the post-#625 packaged
gateway repair locally before #625 was squash-merged. Because the final merge
commit is `5ce43d8538e223db4390733c01611f0684d12541`, the next public artifact
must be rebuilt from current `main` before making final public provenance
claims.

Real Telegram behavioral verification is complete: a live DM to
`@Jarvis_cl4w_bot` sent `FIRSTTASK-20260508T062445Z` and received
`OK FIRSTTASK-20260508T062445Z` from the bot in the same DM. This proves the
actual Telegram request/response path. The literal SwiftUI Channels tab button
was not visually clicked, so keep GUI wording precise.

Sparkle live update-path verification and notarized public release rebuild are
owned by the separate Sparkle/release lane. Do not duplicate that work from this
consolidation lane.

After #579, new Consumer package runs also copy `.dmg`, `.zip`, and dSYM `.zip`
handoff artifacts to `dist/consumer-handoff` under the main checkout by default
when packaging is invoked from a temp worktree. Override with
`OPENCLAW_CONSUMER_DIST_HANDOFF_DIR`.

## Status Snapshot

| Area                                | Status                        | What is done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | What remains                                                                                                                                          |
| ----------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime identity / paths            | Completed                     | Runtime root, state/config/workspace/log paths, gateway label, and port behavior are shared in `main`. Default runtime is `~/Library/Application Support/OpenClaw/.openclaw`; gateway is `ai.openclaw.gateway` on `18789`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Keep future changes in shared runtime code. Do not recreate branch-specific runtime rules.                                                            |
| Gateway ownership / launch behavior | Completed                     | Shared gateway/service ownership is canonical in `main`, with takeover guardrails and canonical env fixes merged. #597 prevents the consumer app from stopping an already-healthy canonical gateway during setup/attach paths. #599 keeps the watchdog health probe shallow so a healthy `/healthz` gateway is not killed by an overly deep CLI/RPC probe. #613 and #614 allow the packaged app entrypoint and packaged launchd context to manage the canonical gateway. #615 makes the app prefer its bundled runtime root over stale saved dev roots. #620 repairs stale installed-app LaunchAgents to the packaged runtime entrypoint and unloads the legacy watchdog. #625 rejects source-checkout owned gateway state when the packaged app needs to own the runtime. Local post-#625 replacement proof passed from branch artifact `fe05c860a87411709effdf83050c1bae2ad601cd`. | Rebuild and smoke the next public artifact from `main` at `5ce43d8538e223db4390733c01611f0684d12541` or newer before final public provenance claims.  |
| Consumer macOS shell parity         | Completed                     | Consumer setup shell pieces were ported into `main`: browser setup, readiness, permissions, Telegram setup card/state/verifier, bundled runtime/bootstrap, and packaging entrypoints. Existing-user main-built app smoke passed. Isolated fresh-user smoke passed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Keep future setup/app fixes in `main`.                                                                                                                |
| Update-safe setup resume            | Completed                     | Existing installs can skip setup only after browser, permissions, model, and Telegram health checks pass. Broken configs resume to relevant blockers. Existing-user smoke confirmed setup did not repeat. Isolated fresh-user smoke confirmed first-run onboarding appears from clean state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Keep future setup fixes in `main`.                                                                                                                    |
| Packaging from main                 | Completed for v2026.3.14      | `main` produced the signed/notarized `v2026.3.14` release from `41f2868ad7a2f174aad7e385f0c28efe81f816c0`. Codesign retry and DMG conversion blockers are fixed. Packaging handoff and Sparkle consumer release gates are in place. The canonical command is `scripts/package-openclaw-mac-dist.sh`; `scripts/package-consumer-mac-dist.sh` remains a compatibility wrapper. GitHub release assets are `OpenClaw.dmg`, `OpenClaw.zip`, `openclaw-consumer-appcast.xml`, and `OpenClaw-2026.3.14.dSYM.zip`.                                                                                                                                                                                                                                                                                                                                                                           | Sparkle/notarized public rebuild is owned by the separate release lane. This lane only needs the final artifact provenance after that lane publishes. |
| App name / bundle identity          | Completed for visible name    | Release packaging now ships as `OpenClaw.app` / `OpenClaw.dmg` / `OpenClaw.zip` while preserving `ai.openclaw.consumer.mac`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Bundle-id migration needs a stronger reason and a migration plan.                                                                                     |
| `openclaw-consumer` retirement      | Completed for normal workflow | `main` is now the target for new work. Consumer branch is no longer the default implementation surface. Existing-user and isolated fresh-user main-built app smokes passed. Older docs/workflows now label the old branch as historical or emergency-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Keep `openclaw-consumer` only as an emergency fallback.                                                                                               |
| Overlay/defaults contract           | Mostly completed              | Core setup/runtime pieces are shared. Telegram `/model` now starts with Claude, ChatGPT, and More. Model labels were polished after live feedback: `GPT` is capitalized, duplicate/noisy ChatGPT entries are removed, and Claude family labels use product-facing names such as `Sonnet 4.6`. Fresh consumer configs get broad useful bundled skills by default, and model-facing skills remain visible when setup/auth is missing.                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Keep future onboarding presentation defaults explicit instead of scattering product conditionals.                                                     |
| Docs / workflow cleanup             | Completed                     | Primary and older workflow docs now point normal consumer work at `main` and label `codex/consumer-openclaw-project` as historical or emergency-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Keep future docs aligned with the main-first workflow.                                                                                                |

## Retirement Gate

Do not fully retire `openclaw-consumer` until all of these are true:

- [x] Main-built app smoke passes for an existing user setup.
- [x] Main-built app smoke passes for an isolated fresh setup path.
- [x] Main full DMG/ZIP packaging completed for public release `v2026.3.14`.
- [x] New consumer/product work is documented to target `main` in primary and older workflow docs.
- [x] Conservative visible product rename to `OpenClaw.app` is implemented
      without changing runtime/gateway identity.

## Next Implementation Slices

### 1. Post-#625 public artifact smoke

After the Sparkle/release lane rebuilds from current `main`, install from the
published DMG/ZIP assets and rerun the replacement and first-run smoke checks
against that installed artifact. This gate proves the downloadable package
contains #625 and behaves correctly outside the build machine's staging path.

### 2. GUI Channels tab smoke

The real Telegram behavioral gate passed through a direct DM roundtrip. The
literal SwiftUI Channels tab `Verify first task` click still needs a visual GUI
smoke if the product claim requires that exact button path.

### 3. Sparkle live update path verification

The release includes `openclaw-consumer-appcast.xml`, but the live update path
still needs proof from an older installed build to `v2026.3.14` or the next
release. This is explicitly owned by the separate Sparkle/release lane.

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
Channels tab button path was not visually clicked, so do not claim that GUI
path until a visual smoke covers it.

### Full distribution packaging repair

The full distribution package path now completes from `main`. DMG conversion
passed, `hdiutil verify` checksum was valid, and `.dmg`, `.zip`, and dSYM
`.zip` artifacts were copied to
`/Users/user/Programming_Projects/openclaw/dist/consumer-handoff`.

Status: completed for public release `v2026.3.14` from
`41f2868ad7a2f174aad7e385f0c28efe81f816c0`. `main` has newer changes after
the release.

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
