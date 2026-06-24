# Jarvis Launch Package

Status: Jarvis launch package truth
Owner: Artem
Last updated: 2026-06-24

Purpose: launch-facing package, pricing, copy, and artifact truth.

Use this document for what Jarvis says, sells, packages, and ships. Keep current
task status in `docs/research/jarvis-consumer-launch-plan.md`. Keep historical
release proof in `docs/consumer/archive/jarvis-launch-package-history-20260613.md`.

## Brand Boundary

Jarvis is the public consumer brand from the start. OpenClaw can appear as
technical, developer, repo, or "powered by OpenClaw" language only.

Public-facing app/docs, visible app name, release artifacts, and app icon are
Jarvis now.

Trusted testers can receive the current public package with the Jarvis
technical identity:

- visible product: Jarvis
- current bundle/runtime/update identity: `ai.jarvis.mac`,
  `~/Library/Application Support/Jarvis/.jarvis`, and `ai.jarvis.gateway`
- reason: fastest safe path for the small trusted tester ring

Repo `main` now targets the broad-public Jarvis identity: `ai.jarvis.mac`,
`~/Library/Application Support/Jarvis/.jarvis`, and `ai.jarvis.gateway`. It
also includes #960 packaged-gateway ownership and stale OpenClaw LaunchAgent
cleanup.

Keep old trusted-tester state cleanly separated unless Artem explicitly chooses
a migration path: macOS permissions are bundle-id scoped, and dragging the old
tester identity into public launch creates update and support debt.

## Current Release

Trusted-tester send is unblocked.

- Current Jarvis app version/build: `2026.6.24` / `2026062402`
- Sendable DMG:
  `https://github.com/artemgetmann/openclaw/releases/latest/download/Jarvis.dmg`
- Release page:
  `https://github.com/artemgetmann/openclaw/releases/tag/v2026.6.19`
- Public assets: `Jarvis.dmg`, `Jarvis.zip`, `jarvis-appcast.xml`
- Public asset metadata was checked on 2026-06-24.
- This package contains the merged #953/#960 broad-public package/runtime fixes
  plus the #969-#972 AI Access and Telegram setup hotfixes.

Accepted proof:

- Local proof passed for app version `2026.6.24`, build `2026062402`, commit
  `e2f67c810a`.
- Release wrapper reported `release_sendable=true` and `sparkle_update_live=true`.
- Public appcast advertises short version `2026.6.24`, build `2026062402`.
- App and DMG notarization were accepted, stapled, and Gatekeeper-accepted as
  Notarized Developer ID.
- Clean shipped-build smoke passed against the public DMG with
  `fresh_user_smoke=passed`, `onboarding_window=observed`, and
  `real_user_config_unchanged=yes`.
- Installed LaunchAgent proof verified `ai.jarvis.gateway`, Jarvis state, and
  no `OPENCLAW_ALLOW_NONCANONICAL_SHARED_RUNTIME` override.
- A separate user's Mac manually installed the public DMG from an older Jarvis
  `2026.3.14` install and reached Settings -> AI access with
  `Continue with ChatGPT` selected and no helper-repair message.
- Same-user onboarding and 2026-06-09 Gate2 clean-user proof are accepted for
  the trusted-tester release gate.
- Gate2 details remain in
  `docs/consumer/archive/jarvis-consumer-rc-closeout-20260606.md`.

Open release proof:

- Current proof covers live appcast metadata, public asset replacement,
  notarization, manual app/package verification, and a clean shipped-build
  smoke. Keep relying on tester feedback for first-run friction.

Future broad-public Jarvis packages and updates must come from the canonical
publish lane and verify as `ai.jarvis.mac`, Jarvis state path,
`ai.jarvis.gateway`, and #960 behavior before release:

```bash
bash scripts/package-openclaw-mac-dist.sh --publish-release-assets --github-release-tag <latest-tag>
```

## Backend And Account Truth

Current beta backend: `jarvis-backend`
(`https://jarvis-backend-klvq.onrender.com`), Render service
`srv-d80sqc8g4nts738v1j80`, `virginia` / `starter`, sourced from this repo's
`main`.

Current launch-facing truth:

- `/healthz` is live in production mode.
- OpenAI, Firecrawl, Google Places, Gemini, Brave, Neon, and Managed Bots are
  configured server-side.
- Anthropic is not configured yet.
- Account activation creates a persisted 14-day trial; valid license checks
  pass, repeated activation fails closed with 409, and invalid tokens reject
  with 401.

Google Places details/resolve/reviews and Nano Banana input-image editing still
require direct BYOK until the backend exposes managed utilities for those
shapes.

## Trusted Tester Send

Use this DMG for the next waiting testers:

