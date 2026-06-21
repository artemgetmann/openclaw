# Jarvis Consumer Launch Tracker

Status: active mission tracker
Owner: Artem
Last updated: 2026-06-21

Purpose: current mission, current truth, active gates, next actions, and cold
storage pointers.

Use this document for launch execution state only. Keep beta counts in
`docs/consumer/project-status.md`. Keep launch package, pricing, copy, and
artifact truth in `docs/consumer/jarvis-launch-package.md`. Use
`docs/jarvis/README.md` for the product-doc map. Keep long-form
strategy/history in `docs/consumer/archive/`.

## Now

1. Build/install the next Jarvis package from current `main` and prove #960 in
   the installed app.
2. Complete full Sparkle update-cycle proof.
3. Collect real tester install/use feedback and fix only concrete onboarding
   friction.

## Active Mission

Mission: get the current Jarvis build into trusted testers' hands and learn
where first install, AI access, Telegram setup, or first useful task breaks.

Do not turn this tracker into a permanent product backlog. If a task is not
part of this mission, not time-sensitive, and not damaging to forget, move it
to cold storage or let it die.

## Current Truth

Trusted-tester send is unblocked, but broad-public packaging is still gated.

- Current trusted-tester release: `v2026.3.23`
- Sendable DMG:
  `https://github.com/artemgetmann/openclaw/releases/latest/download/Jarvis.dmg`
- Current public release uses the old trusted-tester technical identity and
  does not contain #953/#960.
- Current repo `main` includes PR #953 and PR #960 at `7a40c86633`.
- Public release assets include `Jarvis.dmg`, `Jarvis.zip`, and
  `jarvis-appcast.xml`.
- Appcast points to short version `2026.3.23`, build `2026061317`.
- Same-user onboarding and 2026-06-09 Gate2 clean-user proof are accepted.
- A separate user's Mac manually installed the public DMG and reached Settings
  -> AI access with `Continue with ChatGPT` selected and no helper-repair
  message.
- Manual Jarvis migration proof exists, but the installed app does not contain
  #960 until a new app is built and installed.

Identity stance:

- Trusted testers can use the current `ai.openclaw.consumer.mac` technical
  identity.
- Broad public launch targets `ai.jarvis.mac`,
  `~/Library/Application Support/Jarvis/.jarvis`, and `ai.jarvis.gateway`.
- Old trusted-tester state stays separate unless Artem explicitly chooses a
  migration runbook.

## Open Gates

Keep this table to 5 or fewer real gates.

| Gate                                   | Blocks trusted testers? | Blocks broad public launch? | Next proof                                                                                                          |
| -------------------------------------- | ----------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| New packaged app build/install proof   | No                      | Yes                         | Build from current `main`, install it, and prove #960 behavior in the installed app.                                |
| Full Sparkle update-cycle proof        | No                      | Yes                         | Prove download, signature verification, install, relaunch, and state preservation from older build to latest build. |
| First real tester install/use feedback | Yes, after sending      | Yes                         | Send `v2026.3.23`; capture setup confusion, first useful task, and failure points.                                  |
| Onboarding copy/friction fixes         | Only if feedback blocks | Yes                         | Patch specific confusion found by testers.                                                                          |

## Next Actions

1. Build/install the next Jarvis package from current `main`; prove #960 in the
   installed app.
2. Run full Sparkle update-cycle proof before relying on automatic updates.
3. Send `v2026.3.23` to waiting trusted testers if that send has not already
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
