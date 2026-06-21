---
current_stage: private_beta
users_total: 20
paying_users: 0
active_beta_users_7d: TBD
updated_at: 2026-06-21
stale_after_days: 14
source_of_truth: Founder-reported beta snapshot plus 2026-06-09 Gate2 clean-user proof, 2026-06-13 v2026.3.23 public release/manual install proof, and repo main at 7a40c86633.
decision_implication: Trusted-tester send is unblocked; broader launch now needs fresh package build/install proof from current main, fuller Sparkle update-cycle proof, and real tester feedback.
---

# Jarvis Project Status

Purpose: tiny beta decision card only.

Use this document for the current beta stage, user counts, paying users,
activity freshness, and one-line decision implications. Do not add feature
implementation details, PR history, Telegram setup notes, release gates, or long
tracker bullets here. Put launch/build/proof tracking in
`docs/research/jarvis-consumer-launch-plan.md`, and launch-facing package,
copy, and pricing truth in `docs/consumer/jarvis-launch-package.md`.

Jarvis is in private beta.

The current planning snapshot is about 20 total users, 0 paying users, and
`active_beta_users_7d` is still TBD until analytics or an explicit beta-activity
source is wired in.

Trusted-tester send is unblocked. Public `v2026.3.23` assets, same-user
onboarding, Gate2 clean-user proof, and separate-user manual DMG install proof
are accepted.

Repo `main` includes the public Jarvis identity migration and #960 packaged
gateway ownership fix. The current public DMG and currently installed app should
not be treated as containing #960 until a fresh package is built, installed, and
proven.

Next decision inputs:

- fresh packaged app build/install proof from current `main`
- first real tester install/use feedback
- onboarding copy/friction fixes found from that feedback
- fuller Sparkle update-cycle proof

Broad-public repo defaults now target `ai.jarvis.mac`, Jarvis state, and
`ai.jarvis.gateway`. Keep old trusted-tester state separate unless Artem
explicitly chooses a migration tool; macOS permissions are bundle-id scoped, so
clean-start behavior is the safer default until proven otherwise.

These numbers expire after `stale_after_days`. Once expired, they are not decision-grade.
Do not use stale numbers for pricing, launch, investor, resourcing, reliability,
scaling, or architecture decisions without a fresh source-of-truth update.
