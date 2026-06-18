# Jarvis Product Context

Read this before doing Jarvis product work in this repo.

Jarvis is the consumer-facing product. OpenClaw is the technical engine, repo,
and developer language. Do not frame OpenClaw as the consumer brand unless the
user explicitly asks.

## Product Contract

- Jarvis is a personal AI operator running on the user's own Mac.
- Telegram is the current primary interface.
- The product bar is subtraction first: remove complexity before adding knobs.
- Current product work should move fast, prove behavior, and avoid speculative
  platform work unless asked.

## Branch Targets

- Jarvis product work targets this repo's `main`.
- `consumer` and `codex/consumer-openclaw-project` are legacy fallback branches.
- Do not target either legacy branch unless the user explicitly asks for an
  emergency backport.
- Never merge `upstream/main` into this fork. Upstream intake is selective only.

## Product Docs

Use `docs/jarvis/README.md` as the product-doc map.

Read `docs/jarvis/VISION.md` before product, UX, launch, pricing, onboarding,
or strategy work. Do not load it for unrelated engineering tasks.
