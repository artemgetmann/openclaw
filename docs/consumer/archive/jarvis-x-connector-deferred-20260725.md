# Jarvis X Connector Deferred Decision

Status: deferred decision record, not an active launch task.

## Decision

Use `xurl` for Artem's personal X proof now. Do not build a consumer-facing
Jarvis X connector until Artem explicitly decides to offer X integration to
users.

When that trigger occurs, build a native Jarvis connector on the official X
API with OAuth, a small typed tool surface, usage limits, and approval-gated
publishing. Do not make raw MCP configuration or Birdclaw the product core.

## Current proof

On 2026-07-26, official `xurl` 1.3.1 was connected to the pay-per-use
`Jarvis xurl Read Proof` app. OAuth2 user context was proved live with
`whoami` for `@artemgetman_`; app-only and user tokens are stored locally.
The default xurl OAuth request includes write scopes, so the completed login
was deliberately narrowed to read scopes plus `offline.access`. Do not rerun
the default broad-scope consent flow.

The $5 prepaid purchase completed with the $5 billing-cycle cap still active
and auto-recharge off. The first bounded live batch then proved post read,
10-result search, profile lookup, 4 mentions, and 10 bookmarks. X reported
$0.08 current-cycle spend and a $5.00 remaining prepaid balance immediately
after the proof. No X write action was attempted.

The daily Jarvis Telegram bot also fetched the same 10 bookmarks live, and all
post IDs matched a direct xurl cross-check. The personal machine default is
`jarvis-x-read`, so the natural bounded command `xurl bookmarks -n 10` uses the
approved OAuth2 app without embedding credentials or app-selection details in
future prompts.

## Productization trigger

Revisit this record when Artem says that X integration should be offered to
Jarvis users or testers. The first product slice is read/search/profile/
mentions/bookmarks, followed by preview plus explicit approval for posts and
replies. Do not start with DMs, autonomous actions, raw MCP exposure, or
Birdclaw-style archive memory.

## Personal read-cost boundary

The personal proof is complete. Keep agent-driven access read-only and route
reads through the executable guard owned by `skills/xurl`. The default task
limit is 10 returned resources. A larger read requires fresh confirmation for
the exact result count and displayed maximum estimated cost. Never split a task
into repeated calls to evade the task limit. Raw reads, streaming, and automatic
pagination remain blocked; auto-recharge remains off.
