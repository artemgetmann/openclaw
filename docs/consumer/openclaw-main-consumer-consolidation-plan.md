# OpenClaw Main + Consumer Consolidation Plan

Last updated: 2026-05-07

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

The main-built consumer artifact now uses the visible product name
`OpenClaw.app` while preserving the consumer bundle id/runtime identity. The
bundle-id migration remains deliberately separate because changing it can reset
TCC permissions and update identity.

The latest installed local app was rebuilt from the PR #620 branch
`codex/main-consumer-packaged-launchagent-repair-20260506` at commit
`5ed9f8c841` before the final merge commit. It replaced
`/Applications/OpenClaw.app` and reports:

- display name: `OpenClaw`
- bundle id: `ai.openclaw.consumer.mac`
- variant: `consumer`
- version: `2026.3.14`
- git commit: `5ed9f8c841`

The full distribution command passed:
`SKIP_NOTARIZE=1 ALLOW_DEFAULT_SPARKLE_KEY_FOR_CONSUMER_SMOKE=1 bash scripts/package-openclaw-mac-dist.sh`.
DMG conversion passed and `hdiutil verify` reported a valid checksum. Handoff
artifacts were copied to:

- `/Users/user/Programming_Projects/openclaw/dist/consumer-handoff/OpenClaw.dmg`
- `/Users/user/Programming_Projects/openclaw/dist/consumer-handoff/OpenClaw.zip`
- `/Users/user/Programming_Projects/openclaw/dist/consumer-handoff/OpenClaw-2026.3.14.dSYM.zip`

Release provenance still requires a rebuild from merged `main` because the
current artifacts were built before merge commit `bebf30aff7`.

PR #620 fixes automatic packaged gateway LaunchAgent replacement repair. Local
proof started from a stale `ai.openclaw.gateway` plist pointing at
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

Public release still needs Developer ID notarization and the real Sparkle
key/feed. Local smoke builds are not broad public distribution quality until
those gates pass.

After #579, new Consumer package runs also copy `.dmg`, `.zip`, and dSYM `.zip`
handoff artifacts to `dist/consumer-handoff` under the main checkout by default
when packaging is invoked from a temp worktree. Override with
`OPENCLAW_CONSUMER_DIST_HANDOFF_DIR`.

## Status Snapshot

| Area                                | Status                          | What is done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | What remains                                                                                      |
| ----------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Runtime identity / paths            | Completed                       | Runtime root, state/config/workspace/log paths, gateway label, and port behavior are shared in `main`. Default runtime is `~/Library/Application Support/OpenClaw/.openclaw`; gateway is `ai.openclaw.gateway` on `18789`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Keep future changes in shared runtime code. Do not recreate branch-specific runtime rules.        |
| Gateway ownership / launch behavior | #620 merged; local proof passed | Shared gateway/service ownership is canonical in `main`, with takeover guardrails and canonical env fixes merged. #597 prevents the consumer app from stopping an already-healthy canonical gateway during setup/attach paths. #599 keeps the watchdog health probe shallow so a healthy `/healthz` gateway is not killed by an overly deep CLI/RPC probe. #613 and #614 allow the packaged app entrypoint and packaged launchd context to manage the canonical gateway. #615 makes the app prefer its bundled runtime root over stale saved dev roots. #620 repairs stale installed-app LaunchAgents to the packaged runtime entrypoint and unloads the legacy watchdog. Local replacement proof passed. | Rebuild release artifacts from merged `main`.                                                     |
| Consumer macOS shell parity         | Completed                       | Consumer setup shell pieces were ported into `main`: browser setup, readiness, permissions, Telegram setup card/state/verifier, bundled runtime/bootstrap, and packaging entrypoints. Existing-user main-built app smoke passed. Isolated fresh-user smoke passed.                                                                                                                                                                                                                                                                                                                                                                                                                                        | Keep future setup/app fixes in `main`.                                                            |
| Update-safe setup resume            | Completed                       | Existing installs can skip setup only after browser, permissions, model, and Telegram health checks pass. Broken configs resume to relevant blockers. Existing-user smoke confirmed setup did not repeat. Isolated fresh-user smoke confirmed first-run onboarding appears from clean state.                                                                                                                                                                                                                                                                                                                                                                                                              | Keep future setup fixes in `main`.                                                                |
| Packaging from main                 | Local full package passed       | `main` can produce and verify a signed `OpenClaw.app` bundle from the sacred checkout. Codesign retry blocker is fixed. Packaging handoff and Sparkle consumer release gates are in place. The canonical command is `scripts/package-openclaw-mac-dist.sh`; `scripts/package-consumer-mac-dist.sh` remains a compatibility wrapper. The PR #620 package run passed full DMG/ZIP/dSYM packaging, DMG conversion, and checksum verification.                                                                                                                                                                                                                                                                | Rebuild artifacts from merged `main`; then handle public notarization/updater spine.              |
| App name / bundle identity          | Completed for visible name      | Release packaging now ships as `OpenClaw.app` / `OpenClaw.dmg` / `OpenClaw.zip` while preserving `ai.openclaw.consumer.mac`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Bundle-id migration needs a stronger reason and a migration plan.                                 |
| `openclaw-consumer` retirement      | Completed for normal workflow   | `main` is now the target for new work. Consumer branch is no longer the default implementation surface. Existing-user and isolated fresh-user main-built app smokes passed. Older docs/workflows now label the old branch as historical or emergency-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                | Keep `openclaw-consumer` only as an emergency fallback.                                           |
| Overlay/defaults contract           | Mostly completed                | Core setup/runtime pieces are shared. Telegram `/model` now starts with Claude, ChatGPT, and More. Model labels were polished after live feedback: `GPT` is capitalized, duplicate/noisy ChatGPT entries are removed, and Claude family labels use product-facing names such as `Sonnet 4.6`. Fresh consumer configs get broad useful bundled skills by default, and model-facing skills remain visible when setup/auth is missing.                                                                                                                                                                                                                                                                       | Keep future onboarding presentation defaults explicit instead of scattering product conditionals. |
| Docs / workflow cleanup             | Completed                       | Primary and older workflow docs now point normal consumer work at `main` and label `codex/consumer-openclaw-project` as historical or emergency-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Keep future docs aligned with the main-first workflow.                                            |

