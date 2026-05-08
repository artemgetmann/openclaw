# OpenClaw Consumer Product

Read this before doing consumer-product work in this repo.

## What this repo context means

- This checkout is being used for the OpenClaw consumer product.
- Treat consumer-product work as separate from upstream `openclaw/openclaw` maintainer flow.
- Default stance: consumer-product work lives in this fork unless the user explicitly asks for upstream work.

## Branch targets

- Consumer-product work now targets this repo's `main`.
- Legacy/emergency fallback branch: `codex/consumer-openclaw-project`
- Legacy branch: `consumer`
- Only use upstream `openclaw/openclaw` PR flow when the user explicitly asks
- Do not recreate or target `consumer` for new work. It is legacy-only.
- Do not target `codex/consumer-openclaw-project` unless the user explicitly declares an emergency backport.
- If the user says "consumer branch", clarify whether they mean the legacy fallback before doing work there.
- Never merge `upstream/main` into this fork. Upstream changes come in through selective intake.

## Product contract

- Product shape: personal AI operator running on the user's own Mac
- Primary interface: Telegram
- Product bar: simplify aggressively; remove complexity before adding anything
- Default mode for current product work: move fast, prove behavior, avoid speculative platform work unless asked

## What belongs here vs elsewhere

- Keep this file to identity, branch targets, and product-level guardrails
- Put execution plans, sprint boards, GTM, investor notes, and long-form decisions in `docs/consumer/*`

## Load the right doc for the task

- Main/consumer consolidation and retirement:
  - `docs/consumer/openclaw-main-consumer-consolidation-plan.md`
  - `docs/consumer/openclaw-main-consumer-divergence-tracker.md`
- Launch/business plan:
  - `docs/research/jarvis-consumer-launch-plan.md`
- Archived execution docs:
  - `docs/consumer/archive/openclaw-consumer-execution-spec.md`
  - `docs/consumer/archive/consumer-execution-tracker.md`
  - `docs/consumer/archive/openclaw-consumer-brutal-execution-board.md`
- Sprint kickoff prompt:
  - `docs/consumer/CODEX-PROMPT.md`
- GTM and packaging direction:
  - `docs/consumer/openclaw-consumer-go-to-market-plan.md`
- Hosted architecture decision:
  - `docs/consumer/openclaw-consumer-hosted-architecture-decision.md`
- Investor context:
  - `docs/consumer/openclaw-consumer-investor-brief-1page.md`
- Deferred GUI-control decision:
  - `docs/consumer/gui-control-mvp-decision.md`

## Operating reminders

- Do not point new consumer-product PRs at `consumer` or `codex/consumer-openclaw-project` unless the user explicitly asks for an emergency backport
- Do not assume upstream workflow is relevant just because the fork originated there
- If a startup doc grows into a wiki again, cut it down and move the bulk into `docs/consumer/*`