```text
https://github.com/artemgetmann/openclaw/releases/latest/download/Jarvis.dmg
```

Recommended send note:

```text
Here is the current Jarvis Mac beta:

https://github.com/artemgetmann/openclaw/releases/latest/download/Jarvis.dmg

It is Mac-first and Telegram-first. Install it, open Jarvis, connect ChatGPT in
Settings -> AI access, then follow the Telegram setup. I want your first real
install/use feedback: where setup feels confusing, where Jarvis gets stuck, and
whether the first useful task is obvious.
```

Do not turn the trusted-tester send into a broad public launch without real
tester feedback from the current package.

## Commercial Package

Launch with Jarvis Personal as the main consumer path. Model usage should use
the user's provider subscription/login where supported. Backend-held
founder/provider keys are limited to managed utilities, onboarding fallback,
controlled beta support, and non-model tool surfaces.

| Plan                     | Price    | Buyer                      | Public at launch | Main boundary                                   |
| ------------------------ | -------- | -------------------------- | ---------------- | ----------------------------------------------- |
| Jarvis Personal          | $99/mo   | normal consumers           | yes              | subscription-login models plus capped utilities |
| Jarvis Core              | $19/mo   | technical and power users  | yes              | BYOK raw API keys and advanced provider setup   |
| Jarvis Founder Concierge | $299/mo+ | high-touch pilot customers | no               | onboarding, workflow setup, priority support    |

Trial/account rules: 14-day account-login trial; no card for the first
GitHub/Reddit beta; later paid ads require a card before trial; 7-day offline
grace after the last successful license check; expired accounts keep local
export access but lose automatic updates, managed services, and support.

Provider boundaries:

- Primary model usage should use user subscription/login where supported.
- Backend-managed utilities are capped and server-side.
- Raw founder/provider keys must never be packaged inside or sent to the app.
- BYOK raw API keys are an advanced escape hatch, not the default consumer path.
- Unlimited backend-paid model usage at consumer pricing is a margin trap. Do
  not ship it.

## README Launch Outline

The launch README should be practical, not a marketing site.

Above the fold:

> Jarvis is a local-first AI assistant for Mac that actually does things.

Subhead:

> Talk to Jarvis in Telegram. It runs on your Mac, uses your apps and sessions,
> local tools, and allowed external tools, and can handle real workflows across
> browser, files, messages, code, and automations.

Primary links:

- Download for macOS
- Watch 60-second demo
- Start 14-day trial
- Read the local-first privacy story

Pricing copy:

> Start with a 14-day no-card trial during the early GitHub/Reddit beta.
> Personal is the main consumer plan: use your existing provider subscriptions
> where supported, while Jarvis covers capped utilities and setup fallback
> through the backend. Core is the advanced BYOK plan for people who want raw
> API-key control.

Honest limitations:

- macOS first
- Telegram first
- setup is improving fast, but early users should expect sharp edges
- primary model subscription/login support depends on each provider surface
- Core/BYOK users must bring their own raw provider keys
- third-party skills and external tools should be trusted before use
- public packages must verify Jarvis identity, #960 behavior, and full Sparkle
  update-cycle proof

## Roadmap

- Done for trusted testers: Jarvis visible branding, public Jarvis
  assets, installed-app proof, backend/trial proof, Managed Bots path, and Gate2
  clean-user proof.
- Done in repo `main`: broad-public Jarvis identity defaults and #960
  packaged-gateway ownership behavior.
- Done in current package: `ai.jarvis.mac`, Jarvis state, `ai.jarvis.gateway`,
  stale OpenClaw LaunchAgent cleanup, and no need for
  `OPENCLAW_ALLOW_NONCANONICAL_SHARED_RUNTIME=1`.
- Before broad public launch: onboarding fixes from tester feedback and a narrow
  legacy Telegram group allowlist migration follow-up for existing migrated
  users.

## Launch Copy

Reddit/GitHub angle:

> I built a local-first Jarvis for Mac that can actually operate your computer.
> It is open source, Telegram-first, and I am looking for early users who want a
> personal AI operator instead of another chatbot.

One-line product description:

> Jarvis is a Telegram-first AI operator that runs on your Mac and gets real
> computer work done.

Pricing one-liner:

> Personal is $99/mo for the simple consumer path. Core is $19/mo for advanced
> BYOK raw API-key users.

## Open Artem Decisions

- Confirm exact public wording for "powered by OpenClaw" in developer-facing
  surfaces.
- Decide whether old trusted-tester state starts clean under `ai.jarvis.mac` or
  gets a small manual migration runbook before broader distribution.
- Decide whether the legacy Telegram group allowlist carry-over PR should merge
  before the next packaged update or remain a support/runbook-only fix.