## Retirement Gate

Do not fully retire `openclaw-consumer` until all of these are true:

- [x] Main-built app smoke passes for an existing user setup.
- [x] Main-built app smoke passes for an isolated fresh setup path.
- [x] Main full DMG/ZIP packaging is repeatable locally from the PR #620 branch.
- [x] New consumer/product work is documented to target `main` in primary and older workflow docs.
- [x] Conservative visible product rename to `OpenClaw.app` is implemented
      without changing runtime/gateway identity.

## Next Implementation Slices

### 1. Rebuild release artifacts from merged `main`

#620 merged from
`codex/main-consumer-packaged-launchagent-repair-20260506` and has local proof
for automatic packaged gateway LaunchAgent repair plus full DMG/ZIP/dSYM
packaging. After merge, rebuild the release artifacts from merged `main` so the
handoff provenance matches the final code and docs.

### 2. Real Telegram first-task verification

Complete the Channels tab `Verify first task` path against the real Telegram
bot. The channel is configured and connected, but onboarding should not be
called complete until one Telegram request reaches OpenClaw and the answer lands
back in the same DM.

## Completed Implementation Slices

### Automatic packaged LaunchAgent repair

The replaced `/Applications/OpenClaw.app` now repairs the canonical
`ai.openclaw.gateway` LaunchAgent to the packaged runtime entrypoint on first
launch. The proven entrypoint is:

- `/Applications/OpenClaw.app/Contents/Resources/OpenClawRuntime/openclaw/dist/index.js`

The stale pre-repair state pointed at
`/Users/user/Programming_Projects/openclaw/dist/index.js` and had the legacy
`ai.openclaw.gateway-watchdog` loaded from
`/Users/user/Programming_Projects/openclaw/scripts/gateway-watchdog.sh`. After
replacement, the plist and loaded service pointed at the packaged entrypoint,
the watchdog was absent from `launchctl`, and `/healthz` returned
`{"ok":true,"status":"live"}` for 18 checks over 90 seconds.

Status: implemented by #620. Rebuild from merged `main` remains before release
handoff.

### Full distribution packaging repair

The full distribution package command now passes with local smoke flags:

- `SKIP_NOTARIZE=1 ALLOW_DEFAULT_SPARKLE_KEY_FOR_CONSUMER_SMOKE=1 bash scripts/package-openclaw-mac-dist.sh`

DMG conversion passed, `hdiutil verify` checksum was valid, and `.dmg`, `.zip`,
and dSYM `.zip` artifacts were copied to
`/Users/user/Programming_Projects/openclaw/dist/consumer-handoff`.

Status: implemented in #620. Release provenance still requires a rebuild
from merged `main`.

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
