---
current_stage: private_beta
users_total: 20
paying_users: 0
active_beta_users_7d: TBD
updated_at: 2026-06-13
stale_after_days: 14
source_of_truth: Founder-reported beta snapshot plus 2026-06-09 Gate2 clean-user proof and 2026-06-13 v2026.3.23 public release/manual install proof.
decision_implication: Trusted-tester send is unblocked; broader launch still needs an identity/update-path decision, fuller Sparkle update-cycle proof, and real tester feedback.
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

Trusted-tester send is unblocked. Public `v2026.3.23` Jarvis release assets are
live, same-user onboarding and Gate2 clean-user proof are accepted, and a
separate user's Mac manually installed the public DMG and reached Settings -> AI
access with `Continue with ChatGPT` selected and no helper-repair message.

Next decision inputs:

- first real tester install/use feedback
- onboarding copy/friction fixes found from that feedback
- fuller Sparkle update-cycle proof
- identity/update-path decision before broader public launch

Full migration to `ai.jarvis.mac` is recommended before broad public launch if
the priority is clean brand, permissions, LaunchAgent identity, and update
continuity. If speed wins, keeping `ai.openclaw.consumer.mac` for one more
public-ish beta is a deliberate debt decision, not a trusted-tester blocker.

These numbers expire after `stale_after_days`. Once expired, they are not decision-grade.
Do not use stale numbers for pricing, launch, investor, resourcing, reliability,
scaling, or architecture decisions without a fresh source-of-truth update.
