# Jarvis Consumer RC Closeout

Status: historical trusted-tester proof
Last updated: 2026-06-10

Purpose: preserve the useful release-gate evidence from the old RC lane without
copying stale scripts, package metadata, or packaging instructions.

## Gate2 Clean-User Proof - 2026-06-09

Verdict: accepted for the trusted-tester onboarding gate.

Proof bundles:

- `/Users/Shared/jarvis-consumer-gate2-proof-20260609T130808Z`
- `/Users/Shared/jarvis-consumer-gate2-proof-20260609T130814Z`

What passed:

- Clean macOS account: collector ran as `jarvistest` / uid `503`.
- App identity under test: `Jarvis Consumer Gate2`, bundle id
  `ai.openclaw.consumer.mac.gate2`, instance id `jarvis-consumer-gate2`,
  embedded commit `6816ba8098`.
- LaunchAgent identity:
  `gui/503/ai.openclaw.consumer.jarvis-consumer-gate2.gateway`.
- Runtime ownership: port `25229` was owned by `node` running as `jarvistest`.
- State isolation: runtime state lived under
  `/Users/jarvistest/Library/Application Support/OpenClaw/instances/jarvis-consumer-gate2`.
- Account state: final redacted config proved a trial-active account.
- Telegram: managed bot `@jarvis_cdb46705_bot` started, setup replay returned
  success, and Telegram logged `sendMessage ok`.

Accepted non-blockers:

- The Gate2 app used ad hoc signing, so Gatekeeper rejection was expected for
  that proof-only artifact.
- Permission UI roughness and one transient account/email path stay on the
  first-tester watchlist; they are not trusted-tester blockers after the final
  proof state succeeded.
- Duplicate proof bundles came from running the collector twice; they do not
  invalidate the evidence.

Boundary:

- The Gate2 proof app is not the shipped Jarvis artifact.
- The current shipped tester package is the `v2026.3.17` Jarvis release.
- Broader public readiness is still gated by `ai.jarvis.mac` identity
  migration, real Sparkle update-cycle proof, and first real tester feedback.
