---
current_stage: private_beta
users_total: 20
paying_users: 0
active_beta_users_7d: TBD
updated_at: 2026-05-14
stale_after_days: 14
source_of_truth: Founder-reported beta snapshot in the Jarvis project-status context slice.
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

The current planning snapshot is about 20 total users, 0 paying users, and
`active_beta_users_7d` is still TBD until analytics or an explicit beta-activity
source is wired in.

Current beta blocker: onboarding to first useful task still needs a cleaner
account/AI-access/Telegram sequence before the next tester package is worth
sending.

These numbers expire after `stale_after_days`. Once expired, they are not
decision-grade and must not be used for pricing, launch, investor, or resourcing
decisions without a fresh source-of-truth update. The same rule applies to
reliability, scaling, and architecture calls.
