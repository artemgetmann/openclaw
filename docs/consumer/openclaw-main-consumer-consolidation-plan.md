# OpenClaw Main + Consumer Consolidation Plan

This doc is the operational view of consolidation status in this worktree.
It tracks what has already landed, what is mostly done, and what is still
unified-in-name-only.

## North Star

Build one OpenClaw product with:

- one shared core runtime
- one shared codebase
- one shared capability surface
- one default macOS app surface

The simple consumer-style app is now the product default. Founder/operator
controls stay available through Advanced, and the old shared-main runtime stays
available only as an explicit compatibility mode while we migrate safely.

## Status Snapshot

Legend:

- `Completed`: the consolidation slice landed and should now be treated as shared-core behavior
- `Mostly completed`: the expensive shared-core part landed, but overlay cleanup or follow-through is still pending
- `Pending`: still real consolidation debt

| Area | Status | What has landed | What remains |
| --- | --- | --- | --- |
| Runtime identity / paths | Completed | Shared consumer runtime identity now covers state/config/workspace/log roots, defaults prefix, launch labels, runtime root, and port math across Swift, TypeScript, and shell touchpoints. | Keep bundle/app branding concerns in the packaging/overlay slice instead of re-expanding this into branch-owned runtime logic. |
| Gateway ownership / port isolation | Completed | Gateway ownership and isolated-port behavior now run through shared runtime identity inputs instead of ad hoc consumer-only port hacks. | Treat follow-on fixes as normal shared-runtime maintenance, not a new branch split. |
| Launch / service install behavior | Completed | Service install/restart flows now honor explicit runtime identity values and protect against accidental shared-service takeover. | Packaging/distribution scripts are still separate debt. |
| Status / doctor daemon identity UX | Completed | Daemon `status` / `doctor` identity messaging has been cleaned up as part of the shared runtime/service slice. | Keep future daemon UX changes in the shared path. Do not recreate consumer-only diagnostics. |
| Telegram setup semantics / state machine | Mostly completed | The Telegram setup semantic and state-machine slices have landed. The core verification/state behavior is no longer the main source of branch churn. | Consumer-specific first-run presentation and guidance still need to stay clearly overlay-owned. |
| Consumer onboarding card / first-run guidance | Pending | The underlying Telegram setup logic is in better shape because the semantic/state-machine slice landed. | Keep the consumer setup card and guided first-run copy as overlay UX, then trim any leftover shared-logic drift around it. |
| Skill catalog / status plumbing | Completed | Shared skill semantic evaluation now owns enabled/disabled, requirements, bundled allowlist, and eligibility decisions. | Curated defaults and visibility policy still belong in the overlay/defaults slice. |
| Skill defaults / visibility | Pending | No landed overlay-contract slice yet. | Move curated defaults into overlay configuration instead of scattered branch conditionals. |
| Single macOS app default surface | Completed | The default app is now `OpenClaw` with the simple consumer-style UX. Advanced reveals operator controls. `APP_VARIANT=standard` preserves the old shared-main runtime explicitly. | Do not re-expand this into two product apps. Treat `standard` as temporary compatibility, not the future product. |
| Runtime migration to app-owned root | Mostly completed | Default app-owned runtime paths now point at `~/Library/Application Support/OpenClaw/.openclaw`; instance lanes live under `~/Library/Application Support/OpenClaw/instances/<id>/.openclaw`; explicit copy tooling exists for `~/.openclaw` migration. | Run the real 9.5GB migration intentionally, then prove the daily bot works from the new root before retiring `standard` compatibility. |
| Packaging / distribution cleanup | Mostly completed | Primary packaging now outputs `OpenClaw.app` with the simple product mode by default. Shared-main restart opts into `APP_VARIANT=standard` explicitly. | Consumer lane wrappers still exist for isolated testing and should be slimmed/renamed once runtime migration is complete. |
| Workflow / branch model simplification | Pending | The code has moved faster than the docs here. | The repo still carries too much transition-language and branch-era operational debt. |
| Docs / source-of-truth cleanup | Pending | This doc now reflects landed status instead of a pure future-state queue. | The broader doc set still needs slimming once more consolidation slices are actually complete. |

## What Is Shared vs Overlay-Owned

Shared core:

- runtime identity and state path rules
- gateway ownership and port isolation
- service install/restart/status behavior
- Telegram setup semantics and verification logic
- skill status eligibility semantics
- default macOS app surface: simple first, Advanced for operator controls

Overlay-owned:

- onboarding copy and guided-first-run presentation
- tab visibility and progressive disclosure
- curated skill defaults and model shortlist
- packaging metadata, app branding, and distribution details

Temporary debt still on the board:

- packaging shell duplication
- branch/workflow transition docs
- real daily-bot cutover from copied state to app-owned state root

## What This Means Practically

Do not plan as if runtime identity, gateway ownership, or service install behavior
are still open design questions. Those slices have landed.

Do plan as if the remaining work is now concentrated in:

1. real daily-bot cutover after explicit copy into the app-owned root
2. packaging wrapper cleanup
3. overlay/defaults policy
4. branch/docs cleanup

Telegram is in the middle: the core semantics are largely in place, but the
consumer-specific first-run UX still needs to stay deliberately separated from
shared setup logic.

## Remaining Workstreams

### 1. Runtime migration

Still needed:

- run `scripts/migrate-openclaw-runtime-to-app-support.sh` against the real `~/.openclaw`
- prove the default `OpenClaw.app` can run the real daily workflow
- keep `~/.openclaw` untouched as rollback until the new root survives real usage

Why this matters:

- this is the last big reason to keep the old shared-main compatibility lane
- once this is proven, long-lived consumer branch work becomes mostly paperwork

### 2. Packaging wrapper cleanup

Still needed:

- slim or rename explicit consumer lane wrappers
- keep isolated test lanes without implying a second product app
- verify primary package, open, restart, and dist flows all agree on `OpenClaw`

Why this matters:

- packaging should not preserve the old branch split by accident

### 3. Overlay/defaults contract

Still needed:

- skill allowlists/default visibility
- model shortlist/default exposure
- onboarding/default presentation switches

Why this matters:

- product defaults should be explicit config, not scattered conditionals

### 4. Workflow/docs cleanup

Still needed:

- reduce transition-only branch language
- trim duplicate “source of truth” docs after code lands
- keep the docs aligned with reality instead of aspirational queues

Why this matters:

- stale migration docs become architecture if nobody kills them

## Guardrails

- Do not reopen completed runtime/gateway/service slices by reintroducing branch-only logic.
- Do not describe the future as `OpenClaw` plus `OpenClaw Consumer`; the future is one `OpenClaw` app.
- If a change is product-specific, classify it honestly as default UX, Advanced UX, runtime compatibility, or packaging metadata.
- If a category is only partly done, say so plainly and keep it on the board.
- Do not count docs cleanup as product consolidation progress unless code actually landed first.

## Current Recommendation

If we keep pushing consolidation from here, the next rational order is:

1. run and validate the real daily-bot migration into the app-owned runtime root
2. collapse or rename remaining consumer-only packaging wrappers
3. formalize overlay/defaults policy
4. shrink branch/docs debt last

The runtime/gateway/service foundation is no longer the blocker. The remaining
work is mostly proving the single default app can replace the old branch/runtime
model without breaking the daily bot.
