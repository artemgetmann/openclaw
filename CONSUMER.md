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

Discussion is not implementation approval. Before changing Jarvis behavior,
state the one observable result being implemented, what remains outside the
change, and the authorized delivery target. If the user is still comparing
options, asking what should be built, or approving only a general direction,
remain read-only. A new independent result or product decision requires fresh
confirmation before implementation continues.

Before implementation or shipping, classify the work explicitly:

- Product-wide: intended for Jarvis users generally. Product defaults, copy,
  fixtures, and behavior must be user-agnostic. Do not bake in Artem's accounts,
  paths, IDs, contacts, preferences, or private workflows.
- Artem-specific: founder dogfood, private automation, local configuration, or
  one-machine runtime delivery. Keep it outside product defaults, or behind an
  explicit user-supplied configuration or opt-in boundary.
- If the classification is unclear or changes during the task, stop and resolve
  it before implementation or shipping.

For behavior requests, interpret the smallest amount of language needed:

- Explicit `my Jarvis`, `local`, `on this Mac`, or private customization means
  Artem-specific unless the request also names users, product, packaging, or a
  release.
- Unqualified requests to change, fix, or add Jarvis behavior mean product-wide.
- An explicit source, PR, package, installed-runtime, or public-release boundary
  sets the delivery target. Otherwise product-wide behavior defaults to the
  `source` delivery target, including focused proof and the normal PR/merge
  lifecycle when requested.

Generic `ship` or `ship end-to-end` language does not widen that source target.
It does not authorize packaging, signing, notarization, or a public Jarvis app
release. Before a public Sparkle release or update, obtain fresh action-time
confirmation that explicitly names the public release or Sparkle update. A
current request that unmistakably names that same public-release action already
satisfies this confirmation; generic completion language does not.

The product default keeps the separate live-chat restart confirmation. An owner
who treats restarts as routine execution may set
`commands.restartConfirmation: false`. For that configured owner, an authorized
installed-runtime delivery includes its documented gateway restart without a
second approval turn. This preference does not select an installed-runtime target
or authorize packaging, signing, notarization, installation, or publication.

State the classification and delivery target in the plan, PR, and closeout.
Use the enforceable receipt in
`docs/agent-guides/jarvis-delivery-boundary.md`; CI rejects missing or inflated
Jarvis receipts. A merge to `main`, deployment to
Artem's main Jarvis, and a shipped Jarvis product release are separate claims.
Main-Jarvis proof covers one installation only; product shipping requires the
applicable package, upgrade, release, and end-user receipts.

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
