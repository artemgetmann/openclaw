# Jarvis Consumer Launch Tracker

Status: active mission tracker
Owner: Artem
Last updated: 2026-06-24

Purpose: current mission, current truth, active gates, next actions, and cold
storage pointers.

Use this document for launch execution state only. Keep beta counts in
`docs/consumer/project-status.md`. Keep launch package, pricing, copy, and
artifact truth in `docs/consumer/jarvis-launch-package.md`. Use
`docs/jarvis/README.md` for the product-doc map. Keep long-form
strategy/history in `docs/consumer/archive/`.

## Now

1. Run one clean fresh-install/update smoke on `2026.6.24` build `2026062402`.
2. Open a narrow Telegram group allowlist migration PR for legacy migrated users.
3. Collect real tester install/use feedback and fix only concrete onboarding
   friction.

## Active Mission

Mission: get the current Jarvis build into trusted testers' hands and learn
where first install, AI access, Telegram setup, or first useful task breaks.

Do not turn this tracker into a permanent product backlog. If a task is not
part of this mission, not time-sensitive, and not damaging to forget, move it
to cold storage or let it die.

## Current Truth

Trusted-tester send is unblocked on the current hotfix, but broad-public launch
still needs one clean shipped-build smoke and tester-feedback proof.

- Current Jarvis app version/build: `2026.6.24` / `2026062402`
- Sendable DMG:
  `https://github.com/artemgetmann/openclaw/releases/latest/download/Jarvis.dmg`
- Current public package uses `ai.jarvis.mac`, Jarvis state, and
  `ai.jarvis.gateway`.
- Current repo `main` includes PR #953, PR #960, PR #969, PR #970, PR #971, and
  PR #972 at `e2f67c810a`.
- Public release assets include `Jarvis.dmg`, `Jarvis.zip`, and
  `jarvis-appcast.xml`.
- Appcast points to short version `2026.6.24`, build `2026062402`.
- Same-user onboarding and 2026-06-09 Gate2 clean-user proof are accepted.
- A separate user's Mac manually installed the public DMG and reached Settings
  -> AI access with `Continue with ChatGPT` selected and no helper-repair
  message.
- Manual Jarvis migration proof exists. One legacy migrated user needed a manual
  non-secret Telegram group allowlist carry-over; a narrow follow-up PR should
  make that safer for similar legacy users.

Identity stance:

- Trusted testers can use the current `ai.openclaw.consumer.mac` technical
  identity.
- Broad public launch targets `ai.jarvis.mac`,
  `~/Library/Application Support/Jarvis/.jarvis`, and `ai.jarvis.gateway`.
- Old trusted-tester state stays separate unless Artem explicitly chooses a
  migration runbook.

## Open Gates

Keep this table to 5 or fewer real gates.

| Gate                                   | Blocks trusted testers? | Blocks broad public launch? | Next proof                                                                                                     |
| -------------------------------------- | ----------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Clean shipped-build smoke              | No                      | Yes                         | Validate the public `2026062402` artifact from a clean isolated state without touching real runtime state.     |
| Legacy group allowlist migration PR    | No                      | No                          | Preserve non-secret Telegram group policy fields from old consumer config without copying tokens or old paths. |
| First real tester install/use feedback | Yes, after sending      | Yes                         | Send current `Jarvis.dmg`; capture setup confusion, first useful task, and failure points.                     |
| Onboarding copy/friction fixes         | Only if feedback blocks | Yes                         | Patch specific confusion found by testers.                                                                     |

## Next Actions

1. Run clean shipped-build smoke on `2026062402`.
2. Open the narrow Telegram group allowlist migration PR.
3. Send current `Jarvis.dmg` to waiting trusted testers if that send has not already
   happened.
4. Capture install, AI access, Telegram setup, first useful task, and first
   confusing/broken moment.
5. Fix only concrete onboarding friction found by that feedback.

## Done

- Jarvis brand, app name, release artifacts, and app icon are in place.
- Backend contract, account activation, trial, license status, and managed
  utility surfaces are in place for beta.
- Public `v2026.3.23` assets, local installed proof, separate-user manual DMG
  proof, and Gate2 clean-user proof are accepted.
- PR #953 and PR #960 are merged into repo `main`.
- AI Access and Telegram setup hotfix PRs #969, #970, #971, and #972 are merged
  into repo `main`.
- Public package/appcast proof passed for Jarvis `2026.6.24` build
  `2026062402`; release wrapper reported `release_sendable=true` and
  `sparkle_update_live=true`.

## Cold Storage

Cold storage is searchable context, not an obligation list. Read it only when a
mission needs it.

- Long-form launch strategy/history:
  `docs/consumer/archive/jarvis-consumer-launch-plan-history-20260613.md`
- Launch package history:
  `docs/consumer/archive/jarvis-launch-package-history-20260613.md`
- Gate2 closeout details:
  `docs/consumer/archive/jarvis-consumer-rc-closeout-20260606.md`
- Local-first GTM strategy:
  `docs/consumer/archive/openclaw-consumer-go-to-market-plan-20260422.md`
- Historical investor framing:
  `docs/consumer/archive/openclaw-consumer-investor-brief-20260422.md`
- Legacy execution docs:
  `docs/consumer/archive/openclaw-consumer-execution-spec.md`

Examples of cold-storage items that are still useful but not active obligations:

- `/visibility off|on|full` replacing developer-facing `/verbose` language
- Claude Code/model-picker cleanup
- Telegram group/thread/forum setup
- safety profiles, confirmation gates, activity timeline, and panic pause
