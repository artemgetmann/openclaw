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

Jarvis is in private beta.

The current planning snapshot is about 20 total users, 0 paying users, and
`active_beta_users_7d` is still TBD until analytics or an explicit beta-activity
source is wired in.

Current Telegram onboarding status: Managed Bots is live-proven on Render with
redacted health and start/status smokes. The normal beta path stays DM-first:
create the Jarvis Telegram bot, approve it in Telegram, send one direct-message
task, then verify the first useful task. Visual-only macOS smoke can prove
onboarding copy and layout, but first-task verification needs a reachable local
runtime websocket, so use runtime-backed isolated smoke for that gate. Telegram
not-installed fallback is still deferred. Group/threaded setup is important and
tracked as the next Telegram setup step after DM proof. Account activation before
Telegram is still a separate onboarding sequencing gap.

These numbers expire after `stale_after_days`. Once expired, they are not
decision-grade and must not be used for pricing, launch, investor, or resourcing
decisions without a fresh source-of-truth update. The same rule applies to
reliability, scaling, and architecture calls.
