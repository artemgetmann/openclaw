---
current_stage: private_beta
users_total: 20
paying_users: 0
active_beta_users_7d: TBD
updated_at: 2026-06-24
stale_after_days: 14
source_of_truth: Founder-reported beta snapshot plus 2026-06-09 Gate2 clean-user proof, 2026-06-24 Jarvis 2026.6.24 build 2026062402 release proof, public appcast proof, clean shipped-build smoke, and repo main at e2f67c810a.
decision_implication: Trusted-tester send is unblocked with the current hotfix; broader launch now needs real tester feedback and concrete onboarding fixes only if feedback blocks.
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

Trusted-tester send is unblocked. Current public Jarvis assets install as
`2026.6.24` build `2026062402`; same-user onboarding, Gate2 clean-user proof,
separate-user manual DMG install proof, and 2026-06-24 public appcast proof are
accepted. A clean shipped-build smoke passed against the public DMG with
isolated fake-home state and `real_user_config_unchanged=yes`.

Repo `main` includes the public Jarvis identity migration, #960 packaged
gateway ownership fix, #969 AI Access onboarding fix, #970 backend config
refresh fix, #971 Telegram metadata blocker fix, and #972 Telegram setup replay
fix. The current public appcast contains those fixes.

Next decision inputs:

- first real tester install/use feedback
- onboarding copy/friction fixes found from that feedback

Broad-public repo defaults now target `ai.jarvis.mac`, Jarvis state, and
`ai.jarvis.gateway`. Keep old trusted-tester state separate unless Artem
explicitly chooses a migration tool; macOS permissions are bundle-id scoped, so
clean-start behavior is the safer default until proven otherwise.

These numbers expire after `stale_after_days`. Once expired, they are not decision-grade.
Do not use stale numbers for pricing, launch, investor, resourcing, reliability,
scaling, or architecture decisions without a fresh source-of-truth update.
