---
current_stage: private_beta
users_total: TBD
paying_users: TBD
active_beta_users_7d: TBD
updated_at: 2026-06-09
stale_after_days: 14
source_of_truth: 2026-06-09 refresh confirmed no newer founder-reported beta snapshot than the older private-beta note, so counts are intentionally TBD until a verified refresh is recorded.
decision_implication: Use this only for launch, pricing, reliability, scaling, and architecture context while fresh; expired numbers are not decision-grade.
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

There is no fresh verified beta count in this branch as of 2026-06-09, so
`users_total`, `paying_users`, and `active_beta_users_7d` are intentionally
`TBD` until a founder-reported snapshot or analytics-backed refresh is recorded.

Current beta blocker: onboarding to first useful task still needs a cleaner
account/AI-access/Telegram sequence before the next tester package is worth
sending.

These numbers expire after `stale_after_days`. Once expired, they are not
decision-grade and must not be used for pricing, launch, investor, or resourcing
decisions without a fresh source-of-truth update. The same rule applies to
reliability, scaling, and architecture calls.
