# Telegram As-Me Implementation Plan

## Summary

Build the first Telegram-as-me integration on top of OpenClaw's existing in-repo `telegram-user` MTProto path. Do not replace the runtime foundation with a third-party wrapper CLI for v1. Keep the existing Telegram bot-account channel separate. Run a bounded parallel spike later against one serious alternative transport foundation only if the current path still shows meaningful pain.

Chosen direction:

- Main path: harden and productize the current in-repo `telegram-user` lane.
- Parallel evaluation: compare against one serious alternative foundation only.
- Rejected as v1 foundations: Bot API tools, legacy Telegram CLI projects, weak-provenance ClawHub wrappers, and Beeper.

## Final Decisions

- Product contract:
  - OpenClaw must read Telegram messages sent to the user and reply from the user's real Telegram account.
  - This is explicitly not a Telegram bot-account feature.
- V1 transport:
  - Use the existing in-repo `telegram-user` path built around the current MTProto tooling.
  - Do not replace it with `baontq23/node-telegram-cli` or `arein/tg`.
  - Reason: neither external wrapper beats the current path on reliability, thread/topic awareness, or integration control.
- Explicitly deferred:
  - Beeper as primary transport
  - ClawHub bot/token skills
  - Telegram MCP wrappers as core runtime
  - Additional broad market search

## Why External Candidates Lost

- `baontq23/node-telegram-cli`
  - Credible standalone CLI.
  - Supports real-account read/send.
  - Still a small, new, single-maintainer wrapper with weak adoption and no behavior test suite.
  - Does not beat the current OpenClaw path on reliability or embedding effort.
- `arein/tg`
  - Supports real-account read/send.
  - Provenance is weak enough that it should not be trusted as a product dependency.
- Legacy Telegram CLI projects
  - Not a serious maintenance bet for current OpenClaw work.
- Bot API tools
  - Wrong product shape because they reply as a bot, not as the user's real account.

## Implementation Changes

- Productize `telegram-user` from operator/E2E tooling into a supported internal Telegram-as-me adapter.
- Reuse existing OpenClaw Telegram routing, session, and thread abstractions instead of creating a second messaging model.
- Keep the existing Telegram bot channel separate from the Telegram-as-me channel so bot-account behavior and user-account behavior cannot drift into one another.

Behavior to support in v1:

- sign in to a real Telegram account
- health/precheck for session validity
- read recent messages from a target chat
- wait for matching replies
- send and reply as the user
- preserve thread/topic-aware matching where the current path already supports it
- clear error states for expired session, bad OTP/2FA, and missing credentials

User-facing v1 scope:

- Telegram-only
- one account
- text-first
- basic media only if already trivial through the current path
- no broad history sync promises
- no contact-list import promises
- no omnichannel abstraction

Mac/app surface required:

- connect/login status
- session healthy / expired / needs reauth
- reconnect / logout
- explicit warning that this uses the user's real Telegram account

## Parallel Spike

Run one short isolated spike against one alternative foundation only.

Candidate class:

- `TDLib`-based approach
- `tgclient`

Goal:

- determine whether future migration is worth it
- do not block v1 on this spike

Compare current `telegram-user` path vs candidate foundation on:

- auth friction
- session durability
- message read/send correctness
- thread/topic handling fit
- embedability into OpenClaw
- maintenance burden
- dependency trust and provenance

Decision rule:

- keep current path unless the alternative is clearly better on at least two of:
  - transport reliability
  - embedding simplicity
  - long-term maintenance risk
- if the result is only "roughly similar", stay on the current path

## Test Plan

Required validation for the main implementation lane:

- real-account login succeeds with phone + OTP and survives restart
- session expiry/failure states surface clearly
- read returns recent messages from a target chat
- send delivers to a target chat as the user
- reply/wait matching works for a real conversational roundtrip
- thread/topic-aware cases still behave correctly where supported today
- no raw secrets leak in logs or CLI errors
- concurrent invocations do not corrupt session state

Acceptance criteria:

- user can connect their Telegram account
- OpenClaw can read a message from a chosen chat
- OpenClaw can send a reply from that same real Telegram account
- the path is stable enough for product use without depending on third-party wrapper trust

## Assumptions

- The product goal is Telegram-as-me, not Telegram bot-account messaging.
- Fastest viable shipping path matters more than transport purity for v1.
- The current in-repo `telegram-user` lane already provides enough real behavior to justify hardening instead of replacing immediately.
- `baontq23/node-telegram-cli` is credible but not strong enough to justify adoption.
- `arein/tg` is not trustworthy enough to adopt.
- Beeper remains a later optional expansion lane, not the first foundation.
