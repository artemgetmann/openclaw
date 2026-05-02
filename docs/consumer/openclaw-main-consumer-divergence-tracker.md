# OpenClaw Main / Consumer Divergence Tracker

Last updated: 2026-05-02

This tracker exists to prevent redoing consolidation work that already landed.
If a slice is marked completed here, future agents should treat it as `main`
truth and build on it instead of reopening branch-era design debates.

## Rule Now

New consumer/product work targets `main`.

`/Users/user/Programming_Projects/openclaw-consumer` and
`codex/consumer-openclaw-project` are legacy/emergency fallback surfaces. They
are not the default place to implement P0 launch work.

## Divergence Table

| Category                              | Status    | Current truth in `main`                                                                                                                                                                                                                                   | Remaining action                                                                                          |
| ------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Runtime identity / paths              | Completed | Shared runtime identity is in `main`; default state root is `~/Library/Application Support/OpenClaw/.openclaw`.                                                                                                                                           | Keep future runtime/path changes shared.                                                                  |
| Gateway ownership / port              | Completed | Default gateway is canonical `ai.openclaw.gateway` on `18789`. Main-built existing-user smoke kept the same gateway pid/run count alive through 90 seconds.                                                                                               | Treat future issues as shared runtime bugs.                                                               |
| LaunchAgent/service behavior          | Completed | Shared service install/restart behavior and takeover guardrails are in `main`.                                                                                                                                                                            | Treat future issues as shared runtime bugs.                                                               |
| Consumer macOS shell parity           | Completed | Main has Consumer shell pieces: browser setup support/views, setup readiness, permissions, Telegram setup card/state/verifier, bootstrap, bundled runtime, helper bootstrap. Existing-user and isolated fresh-user app smokes passed.                     | Keep future app/setup fixes in `main`.                                                                    |
| Update-safe setup resume              | Completed | Main has setup resume that skips onboarding only after browser, permissions, model, and Telegram checks pass. Real existing setup did not show onboarding in smoke; isolated fresh setup showed onboarding from clean state.                              | Keep future setup fixes in `main`.                                                                        |
| Consumer packaging from main          | Completed | Main can build `OpenClaw.app`, `.zip`, `.dmg`, and dSYM from `origin/main`. Codesign stale-signature failure was fixed. Packaging copies DMG/ZIP/dSYM ZIP handoff artifacts to the main checkout by default. Sparkle consumer release gates are in place. | Notarized distribution and wrapper cleanup remain separate follow-ups.                                    |
| App rename to `OpenClaw.app`          | Completed | Release packaging now ships the visible product as `OpenClaw.app` / `OpenClaw.dmg` / `OpenClaw.zip`.                                                                                                                                                      | Keep old `OpenClaw Consumer` references only where they describe history or debug compatibility.          |
| Bundle id / TCC migration             | Deferred  | Current Consumer bundle identity is preserved for continuity.                                                                                                                                                                                             | Decide separately from visible rename. Changing bundle id can reset permissions and create support churn. |
| `openclaw-consumer` branch retirement | Completed | Main has the code needed to stop using the consumer checkout for new implementation. Existing-user and isolated fresh-user main-built smokes passed. Older docs/workflows now label the old branch as historical or emergency-only.                       | Keep fallback available only for emergency recovery.                                                      |
| Consumer packaging wrappers           | Pending   | Consumer-named wrappers still exist for compatibility/test-lane use.                                                                                                                                                                                      | Slim/rename wrappers so primary shipping path is obvious.                                                 |
| Overlay/defaults policy               | Pending   | Core runtime/setup is shared; product defaults are still not cleanly formalized.                                                                                                                                                                          | Add explicit overlay/default contract for skills, models, visibility, and onboarding presentation.        |
| Branch/workflow docs                  | Completed | Primary and older workflow docs now target `main` for consumer/product work and treat `openclaw-consumer` as historical or legacy/emergency fallback.                                                                                                     | Keep future docs aligned with the main-first workflow.                                                    |

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

## Queue Now

1. Slim/rename consumer-specific packaging wrappers.
2. Formalize overlay/defaults policy.

## Things We Should Stop Saying

- Stop saying consumer implementation work should target
  `codex/consumer-openclaw-project`.
- Stop treating runtime identity, gateway ownership, macOS shell parity, or
  setup resume as open consolidation problems.
- Stop implying the final product is two apps: `OpenClaw` and
  `OpenClaw Consumer`.
- Stop treating the visible app rename as blocked. The visible rename is done;
  only bundle-id migration remains deferred.
