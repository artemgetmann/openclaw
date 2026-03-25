# OpenClaw Consumer Product

Read this before doing consumer-product work in this repo.

## What this repo context means

- This checkout is being used for the OpenClaw consumer product.
- Treat consumer-product work as separate from upstream `openclaw/openclaw` maintainer flow.
- Default stance: consumer-product work lives in this fork unless the user explicitly asks for upstream work.

## Branch targets

- Consumer-product integration branch: `codex/consumer-openclaw-project`
- Legacy branch: `consumer`
- General fork work that is not consumer-product work can still target this repo's `main`
- Only use upstream `openclaw/openclaw` PR flow when the user explicitly asks
- Do not recreate `consumer` for new work. It is legacy-only.
- If the user says "consumer branch", treat that as `codex/consumer-openclaw-project` unless they explicitly ask for the legacy `consumer` branch.
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

- Full execution plan:
  - `docs/consumer/openclaw-consumer-execution-spec.md`
- Sprint kickoff prompt:
  - `docs/consumer/CODEX-PROMPT.md`
- GTM and packaging direction:
  - `docs/consumer/openclaw-consumer-go-to-market-plan.md`
- Execution board:
  - `docs/consumer/openclaw-consumer-brutal-execution-board.md`
- Investor context:
  - `docs/consumer/openclaw-consumer-investor-brief-1page.md`
- Deferred GUI-control decision:
  - `docs/consumer/gui-control-mvp-decision.md`

## Operating reminders

- Run `pnpm consumer:preflight` before consumer GUI verification
- Ask before doing GUI automation or screenshots that can steal focus on the user's live Mac
- Do not point new consumer-product PRs at `consumer` unless the user explicitly asks
- Do not assume upstream workflow is relevant just because the fork originated there
- If a startup doc grows into a wiki again, cut it down and move the bulk into `docs/consumer/*`
