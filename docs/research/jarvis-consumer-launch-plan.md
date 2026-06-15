# Jarvis Consumer Launch Tracker

Status: active mission tracker
Owner: Artem
Last updated: 2026-06-15

Purpose: current mission, current truth, active gates, next actions, and cold
storage pointers.

Use this document for launch execution state only. Keep beta counts in
`docs/consumer/project-status.md`. Keep launch package, pricing, copy, and
artifact truth in `docs/consumer/jarvis-launch-package.md`. Keep long-form
strategy/history in `docs/consumer/archive/jarvis-consumer-launch-plan-history-20260613.md`.

## Now

1. Send `v2026.3.23` to the waiting trusted testers.
2. Collect first real install/use feedback.
3. Fix only concrete onboarding friction found by that feedback.

## Active Mission

Mission: get the current Jarvis build into trusted testers' hands and learn
where first install, AI access, Telegram setup, or first useful task breaks.

Do not turn this tracker into a permanent product backlog. If a task is not
part of this mission, not time-sensitive, and not damaging to forget, move it
to cold storage or let it die.

## Current Truth

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

Identity stance:

- Trusted testers can use the current `ai.openclaw.consumer.mac` technical
  identity.
- Broad public launch needs a deliberate identity/update-path decision.
- Full migration to `ai.jarvis.mac` is recommended for clean brand,
  permissions, LaunchAgent identity, and update continuity.
- The speed option is one more public-ish beta on `ai.openclaw.consumer.mac`
  with identity debt documented.

## Open Gates

Keep this table to 5 or fewer real gates.

| Gate                                   | Blocks trusted testers? | Blocks broad public launch? | Next proof                                                                                                          |
| -------------------------------------- | ----------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| First real tester install/use feedback | Yes, after sending      | Yes                         | Send `v2026.3.23`; capture setup confusion, first useful task, and failure points.                                  |
| Onboarding copy/friction fixes         | Only if feedback blocks | Yes                         | Patch specific confusion found by testers.                                                                          |
| Full Sparkle update-cycle proof        | No                      | Yes                         | Prove download, signature verification, install, relaunch, and state preservation from older build to latest build. |
| Identity/update-path decision          | No                      | Yes                         | Choose `ai.jarvis.mac` migration before broad launch or document one more beta on `ai.openclaw.consumer.mac`.       |

## Next Actions

1. Send the `v2026.3.23` DMG to the waiting trusted testers.
2. Capture tester feedback in a short form:
   - install outcome
   - AI access outcome
   - Telegram setup outcome
   - first useful task attempted
   - first confusing or broken moment
3. Fix concrete onboarding copy/friction issues found by that feedback.
4. Run full Sparkle update-cycle proof before relying on automatic updates for
   recovery or broader distribution.
5. Decide identity/update path before broad public launch.

## Done

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

## Cold Storage

Cold storage is searchable context, not an obligation list. Read it only when a
mission needs it.

- Long-form launch strategy/history:
  `docs/consumer/archive/jarvis-consumer-launch-plan-history-20260613.md`
- Launch package history:
  `docs/consumer/archive/jarvis-launch-package-history-20260613.md`
- Gate2 closeout details:
  `docs/consumer/jarvis-consumer-rc-closeout-20260606.md`
- Legacy execution docs:
  `docs/consumer/archive/openclaw-consumer-execution-spec.md`

Examples of cold-storage items that are still useful but not active obligations:

- `/visibility off|on|full` replacing developer-facing `/verbose` language
- Claude Code/model-picker cleanup
- Telegram group/thread/forum setup
