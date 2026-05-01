# OpenClaw Main + Consumer Consolidation Plan

Last updated: 2026-05-01

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

The latest validated shipping artifact still uses the transitional visible name
`OpenClaw Consumer.app`. That is intentional. The app rename to `OpenClaw.app`
is a separate migration slice because it can affect install paths, app identity,
TCC permissions, update feeds, and conflicts with old installed `OpenClaw.app`
copies.

## Status Snapshot

| Area | Status | What is done | What remains |
| --- | --- | --- | --- |
| Runtime identity / paths | Completed | Runtime root, state/config/workspace/log paths, gateway label, and port behavior are shared in `main`. Default runtime is `~/Library/Application Support/OpenClaw/.openclaw`; gateway is `ai.openclaw.gateway` on `18789`. | Keep future changes in shared runtime code. Do not recreate branch-specific runtime rules. |
| Gateway ownership / launch behavior | Completed | Shared gateway/service ownership is canonical in `main`, with takeover guardrails and canonical env fixes merged. | Treat future fixes as normal `main` runtime maintenance. |
| Consumer macOS shell parity | Completed | Consumer setup shell pieces were ported into `main`: browser setup, readiness, permissions, Telegram setup card/state/verifier, bundled runtime/bootstrap, and packaging entrypoints. | Run smoke passes from main-built artifacts before declaring the consumer branch retired. |
| Update-safe setup resume | Completed | Existing installs can skip setup only after browser, permissions, model, and Telegram health checks pass. Broken configs resume to relevant blockers. | Validate on real existing-user and fresh-user app smokes. |
| Packaging from main | Completed for transitional Consumer artifact | `main` can produce `OpenClaw Consumer.app`, `.zip`, `.dmg`, and dSYM. Codesign retry blocker is fixed. | Product rename to `OpenClaw.app`, notarization/updater spine, and wrapper cleanup are separate follow-ups. |
| App name / bundle identity | Pending | We deliberately preserved `OpenClaw Consumer.app` for the immediate safe build. | Implement conservative `OpenClaw.app` migration after smoke passes. Prefer visible-name rename first; bundle-id migration needs a stronger reason and a migration plan. |
| `openclaw-consumer` retirement | Mostly completed | `main` is now the target for new work. Consumer branch is no longer the default implementation surface. | Keep `openclaw-consumer` as emergency fallback until main-built app passes existing-user and fresh-user smoke. Then mark it read-only/legacy in docs and workflows. |
| Overlay/defaults contract | Pending | Core setup/runtime pieces are shared. | Formalize product defaults for skill visibility, model shortlist, onboarding defaults, and first-run presentation as overlay/default config, not scattered conditionals. |
| Docs / workflow cleanup | Pending | This plan and divergence tracker define the new direction. | Update older docs that still say consumer work targets `codex/consumer-openclaw-project`. |

## Retirement Gate

Do not retire `openclaw-consumer` until all of these are true:

- Main-built app smoke passes for an existing user setup.
- Main-built app smoke passes for a fresh setup path.
- Main packaging is repeatable from `origin/main`.
- New consumer/product work is documented to target `main`.
- Any old installed `OpenClaw.app` conflict is understood before the product rename.

## Next Implementation Slices

### 1. Main-built app smoke

Run the current `OpenClaw Consumer.app` artifact from `main` without renaming it.
Prove it preserves existing setup and does not disrupt the canonical gateway.

Why this is first:

- It validates the branch/source migration without also changing app identity.
- It protects the main bot from accidental runtime/service takeover.

### 2. Docs / workflow source-of-truth cleanup

Update `CONSUMER.md`, workflow docs, and older consumer execution docs so agents
stop targeting `openclaw-consumer` or `codex/consumer-openclaw-project` for new
P0 work.

Why this matters:

- Stale docs create duplicated implementation lanes.
- Agents will keep redoing branch-era work if the docs still say the old branch
  is the product branch.

### 3. Conservative `OpenClaw.app` product rename

After smoke passes, implement the rename as a controlled migration.

Preferred first step:

- Visible app name / bundle filename becomes `OpenClaw.app`.
- Preserve the current Consumer bundle id initially if that keeps permissions
  and state continuity.

Do not change visible name and bundle id together unless there is a concrete
release/updater requirement. That would create avoidable support risk.

### 4. Packaging wrapper cleanup

Slim or rename the consumer-specific scripts so they are clearly compatibility
or test-lane wrappers, not the primary shipping path.

### 5. Overlay/defaults contract

Move product defaults into explicit overlay/default configuration:

- skill allowlist and visibility
- model shortlist / default exposure
- onboarding defaults
- Telegram/browser first-run presentation

## Guardrails

- Do not target `openclaw-consumer` for new work unless we explicitly declare an
  emergency backport.
- Do not rename the shipped app before the main-built Consumer smoke passes.
- Do not run old `OpenClaw.app` and a new main-built app as if side-by-side is
  automatically safe; verify gateway/runtime ownership first.
- Do not count docs cleanup as product progress unless it prevents real branch
  drift or follows landed code.
