# OpenClaw Main + Consumer Consolidation Plan

Last updated: 2026-05-04

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

The main-built consumer artifact now uses the visible product name
`OpenClaw.app` while preserving the consumer bundle id/runtime identity. The
bundle-id migration remains deliberately separate because changing it can reset
TCC permissions and update identity.

The latest local main-built smoke package was produced from `origin/main` commit
`59454cae1e` and landed at:

- `/Users/user/Programming_Projects/openclaw/dist/OpenClaw.app`
- `/Users/user/Programming_Projects/openclaw/dist/OpenClaw.dmg`
- `/Users/user/Programming_Projects/openclaw/dist/OpenClaw.zip`
- `/Users/user/Programming_Projects/openclaw/dist/consumer-handoff/OpenClaw.dmg`
- `/Users/user/Programming_Projects/openclaw/dist/consumer-handoff/OpenClaw.zip`
- `/Users/user/Programming_Projects/openclaw/dist/OpenClaw-2026.3.14.dSYM.zip`

That smoke build used `SKIP_NOTARIZE=1` and
`ALLOW_DEFAULT_SPARKLE_KEY_FOR_CONSUMER_SMOKE=1`. It is valid for local smoke
and manual-trust demos, not broad public distribution. Public release still
needs Developer ID signing, notarization, and the real Sparkle key/feed.

The fresh main-built app has also replaced `/Applications/OpenClaw.app` on the
local machine. The installed app reports:

- display name: `OpenClaw`
- bundle id: `ai.openclaw.consumer.mac`
- variant: `consumer`
- version: `2026.3.14`
- git commit: `59454cae1e`

The installed app launched and the canonical gateway stayed healthy on
`ai.openclaw.gateway` / port `18789` through a 90-second `/healthz` hold.

After #579, new Consumer package runs also copy `.dmg`, `.zip`, and dSYM `.zip`
handoff artifacts to `dist/consumer-handoff` under the main checkout by default
when packaging is invoked from a temp worktree. Override with
`OPENCLAW_CONSUMER_DIST_HANDOFF_DIR`.

## Status Snapshot

| Area                                | Status                        | What is done                                                                                                                                                                                                                                                                                                                                                                                                                                                              | What remains                                                                                      |
| ----------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Runtime identity / paths            | Completed                     | Runtime root, state/config/workspace/log paths, gateway label, and port behavior are shared in `main`. Default runtime is `~/Library/Application Support/OpenClaw/.openclaw`; gateway is `ai.openclaw.gateway` on `18789`.                                                                                                                                                                                                                                                | Keep future changes in shared runtime code. Do not recreate branch-specific runtime rules.        |
| Gateway ownership / launch behavior | Completed                     | Shared gateway/service ownership is canonical in `main`, with takeover guardrails and canonical env fixes merged. #597 prevents the consumer app from stopping an already-healthy canonical gateway during setup/attach paths. #599 keeps the watchdog health probe shallow so a healthy `/healthz` gateway is not killed by an overly deep CLI/RPC probe. Main-built app smoke kept the gateway healthy through 90 seconds.                                              | Treat future fixes as normal `main` runtime maintenance.                                          |
| Consumer macOS shell parity         | Completed                     | Consumer setup shell pieces were ported into `main`: browser setup, readiness, permissions, Telegram setup card/state/verifier, bundled runtime/bootstrap, and packaging entrypoints. Existing-user main-built app smoke passed. Isolated fresh-user smoke passed.                                                                                                                                                                                                        | Keep future setup/app fixes in `main`.                                                            |
| Update-safe setup resume            | Completed                     | Existing installs can skip setup only after browser, permissions, model, and Telegram health checks pass. Broken configs resume to relevant blockers. Existing-user smoke confirmed setup did not repeat. Isolated fresh-user smoke confirmed first-run onboarding appears from clean state.                                                                                                                                                                              | Keep future setup fixes in `main`.                                                                |
| Packaging from main                 | Completed                     | `main` can produce `OpenClaw.app`, `.zip`, `.dmg`, and dSYM from `origin/main`. Codesign retry blocker is fixed. Packaging now copies distributable handoff artifacts to the canonical main checkout handoff directory by default. Sparkle consumer release gates are in place. The canonical command is `scripts/package-openclaw-mac-dist.sh`; `scripts/package-consumer-mac-dist.sh` remains a compatibility wrapper. Latest local smoke package is from `59454cae1e`. | Public notarization/updater spine remains a separate follow-up.                                   |
| App name / bundle identity          | Completed for visible name    | Release packaging now ships as `OpenClaw.app` / `OpenClaw.dmg` / `OpenClaw.zip` while preserving `ai.openclaw.consumer.mac`.                                                                                                                                                                                                                                                                                                                                              | Bundle-id migration needs a stronger reason and a migration plan.                                 |
| `openclaw-consumer` retirement      | Completed for normal workflow | `main` is now the target for new work. Consumer branch is no longer the default implementation surface. Existing-user and isolated fresh-user main-built app smokes passed. Older docs/workflows now label the old branch as historical or emergency-only.                                                                                                                                                                                                                | Keep `openclaw-consumer` only as an emergency fallback.                                           |
| Overlay/defaults contract           | Mostly completed              | Core setup/runtime pieces are shared. Telegram `/model` now starts with Claude, ChatGPT, and More. Model labels were polished after live feedback: `GPT` is capitalized, duplicate/noisy ChatGPT entries are removed, and Claude family labels use product-facing names such as `Sonnet 4.6`. Fresh consumer configs get broad useful bundled skills by default, and model-facing skills remain visible when setup/auth is missing.                                       | Keep future onboarding presentation defaults explicit instead of scattering product conditionals. |
| Docs / workflow cleanup             | Completed                     | Primary and older workflow docs now point normal consumer work at `main` and label `codex/consumer-openclaw-project` as historical or emergency-only.                                                                                                                                                                                                                                                                                                                     | Keep future docs aligned with the main-first workflow.                                            |

## Retirement Gate

Do not fully retire `openclaw-consumer` until all of these are true:

- [x] Main-built app smoke passes for an existing user setup.
- [x] Main-built app smoke passes for an isolated fresh setup path.
- [x] Main packaging is repeatable from `origin/main`.
- [x] New consumer/product work is documented to target `main` in primary and older workflow docs.
- [x] Conservative visible product rename to `OpenClaw.app` is implemented
      without changing runtime/gateway identity.

## Next Implementation Slices

### 1. Overlay/defaults contract

Move product defaults into explicit overlay/default configuration:

- skill allowlist and visibility
- model shortlist / default exposure
- onboarding defaults
- Telegram/browser first-run presentation

## Completed Implementation Slices

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

Status: completed by #597 and #599. The fresh `/Applications/OpenClaw.app`
replacement launched from commit `59454cae1e`; the canonical gateway stayed
healthy on `/healthz` for 90 seconds.

## Guardrails

- Do not target `openclaw-consumer` for new work unless we explicitly declare an
  emergency backport.
- Do not change the consumer bundle id without a separate migration plan.
- Do not run old `OpenClaw.app` and a new main-built app as if side-by-side is
  automatically safe; verify gateway/runtime ownership first.
- Do not count docs cleanup as product progress unless it prevents real branch
  drift or follows landed code.
