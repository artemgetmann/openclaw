# OpenClaw Main / Consumer Divergence Tracker

Last updated: 2026-05-01

This tracker exists to prevent redoing consolidation work that already landed.
If a slice is marked completed here, future agents should treat it as `main`
truth and build on it instead of reopening branch-era design debates.

## Rule Now

New consumer/product work targets `main`.

`/Users/user/Programming_Projects/openclaw-consumer` and
`codex/consumer-openclaw-project` are legacy/emergency fallback surfaces until
the final smoke gates pass. They are not the default place to implement P0
launch work.

## Divergence Table

| Category | Status | Current truth in `main` | Remaining action |
| --- | --- | --- | --- |
| Runtime identity / paths | Completed | Shared runtime identity is in `main`; default state root is `~/Library/Application Support/OpenClaw/.openclaw`. | Keep future runtime/path changes shared. |
| Gateway ownership / port | Completed | Default gateway is canonical `ai.openclaw.gateway` on `18789`. | Verify app smoke does not disrupt current main bot/gateway. |
| LaunchAgent/service behavior | Completed | Shared service install/restart behavior and takeover guardrails are in `main`. | Treat future issues as shared runtime bugs. |
| Consumer macOS shell parity | Completed | Main has Consumer shell pieces: browser setup support/views, setup readiness, permissions, Telegram setup card/state/verifier, bootstrap, bundled runtime, helper bootstrap. | Validate with existing-user and fresh-user app smokes. |
| Update-safe setup resume | Completed | Main has setup resume that skips onboarding only after browser, permissions, model, and Telegram checks pass. | Confirm against real existing Consumer setup. |
| Transitional Consumer packaging from main | Completed | Main can build `OpenClaw Consumer.app`, `.zip`, `.dmg`, and dSYM. Codesign stale-signature failure was fixed. | Keep using this artifact for immediate user delivery until rename migration is implemented. |
| App rename to `OpenClaw.app` | Pending | Not done. Current safe artifact remains `OpenClaw Consumer.app`. | Implement after smoke. Prefer visible-name rename first; avoid bundle-id migration unless required. |
| Bundle id / TCC migration | Pending | Current Consumer bundle identity is preserved for continuity. | Decide separately from visible rename. Changing bundle id can reset permissions and create support churn. |
| `openclaw-consumer` branch retirement | Mostly completed | Main has the code needed to stop using the consumer checkout for new implementation. | Keep fallback until smoke passes, then update docs/workflows and archive/mark legacy. |
| Consumer packaging wrappers | Pending | Consumer-named wrappers still exist for compatibility/test-lane use. | Slim/rename wrappers so primary shipping path is obvious. |
| Overlay/defaults policy | Pending | Core runtime/setup is shared; product defaults are still not cleanly formalized. | Add explicit overlay/default contract for skills, models, visibility, and onboarding presentation. |
| Branch/workflow docs | Pending | Some docs still instruct agents to target `codex/consumer-openclaw-project`. | Update source-of-truth docs so future work starts from `origin/main`. |

## Completed PRs To Build From

- #552: runtime/gateway identity
- #553: shared skills root
- #554: Telegram tester/model guardrails
- #555: canonical gateway env hotfix
- #556: Consumer app parity port into `main`
- #557: update-safe setup resume
- #558: packaging codesign stale-signature fix

## Queue Now

1. Smoke the main-built `OpenClaw Consumer.app` without renaming it.
2. Update workflow/source-of-truth docs to target `main` for new consumer work.
3. Implement conservative `OpenClaw.app` rename/migration after smoke passes.
4. Slim/rename consumer-specific packaging wrappers.
5. Formalize overlay/defaults policy.
6. Mark `openclaw-consumer` legacy/read-only after smoke gates pass.

## Things We Should Stop Saying

- Stop saying consumer implementation work should target
  `codex/consumer-openclaw-project`.
- Stop treating runtime identity, gateway ownership, macOS shell parity, or
  setup resume as open consolidation problems.
- Stop implying the final product is two apps: `OpenClaw` and
  `OpenClaw Consumer`.
- Stop mixing the app rename into the branch retirement step. The branch/source
  migration is done first; app identity migration is next.
