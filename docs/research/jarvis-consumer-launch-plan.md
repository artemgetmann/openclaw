# Jarvis Consumer Launch Tracker

Status: active launch tracker
Owner: Artem
Last updated: 2026-06-13

Purpose: current objective, done/open state, next actions, and source pointers.

Use this document for launch execution state only. Keep beta counts in
`docs/consumer/project-status.md`. Keep launch package, pricing, copy, and
artifact truth in `docs/consumer/jarvis-launch-package.md`. Keep long-form
strategy/history in `docs/consumer/archive/jarvis-consumer-launch-plan-history-20260613.md`.

## Current Truth

Jarvis is in private beta. The current useful objective is simple: send
`v2026.3.23` to trusted testers, watch real install/use feedback, and close only
the gates that matter before broader launch.

Trusted-tester send is unblocked.

- Current trusted-tester release: `v2026.3.23`
- Sendable DMG:
  `https://github.com/artemgetmann/openclaw/releases/latest/download/Jarvis.dmg`
- Current repo `main` includes PR #934 at
  `7a732c76ec0489d94aa9e07e7d1e83a391bc6f65`.
- Public release assets include `Jarvis.dmg`, `Jarvis.zip`, and
  `jarvis-appcast.xml`.
- Appcast points to short version `2026.3.23`, build `2026061317`.
- Same-user onboarding and 2026-06-09 Gate2 clean-user proof are accepted.
- A separate user's Mac manually installed the public DMG and reached Settings
  -> AI access with `Continue with ChatGPT` selected and no helper-repair
  message.

Current identity stance:

- Trusted testers can use the current `ai.openclaw.consumer.mac` technical
  identity.
- Broad public launch needs a deliberate identity/update-path decision.
- Full migration to `ai.jarvis.mac` is recommended if the priority is clean
  brand, permissions, LaunchAgent identity, and update continuity.
- The speed option is one more public-ish beta on `ai.openclaw.consumer.mac`
  with identity debt documented.

## What Is Done

- Consumer-product work targets this repo's `main`; legacy `consumer` and
  `codex/consumer-openclaw-project` are not active targets.
- Jarvis is the public consumer brand; OpenClaw remains technical/developer
  language.
- Visible app name, release artifacts, and app icon use Jarvis.
- Backend contract, Render deployment, account activation, 14-day trial,
  license status, and managed utility surfaces are in place for beta.
- Public `v2026.3.23` trusted-tester release assets are live.
- Local installed proof passed for app version `2026.3.23`, build
  `2026061317`, commit `a1a094ef2a`.
- Separate-user manual public-DMG install proof passed on 2026-06-13.
- Gate2 clean-user proof passed for trusted-tester onboarding.
- Non-secret Sparkle release config is expected at
  `~/Library/Application Support/OpenClaw/release.env`.
- App Store Connect API-key notarization lane was previously prepared on
  Artem's machine; keep secrets outside Git.
- Historical package/proof details are archived, not active blockers.

## Open Gates

| Gate                                   | Required for trusted testers?                  | Required before broad public launch? | Current next proof                                                                                                  |
| -------------------------------------- | ---------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| First real tester install/use feedback | Yes, after sending                             | Yes                                  | Send `v2026.3.23`; capture setup confusion, first useful task, and failure points.                                  |
| Onboarding copy/friction fixes         | No, unless tester feedback exposes a hard stop | Yes                                  | Patch only specific confusion found by testers.                                                                     |
| Full Sparkle update-cycle proof        | No                                             | Yes                                  | Prove download, signature verification, install, relaunch, and state preservation from older build to latest build. |
| Identity/update-path decision          | No                                             | Yes                                  | Choose `ai.jarvis.mac` migration before broad launch or document one more beta on `ai.openclaw.consumer.mac`.       |
| `/visibility` command cleanup          | No                                             | Yes                                  | Replace stale `/verbose` naming with `/visibility off/on/full`; prove command list and behavior with a tester bot.  |
| Telegram settings/model cleanup        | No                                             | Maybe                                | Do only if tester feedback shows confusion; avoid speculative command-menu churn.                                   |

## Next Actions

1. Send the `v2026.3.23` DMG to the waiting trusted testers.
2. Collect first install/use feedback in a short structured form:
   - install outcome
   - AI access outcome
   - Telegram setup outcome
   - first useful task attempted
   - first confusing or broken moment
3. Fix concrete onboarding copy/friction issues found by that feedback.
4. Run a full Sparkle update-cycle proof before relying on automatic updates for
   recovery or broader distribution.
5. Decide identity/update path before broad public launch:
   - migrate to `ai.jarvis.mac` for cleaner brand and update continuity, or
   - ship one more public-ish beta on `ai.openclaw.consumer.mac` and document
     the identity debt.

## Deferred Product Backlog

These are still real product tasks. They are not blockers for sending
`v2026.3.23` to trusted testers.

- Replace developer-facing `/verbose` language with `/visibility off|on|full`.
  Normal users should see visibility controls, not debug jargon. Before merging
  that work, inspect current command/visibility behavior and prove the Telegram
  command list plus `/visibility` behavior with a tester bot.
- Expose Claude Code as a consumer-facing model lane only after more founder use
  of the Claude CLI backend. Before broad public launch, the model picker should
  make normal choices obvious and hide developer/legacy providers unless the
  local prerequisites exist.

## Deferred / Not Now

- Do not implement identity migration in this docs cleanup.
- Do not implement Sparkle proof in this docs cleanup.
- Do not touch release artifacts, appcast, notarization, runtime, LaunchAgents,
  Telegram runtime, or shared services in this docs cleanup.
- Do not write new launch strategy essays in the active tracker.
- Do not make Claude Code/model-picker cleanup a trusted-tester blocker.
- Do not make vague maintenance work a blocker without tester evidence.
- Do not delete old proof; keep it archived for audit.

## Archive Pointers

- Launch package history:
  `docs/consumer/archive/jarvis-launch-package-history-20260613.md`
- Long-form launch strategy/history:
  `docs/consumer/archive/jarvis-consumer-launch-plan-history-20260613.md`
- Gate2 closeout details:
  `docs/consumer/jarvis-consumer-rc-closeout-20260606.md`
- Main consumer consolidation history:
  `docs/consumer/archive/openclaw-main-consumer-consolidation-plan.md`
- Legacy execution docs:
  `docs/consumer/archive/openclaw-consumer-execution-spec.md`
