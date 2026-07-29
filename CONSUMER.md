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

## Work Scope Contract

Before implementation or shipping, classify the work explicitly:

- Product-wide: intended for Jarvis users generally. Product defaults, copy,
  fixtures, and behavior must be user-agnostic. Do not bake in Artem's accounts,
  paths, IDs, contacts, preferences, or private workflows.
- Artem-specific: founder dogfood, private automation, local configuration, or
  one-machine runtime delivery. Keep it outside product defaults, or behind an
  explicit user-supplied configuration or opt-in boundary.
- If the classification is unclear or changes during the task, stop and resolve
  it before implementation or shipping.

State the classification and delivery target in the plan, PR, and closeout. A
merge to `main`, deployment to Artem's main Jarvis, and a shipped Jarvis product
release are separate claims. Main-Jarvis proof covers one installation only;
product shipping requires the applicable package/release and fresh-user proof.

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
