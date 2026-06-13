# Jarvis Launch Package

Status: Jarvis trusted-tester launch package
Owner: Artem
Last updated: 2026-06-13

Purpose: launch-facing package, pricing, copy, and artifact truth.

Use this document for what Jarvis says, sells, packages, and ships. Keep current
task status in `docs/research/jarvis-consumer-launch-plan.md`. Keep historical
release proof in `docs/consumer/archive/jarvis-launch-package-history-20260613.md`.

## Brand Boundary

Jarvis is the public consumer brand from the start. OpenClaw can appear as
technical, developer, repo, or "powered by OpenClaw" language only.

Public-facing app/docs, visible app name, release artifacts, and app icon are
Jarvis now.

Trusted testers can receive the current package with the existing technical
identity:

- visible product: Jarvis
- current bundle/runtime/update identity: `ai.openclaw.consumer.mac` plus
  OpenClaw paths
- reason: fastest safe path for the small trusted tester ring

Before broad public launch, make a deliberate identity/update-path decision.
Full migration to `ai.jarvis.mac` is recommended if the goal is clean brand,
permissions, LaunchAgent identity, and update continuity. If speed wins, the
alternative is to keep `ai.openclaw.consumer.mac` for one more public-ish beta
and document that as internal identity debt.

## Current Release

Trusted-tester send is unblocked.

- Current trusted-tester release: `v2026.3.23`
- Sendable DMG:
  `https://github.com/artemgetmann/openclaw/releases/latest/download/Jarvis.dmg`
- Release page:
  `https://github.com/artemgetmann/openclaw/releases/tag/v2026.3.23`
- Public assets: `Jarvis.dmg`, `Jarvis.zip`, `jarvis-appcast.xml`
- App version/build: `2026.3.23` / `2026061317`
- Public asset metadata checked on 2026-06-13:
  - `Jarvis.dmg` size `341287463`
  - `Jarvis.zip` size `499325709`
  - `jarvis-appcast.xml` size `1134`
  - created at `2026-06-13T10:07:06Z`

Accepted proof:

- Local installed proof passed on Artem's Mac for app version `2026.3.23`,
  build `2026061317`, commit `a1a094ef2a`.
- A separate user's Mac manually installed the public DMG from an older Jarvis
  `2026.3.14` install and reached Settings -> AI access with
  `Continue with ChatGPT` selected and no helper-repair message.
- Same-user onboarding and 2026-06-09 Gate2 clean-user proof are accepted for
  the trusted-tester release gate.
- Gate2 details remain in
  `docs/consumer/jarvis-consumer-rc-closeout-20260606.md`.

Open release proof:

- Full Sparkle update-cycle proof is still needed before relying on updates for
  recovery or broader distribution. Current proof covers live appcast metadata,
  older-app prompt/download readiness, and manual public DMG replacement, not a
  complete download/verify/install/relaunch/preserve-state Sparkle update.

Future Jarvis packages and updates must come from the canonical publish lane:

```bash
bash scripts/package-openclaw-mac-dist.sh --publish-release-assets --github-release-tag <latest-tag>
```

## Backend And Account Truth

Current beta backend:

- Render service: `jarvis-backend`
- Service ID: `srv-d80sqc8g4nts738v1j80`
- URL: `https://jarvis-backend-klvq.onrender.com`
- Region/plan: `virginia` / `starter`
- Source: `https://github.com/artemgetmann/openclaw` on `main`

Current launch-facing truth:

- `/healthz` is live and reports production mode.
- OpenAI, Firecrawl, Google Places, Gemini, and Brave provider env are
  configured server-side.
- Anthropic is not configured yet.
- Neon persistence is configured server-side.
- Account activation creates a persisted 14-day trial.
- License status succeeds for a valid account token.
- Repeated activation for the same email fails closed with 409.
- Invalid account access tokens reject with 401.
- Managed Bots env is enabled on Render, and live Managed Bots start/status
  proof passed with token output redacted.

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

Do not turn the trusted-tester send into a broad public launch. Broader launch
still needs real tester feedback, fuller Sparkle update-cycle proof, and an
identity/update-path decision.

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

Trial/account rules:

- Trial: 14 days.
- Trial entry: account login required.
- Credit card: not required for the first GitHub/Reddit beta.
- Later paid ads: require credit card before trial.
- Offline grace: 7 days after the last successful license check.
- Expired account keeps local export access.
- Expired account loses automatic updates, managed services, and support.

Provider boundaries:

- Primary model usage should use user subscription/login where supported.
- Backend-managed utilities are capped and server-side.
- Raw founder/provider keys must never be packaged inside the app.
- Raw founder/provider keys must never be sent to the app.
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
- third-party skills can run code and should be treated as untrusted until
  reviewed
- external tools should be installed only from sources the user trusts
- internal identity remains `ai.openclaw.consumer.mac` for trusted testers
- full Sparkle update-cycle proof is still needed before broader distribution

## 60-Second Demo

Goal: prove Jarvis is an operator, not a chatbot.

0-5 seconds:

> "This is Jarvis: a local-first AI assistant that runs on my Mac and answers in
> Telegram."

5-12 seconds:

> "I am going to delegate a real task like I would to a human assistant."

Show Telegram prompt:

```text
Jarvis, check my launch notes, tighten the README pricing section, and give me
the exact diff before you change anything.
```

12-25 seconds:

Show Jarvis reporting what it will inspect:

> "Jarvis checks the local repo, reads the launch plan, and decides what needs
> changing."

25-40 seconds:

Show local action: file, browser, terminal, diff preview, or Telegram progress.

40-52 seconds:

Show final Telegram answer with what changed, what was verified, and what still
needs a human decision.

52-60 seconds:

> "Jarvis is open source, Mac-first, and built for delegation. Start with
> Personal if you want the normal consumer path, or Core if you want raw
> API-key control."

## Roadmap

| State                      | Launch-facing item                                                                                                                                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Done for trusted testers   | Jarvis visible branding, public `v2026.3.23` DMG/ZIP/appcast assets, local installed-app proof, separate-user public-DMG install proof, account/trial backend, managed utility backend, Managed Bots-first Telegram path, and Gate2 clean-user proof. |
| Next tester ring           | Send the `v2026.3.23` DMG, watch first real install/use feedback, and keep package secret-safety plus release-asset verification on every new build.                                                                                                  |
| Before broad public launch | Identity/update-path decision, fuller Sparkle update-cycle proof, onboarding copy/friction fixes from tester feedback, `/visibility` command cleanup, and Telegram settings/model cleanup if tester feedback shows confusion.                         |
| Deferred                   | Maintenance work that has no tester evidence yet.                                                                                                                                                                                                     |

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
- Decide whether broad public launch migrates to `ai.jarvis.mac` first or ships
  one more public-ish beta on `ai.openclaw.consumer.mac` with identity debt
  documented.
