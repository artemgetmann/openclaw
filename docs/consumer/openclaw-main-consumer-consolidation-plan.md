# OpenClaw Main + Consumer Consolidation Plan

Last updated: 2026-05-02

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

The latest validated shipping artifact still uses the transitional visible name
`OpenClaw Consumer.app`. That is intentional. The app rename to `OpenClaw.app`
is a separate migration slice because it can affect install paths, app identity,
TCC permissions, update feeds, and conflicts with old installed `OpenClaw.app`
copies.

The latest main-built shipping DMG was produced from `origin/main` commit
`53f7174699` and copied to:

- `/Users/user/Programming_Projects/openclaw/OpenClaw Consumer.dmg`

After #579, new Consumer package runs also copy `.dmg`, `.zip`, and dSYM `.zip`
handoff artifacts to `dist/consumer-handoff` under the main checkout by default
when packaging is invoked from a temp worktree. Override with
`OPENCLAW_CONSUMER_DIST_HANDOFF_DIR`.

## Status Snapshot

| Area                                | Status                                       | What is done                                                                                                                                                                                                                                                                                 | What remains                                                                                                                                                             |
| ----------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime identity / paths            | Completed                                    | Runtime root, state/config/workspace/log paths, gateway label, and port behavior are shared in `main`. Default runtime is `~/Library/Application Support/OpenClaw/.openclaw`; gateway is `ai.openclaw.gateway` on `18789`.                                                                   | Keep future changes in shared runtime code. Do not recreate branch-specific runtime rules.                                                                               |
| Gateway ownership / launch behavior | Completed                                    | Shared gateway/service ownership is canonical in `main`, with takeover guardrails and canonical env fixes merged. Main-built app smoke kept the existing gateway alive on the same run count and pid through 90 seconds.                                                                     | Treat future fixes as normal `main` runtime maintenance.                                                                                                                 |
| Consumer macOS shell parity         | Completed                                    | Consumer setup shell pieces were ported into `main`: browser setup, readiness, permissions, Telegram setup card/state/verifier, bundled runtime/bootstrap, and packaging entrypoints. Existing-user main-built app smoke passed. Isolated fresh-user smoke passed.                           | Keep future setup/app fixes in `main`.                                                                                                                                   |
| Update-safe setup resume            | Completed                                    | Existing installs can skip setup only after browser, permissions, model, and Telegram health checks pass. Broken configs resume to relevant blockers. Existing-user smoke confirmed setup did not repeat. Isolated fresh-user smoke confirmed first-run onboarding appears from clean state. | Keep future setup fixes in `main`.                                                                                                                                       |
| Packaging from main                 | Completed for transitional Consumer artifact | `main` can produce `OpenClaw Consumer.app`, `.zip`, `.dmg`, and dSYM from `origin/main`. Codesign retry blocker is fixed. Packaging now copies distributable handoff artifacts to the canonical main checkout handoff directory by default. Sparkle consumer release gates are in place.     | Product rename to `OpenClaw.app`, notarization/updater spine, and wrapper cleanup are separate follow-ups.                                                               |
| App name / bundle identity          | Pending                                      | We deliberately preserved `OpenClaw Consumer.app` for the immediate safe build.                                                                                                                                                                                                              | Implement conservative `OpenClaw.app` migration after smoke passes. Prefer visible-name rename first; bundle-id migration needs a stronger reason and a migration plan.  |
| `openclaw-consumer` retirement      | Mostly completed                             | `main` is now the target for new work. Consumer branch is no longer the default implementation surface. Existing-user and isolated fresh-user main-built app smokes passed. Older docs/workflows now label the old branch as historical or emergency-only.                                   | Keep `openclaw-consumer` as an emergency fallback until app rename/migration is complete.                                                                                |
| Overlay/defaults contract           | Pending                                      | Core setup/runtime pieces are shared.                                                                                                                                                                                                                                                        | Formalize product defaults for skill visibility, model shortlist, onboarding defaults, and first-run presentation as overlay/default config, not scattered conditionals. |
| Docs / workflow cleanup             | Completed                                    | Primary and older workflow docs now point normal consumer work at `main` and label `codex/consumer-openclaw-project` as historical or emergency-only.                                                                                                                                        | Keep future docs aligned with the main-first workflow.                                                                                                                   |

## Retirement Gate

Do not fully retire `openclaw-consumer` until all of these are true:

- [x] Main-built app smoke passes for an existing user setup.
- [x] Main-built app smoke passes for an isolated fresh setup path.
- [x] Main packaging is repeatable from `origin/main`.
- [x] New consumer/product work is documented to target `main` in primary and older workflow docs.
- Any old installed `OpenClaw.app` conflict is understood before the product rename.

## Next Implementation Slices

### 1. Conservative `OpenClaw.app` product rename

Implement the rename as a controlled migration.

Preferred first step:

- Visible app name / bundle filename becomes `OpenClaw.app`.
- Preserve the current Consumer bundle id initially if that keeps permissions
  and state continuity.

Do not change visible name and bundle id together unless there is a concrete
release/updater requirement. That would create avoidable support risk.

### 2. Packaging wrapper cleanup

Slim or rename the consumer-specific scripts so they are clearly compatibility
or test-lane wrappers, not the primary shipping path.

### 3. Overlay/defaults contract

Move product defaults into explicit overlay/default configuration:

- skill allowlist and visibility
- model shortlist / default exposure
- onboarding defaults
- Telegram/browser first-run presentation

## Completed Implementation Slices

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

Run the current main-built `OpenClaw Consumer.app` in a fresh local user/profile
or equivalent isolated state. Prove the onboarding path still works from zero.

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

## Guardrails

- Do not target `openclaw-consumer` for new work unless we explicitly declare an
  emergency backport.
- Do not rename the shipped app before the main-built Consumer smoke passes.
- Do not run old `OpenClaw.app` and a new main-built app as if side-by-side is
  automatically safe; verify gateway/runtime ownership first.
- Do not count docs cleanup as product progress unless it prevents real branch
  drift or follows landed code.
