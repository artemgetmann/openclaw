# Jarvis Consumer Launch Plan

Status: finalized strategy draft, implementation tracking started 2026-05-01
Owner: Artem
Urgency: high. The window is open now because Claude, Codex, and OpenFlow still do not land as a reliable personal assistant for normal users. Speed matters.

## 0. Executive decision

Jarvis should be an open-source, local-first macOS personal assistant with a paid commercial layer for updates, onboarding, subscription/license control, and optional managed cloud/API services.

North Star positioning:

> Jarvis is the iPhone/MacBook of AI agents: a proactive, self-improving AI assistant that actually does things and just works.

This does not mean users lose power. It means the default experience is consumer-simple, while developers can still go deeper through custom skills, developer mode, and forks.

The first public motion should be Reddit + GitHub, not a polished paid-ads funnel. Website comes after the core install/payment/update story is credible.

### 0.1 Final decisions for implementation

This section is the implementation-oriented summary. If a coding agent needs one source of truth, start here.

1. **Product shape:** Jarvis is a bot-first, app-backed, local-first AI assistant. Telegram/Jarvis is the primary decision/explanation surface; the macOS app handles local install, update, permissions, restart, backups, and runtime health.
2. **Default mode:** v1 defaults to **Autopilot / Full Access** for early users. Jarvis should be useful first, not approval-spammy.
3. **Deferred mode:** **Protected / Approval Mode** is real but later. It is for paranoid users, enterprise, sensitive environments, sandboxing, and stricter approvals.
4. **Transparency:** rename developer-facing verbose behavior into `/visibility off`, `/visibility on`, and `/visibility full`. Prefer visibility, logs, and backups over constant approvals for v1.
5. **Updates:** the app performs update mechanics; Jarvis explains updates and asks decisions in plain English. Normal users see simple choices like **Update safely**, **Keep as is**, and **Show details**.
6. **Self-modification:** normal users customize memory, settings, workflows, and user-space skills. Core engine changes require Developer Mode or a fork and are documented on GitHub/docs, not pushed into normal product UX.
7. **Skills:** bundled/official skills are safe defaults. Third-party skills are powerful but untrusted by default. ClawHub can be enabled for advanced discovery, but should not be marketed as a safe app store.
8. **Skill safety:** bundle or recommend a skill-audit capability so Jarvis can inspect third-party skills before install. This is a review aid, not a guarantee.
9. **Find Skills:** useful as a discovery helper. It should search multiple ecosystems over time, including skills.sh/Vercel-style skills, Anthropic-style skills, ClawHub, and the web. It is not itself a trust system.
10. **Account system:** users need accounts for trials, subscriptions, device registration, managed usage, and update entitlement. Reuse the existing Jarvis voice project account/trial infrastructure where possible. Add Google login if low-effort; do not let auth polish block distribution.
11. **First beta:** the core beta test is self-serve setup: can users install Jarvis, connect what is needed, and reach first value without Artem hand-holding them? If not, do not go broad.
12. **Operator education:** teach users that agents work best through clear natural-language delegation. The website/GitHub should say: tell Jarvis what you want, be specific, give preferences, correct it like a human assistant.
13. **Bootstrap/setup:** initial setup needs redesign around first value. Reduce steps, simplify copy, make blockers obvious, and avoid developer jargon.
14. **Distribution:** start with GitHub/Reddit plus a downloadable signed/notarized macOS app. Website comes when the message and install flow are proven.
15. **Brand:** public consumer brand is **Jarvis** from the start. OpenClaw remains technical/developer/powered-by language only. Visible app/artifact naming should move to Jarvis soon, but bundle ID, runtime identity, update feed identity, and deeper internal renames are a separate migration task.
16. **Commercial package:** v1 public pricing is **Jarvis Personal at $99/mo** for the main consumer path and **Jarvis Core at $19/mo** for advanced raw BYOK API-key users. Primary model usage should use user subscription/login where supported. Backend-held founder/provider keys are for capped managed utilities, onboarding fallback, controlled beta support, and non-model tool surfaces. Raw provider keys must not ship in the app or be sent to the app. Details live in `docs/consumer/jarvis-launch-package.md`.

## 1. Positioning

Jarvis is the AI assistant that actually does things on your Mac.

It is not just a chatbot and not just a coding agent. It can operate across your computer: browser, messages, files, apps, research, automations, and software creation.

Primary wedge:

> A local-first AI assistant that actually gets work done on your Mac.

Secondary wedge:

> You do not need to be a software engineer anymore. Describe the software, website, automation, or workflow you want, and Jarvis builds it.

Target users:

- founders
- operators
- knowledge workers with repetitive computer workflows
- technical power users
- non-technical ambitious users who want leverage without learning APIs, terminals, or agent frameworks

### 1.1 User education: how to operate Jarvis

Jarvis should teach users that agents are operated through clear natural language, not button-click determinism.

Website/GitHub/onboarding copy direction:

> The best way to use Jarvis is to tell it what you want like you would tell a human assistant. Be specific. Tell it your preferences. Tell it what you like and dislike. Correct it when needed. Jarvis gets more useful as it understands how you work.

Why this matters:

- Many users expect software to behave like fixed buttons.
- AI agents behave more like delegated coworkers/assistants.
- Good instructions produce better outcomes.
- This reduces disappointment when users expect one-click deterministic behavior.

## 2. Core architecture

### 2.1 Local-first execution

Primary runtime stays on the user's Mac or Mac Mini.

Why:

- user's browser/session/files/apps are local
- lower infrastructure cost
- better privacy story
- stronger personal assistant positioning
- Mac Mini/dedicated Mac is a clean 24/7 recommendation

### 2.2 Cloud control plane

Jarvis still needs a small backend for:

- accounts
- trial start/end
- subscription/license status
- device registration
- update availability
- managed API proxy for paid plans
- usage metering for managed services
- revocation/pause for unpaid users

Suggested path:

```text
Jarvis macOS app -> Jarvis backend -> billing/license/update/model/tool services
                 -> local OpenClaw/Jarvis runtime -> user's Mac/browser/apps
```

### 2.3 Accounts and auth

Users need accounts for:

- subscription/trial status
- device registration
- managed usage metering
- update entitlement
- support/debug identity

Decision direction:

- [ ] Reuse the existing account/trial/subscription infrastructure from Artem's Jarvis voice project if it is production-usable.
- [ ] Add Google authentication if it is fast and reduces login friction.
- [ ] Do not let a perfect auth system block the first self-serve beta; account login only needs to be good enough for trial/subscription/device tracking.

## 3. Monetization model

The v1 consumer model has one preferred model path and two support paths.

Preferred model path:

- user subscription/login where supported, such as ChatGPT, Claude, or other
  provider subscription surfaces
- keeps primary model cost with the user
- avoids raw API-key setup for normal users

Support paths:

- backend-held founder/provider keys for capped managed utilities, onboarding
  fallback, controlled beta support, and non-model tool surfaces
- raw BYOK API keys for advanced users who want provider/API control

### Option A — BYO Everything / Power User Plan

User brings their own keys/subscriptions:

- model provider keys or subscriptions
- Brave Search key
- Firecrawl key
- Google Maps/Places key
- OpenAI speech-to-text/TTS key
- Gemini/image generation key
- any other expensive or quota-bound provider keys

Jarvis charges for:

- app updates
- installer/onboarding
- local runtime
- skills/workflows
- support-light
- product improvements

Recommended price:

- $19/mo early
- possibly $29/mo once onboarding/reliability is strong

This is the lowest-cost, lowest-risk tier for Artem. It is also more acceptable to power users because they often prefer controlling their own providers.

### Option B — Personal Plan

Jarvis uses user subscription/login for primary model usage where supported,
then provides capped managed utilities and fallback support behind the scenes.

This includes some or all of:

- provider subscription/login setup help
- speech-to-text
- text-to-speech
- Brave-like search
- Firecrawl/scraping
- Google Maps/Places
- image generation
- Nano Banana / Gemini image paths

Recommended price:

- $99/mo for the main consumer path with subscription-login model usage and
  capped managed utilities/fallback
- higher tier later for heavy users or business workflows

Hard opinion: do not offer unlimited backend-paid model/tool usage at consumer
pricing. That is how you build a product where your best users bankrupt you.
Usage limits can be simple and invisible at first, but they must exist.

## 4. API key strategy

### 4.1 Current problem

Today some keys are bundled with the app or seeded into package/config flows, including potentially:

- Google Maps API key
- Brave API key
- Firecrawl API key
- OpenAI key for speech-to-text
- OpenAI key potentially usable by TTS
- OpenAI image generation key if configured
- Gemini/Nano Banana Pro key

This must be audited before strangers receive builds.

### 4.2 Required checklist

- [ ] Inventory all bundled/seeding/configured provider keys in the packaged macOS app.
- [ ] Confirm whether OpenAI STT key can be reused for TTS.
- [ ] Confirm whether OpenAI TTS key can be reused for normal OpenAI chat/completions/image generation.
- [ ] Confirm whether Gemini/Nano Banana Pro key is packaged or read from founder config.
- [ ] Confirm whether Google Maps, Brave, Firecrawl keys are packaged, shell-imported, or runtime-configured.
- [ ] Separate generic model keys from speech-only keys.
- [ ] Add clear config namespaces for each paid provider surface.
- [ ] Remove founder/personal keys from any public package unless deliberately used for a managed plan.
- [ ] For managed plans, route through backend proxy where possible, not directly exposing shared keys inside the app.
- [ ] Add per-user usage accounting for managed surfaces.

### 4.3 Principle

Bundling a shared key directly in the app is acceptable only as a short private-beta bridge. It is not acceptable for public distribution.

If the app contains the key, motivated users can extract it. For public launch, managed provider access should go through a Jarvis backend proxy or signed short-lived credentials with scope/limits.

## 5. Provider usage control

Decision: **primary model usage should use user subscription/login where
supported. Jarvis backend provider keys are for capped managed utilities,
onboarding fallback, controlled beta support, and non-model tool surfaces. BYOK
raw API keys are advanced and stay local by default.**

### 5.1 User subscription/login model path

For primary model usage, Jarvis should prefer the user's own provider
subscription or logged-in provider account where supported. Examples include
ChatGPT, Claude, and similar subscription/login surfaces.

The model path is:

```text
User -> local Jarvis app/browser session -> provider subscription/login
```

Why:

- keeps primary model cost with the user
- avoids raw API-key setup for normal users
- reduces backend cost exposure
- matches the "runs on your Mac" product story

### 5.2 Backend-managed utilities and fallback

For managed utilities, onboarding fallback, controlled beta support, and
non-model tool surfaces, Jarvis can use service-level provider keys on the
backend, for example:

- `BRAVE_API_KEY`
- `FIRECRAWL_API_KEY`
- `GOOGLE_MAPS_API_KEY`
- `OPENAI_API_KEY`
- `GEMINI_API_KEY`

The app should not receive these raw keys. The backend-held keys are not the
primary model path. The call path is:

```text
User -> Jarvis app -> Jarvis backend -> Brave/Firecrawl/Google/OpenAI/Gemini/etc.
```

The backend creates internal virtual usage meters per user:

```text
jarvis_user_id
plan
brave_searches_used
firecrawl_pages_used
google_maps_requests_used
stt_minutes_used
tts_chars_used
high_quality_tts_messages_used
image_generations_used
video_generations_used
monthly_spend_estimate
```

This gives per-user control without exposing founder/provider keys in the app.

For backend-managed utility/fallback usage, Jarvis must control:

- requests per user
- spend per user
- abusive behavior
- rate limits
- feature access by plan
- monthly fair-use thresholds
- upgrade prompts

### 5.3 BYOK raw API-key users

For BYOK raw API-key users, Jarvis should not proxy or manage their provider
usage by default. The whole point of raw BYOK is that the user owns the keys
and calls.

Power users can enter their own provider keys locally:

- Brave
- Firecrawl
- Google Maps/Places
- OpenAI
- Gemini
- Anthropic
- any other provider they want

The call path is:

```text
User -> local Jarvis app -> provider APIs directly
```

Jarvis may still offer optional diagnostics or config validation, but cost control is the user's responsibility.

### 5.4 Rate-limit philosophy for v1

Do **not** over-engineer a perfect billing/rate-limit system before distribution. That is premature.

80/20 v1 rule:

- prevent catastrophic loss
- track enough usage to see patterns
- make plan limits configurable from the backend
- avoid complex credits/add-ons until real usage data exists

The v1 backend should implement simple hard caps and monthly counters, not a beautiful metering cathedral.

## 6. Pricing decision

Initial public pricing is now decided for launch copy. Lead with the
subscription-login consumer path plus capped managed utilities. Raw BYOK API
keys are secondary for advanced users.

### Jarvis Personal — $99/mo

For normal consumers who want Jarvis to just work.

Includes:

- local app
- signed, verified updates
- Telegram/local assistant runtime
- preferred model access through user subscription/login where supported
- speech-to-text
- basic TTS
- limited high-quality TTS, then fallback to cheaper/free Edge TTS
- basic search/scraping/maps quota
- limited image generation allowance, if economics work
- priority onboarding support for early customers
- video generation later, heavily limited or higher-tier only

This is the main consumer promise. Backend-held founder/provider keys are for
capped utilities, onboarding fallback, controlled beta support, and non-model
tool surfaces. They must live server-side, never bundled in the app or sent to
the app.

Suggested phrasing: "Use your provider subscriptions where supported, with managed voice, search, and tools for normal personal use."

High-cost features should be plan-gated with simple allowances instead of complex credits at launch:

- high-quality TTS messages/chars per month
- image generations per month
- video generations per month later

If users need more, push them to a higher plan. Do not start with a complicated credits store unless usage data proves it is necessary.

### Jarvis Core — $19/mo

For advanced users who prefer raw BYOK API keys.

Includes:

- local app
- signed, verified updates
- Telegram/local assistant runtime
- BYO raw model API keys
- BYO tool keys where needed
- community/self-serve support

### Jarvis Founder / Concierge — $149-$299+/mo later

Includes:

- white-glove onboarding
- workflow setup
- priority support
- custom automations

## 7. Trial and license model

Recommended trial:

- 14 days, not 30
- requires account login
- no credit card for GitHub/Reddit early beta, but require account activation
- later: credit-card trial if paid ads begin

Why 14 days:

- enough time to try real tasks
- creates urgency
- less “I’ll try later” drift

License enforcement model:

- app requires login to activate after install
- backend returns signed license token
- token cached locally for offline grace period
- app periodically checks subscription status
- if trial/subscription expires:
  - still allow local config export and maybe read-only mode
  - block updates and managed services
  - optionally block agent runtime after grace period, depending on open-source strategy

Important nuance for open source:

- If the code is open source, hard DRM is fake. Motivated users can patch it.
- That is fine. The business should monetize convenience, updates, managed services, onboarding, and trust — not pretend open-source code cannot be modified.

## 8. Updates outside the App Store

This was missing from the old plan and remains P0, but the first
signing/notarization/update proof is no longer blank.

Jarvis needs an updater because App Store approval is too slow and the first launch should be direct download/GitHub.

Recommended update architecture:

```text
App checks Jarvis backend -> sees latest version -> downloads signed/notarized update -> installs/restarts
```

P0 requirements:

- [x] signed + notarized macOS builds for public `v2026.3.15`
- [x] update manifest hosted through GitHub Releases/appcast for `v2026.3.15`
- app checks latest version on launch and periodically
- user can click “Update”
- update gated by subscription/trial status
- updater shows changelog
- update process backs up config first

Implementation choice for developer docs:

- Sparkle is the current macOS update path. Do not reopen Electron/custom updater
  unless Sparkle blocks a hard requirement.

Subscription enforcement through updates:

- expired users can keep old open-source build if they have it
- paid users receive automatic updates, managed services, and support
- managed API access can be revoked server-side regardless of local app version

Hard truth: for open source, preventing unpaid users from running old code is not worth the war. Control the hosted services and updates. That is the sane leverage point.

Consumer update copy should stay Apple-style:

> Jarvis keeps itself up to date with signed, verified updates. Your setup,
> preferences, and local data stay in place. Jarvis tells you what is changing
> before updates.

## 9. Distribution strategy

### 9.1 Phase 1 — Reddit + GitHub

Use GitHub as the early landing page/distribution surface.

Why:

- Reddit is less likely to ban a useful repo than a salesy landing page link
- open source increases trust
- early users are more technical anyway
- reduces need to build a polished website immediately

GitHub README must include:

- what Jarvis does
- demo video/GIF
- install button/release link
- pricing/trial explanation
- open-source license clarity
- “local-first” privacy story
- roadmap
- limitations honestly stated

Reddit launch angle:

- not “buy my AI assistant”
- “I built a local-first Jarvis for Mac that can actually operate your computer — open source, looking for early users/feedback”

### 9.2 Phase 2 — Website

Website becomes necessary for non-technical users and paid ads.

P0 website sections:

- headline
- 60-second demo video
- use cases
- pricing
- download
- FAQ
- trust/privacy
- changelog

Do not build a giant marketing site now. One strong landing page is enough.

## 10. Branding/repo consolidation

Decision:

- [x] Public product brand is Jarvis from the start.
- [x] OpenClaw can appear as technical/developer/powered-by language only.
- [x] Public-facing app/docs should move toward Jarvis now.
- [x] App visible name/artifact should become Jarvis soon.
- [ ] Bundle ID/runtime/update identity/internal renames are a separate migration task.

Open question:

- [ ] Preserve OpenClaw as engine/internal name, expose Jarvis as product name?

Implementation boundary:

- Product name: Jarvis.
- Engine/framework/repo language: OpenClaw.
- Do not imply bundle ID, runtime identity, update feed identity, or internal
  package names have already been renamed.

### 10.1 User-facing capability names

Problem: many current tool/skill names are developer-facing and confusing for normal users. Users should not need to know names like Peekaboo, Himalaya, GOG, goplaces, wacli, etc.

Decision direction:

- [ ] Rename/relabel developer skill names into plain user-facing names in app/docs/onboarding.
- [ ] Keep internal package/skill IDs if needed, but hide them from normal UX.
- [ ] Make natural language routing work from user intent, not skill names.

Examples:

- `gog` -> Google Workspace / Gmail / Google Calendar / Google Drive skill
- `himalaya` -> Email skill / non-Google email skill
- `wacli` -> WhatsApp skill
- `goplaces` -> Places / maps / nearby search skill
- `peekaboo` -> Mac screen/app control skill

Investigation task:

- [ ] Audit all bundled/default skills and tools for developer-facing names.
- [ ] Mark deprecated/confusing names.
- [ ] Propose user-facing labels, descriptions, and trigger phrases.
- [ ] Ensure users can say things like “check my email”, “open WhatsApp”, “use my Google Calendar”, “find places nearby” and Jarvis routes correctly.

## 11. Onboarding roadmap

P0 blockers before public strangers:

- [x] Apple signing/notarization and public DMG install smoke for `v2026.3.15`.
- [x] Remove bundled founder keys from public builds or route them through managed backend.
- [x] Beta account activation and 14-day trial contract.
- [x] Baseline Sparkle update mechanism proof.
- [x] Production Render service/env configuration.
- [ ] Subscription/trial-gated update entitlement UX.
- [ ] Cleaner settings/onboarding flow after the first-pass PR #628 settings
      cleanup.
- [ ] Better copywriting for every step.
- [ ] Telegram setup simplification.

Telegram/BotFather:

- Manual BotFather setup is too much friction for mainstream users.
- If Telegram supports managed/programmatic bot provisioning through some official/allowed path, investigate and implement.
- If not, use shared bot by default and BYO bot token as advanced option.

### 11.1 First beta goal

The first meaningful beta should test whether users can get through setup and onboarding **on their own**.

Core beta question:

- [ ] Can most target users install Jarvis and get to first value without Artem hand-holding them?

Success criterion:

- [ ] Most users can install, connect, and complete at least one useful task without live intervention.

If they cannot, the product is not ready for broad public distribution, no matter how cool the demo is.

### 11.2 Beta focus for v1

Do not over-instrument before there is signal.

First measure manually:

- [ ] where users get stuck in install
- [ ] where users get stuck in onboarding
- [ ] whether Telegram setup causes drop-off
- [ ] whether permission/full-access prompts scare users away
- [ ] whether value is obvious quickly enough after setup

Later, after the first real onboarding rounds, add funnel tracking if needed.

### 11.3 Product-level onboarding question

The practical product test is not “is the architecture elegant?”

It is:

> If Artem ships this app to normal early users, can they install it easily enough that they do not lose interest before first value?

### 11.4 Bootstrap initial setup redesign

Bootstrap/setup needs to be redesigned around fastest path to first value.

P0 bootstrap goals:

- [ ] fewer steps
- [ ] plain-English copy
- [ ] no developer jargon
- [ ] obvious progress/checklist
- [ ] explain why each permission/account connection is needed
- [ ] recover gracefully if a step fails
- [ ] let users continue with reduced capability where possible
- [ ] end with a concrete first task/demo, not an empty dashboard

Bootstrap should answer:

- [ ] Is Jarvis installed correctly?
- [ ] Is the local runtime healthy?
- [ ] Is Telegram connected?
- [ ] Are required permissions granted?
- [ ] Is browser control connected or clearly optional?
- [ ] Is account/trial/subscription active?
- [ ] What can the user ask Jarvis to do right now?

## 12. Competitive context

### OpenCode

OpenCode is open source and supports BYO providers/subscriptions, including ChatGPT Plus/Pro login and GitHub Copilot login. It also has OpenCode Zen: an optional paid AI gateway where users sign in, add billing, get an API key, and are charged per request/credits. This is a strong reference model for Jarvis: open-source core + optional managed gateway.

### Cursor

Cursor uses subscription tiers with included model usage pools and optional overage/on-demand usage. This is the closest mainstream reference for “subscription with limits, not pure BYOK.” Good model, but credit language can feel annoying to normal users. Jarvis should hide complexity behind fair-use limits where possible.

### Claude Code

Claude Code supports subscription users and API usage. The docs emphasize cost tracking, token usage, workspace limits, and per-user rate recommendations. This validates that serious agent products need usage controls once provider costs are involved.

### FL Studio

FL Studio is a useful reference for downloadable software with trial + paid editions + account/update entitlement. However, FL Studio is one-time purchase with lifetime updates, which is not the best fit for Jarvis because AI products have recurring provider/support/update costs.

## 13. Strategic recommendation

Do not overbuild the website first.

Build the commercial spine first:

1. signed/notarized downloadable app — done for public `v2026.3.15`
2. no leaked founder keys — package guard done in PR #565
3. account login and 14-day trial activation — beta contract done in PR #647
4. pricing/plan names, launch README outline, and 60-second demo — drafted in PR #646
5. production Render service configuration with durable account/license state
6. usage counters for backend-managed utilities/fallback
7. subscription/trial-gated update entitlement UX
8. GitHub README as landing page
9. Reddit launch
10. website after signal

## 14. Immediate execution roadmap

### P0 implementation tracker

Current implementation order:

1. Backend contract + OpenClaw client config. Done in PR #560.
2. Private Render deploy path for the backend. Done in PR #561.
3. Secrets/public-package audit guard. Done in PR #565.
4. Account/license persistence. Done in PR #569.
5. Signing/notarization + updater proof. Public `v2026.3.15` shipped signed/notarized; Sparkle non-UI update completion passed.
6. Beta account activation + 14-day trial. Done in PR #647.
7. Pricing/plan names, launch README outline, and 60-second demo. Drafted in PR #646.
8. Production Render service creation + partial env configuration. Done on 2026-05-11; Neon persistence remains the blocker.

Progress:

- [x] Backend contract + OpenClaw client config landed in PR #560.
- [x] Minimal Jarvis backend MVP landed in PR #560.
- [x] Render deploy guardrails / backend Render service path landed in PR #561.
- [x] Secrets/public-package audit guard prevents public builds from shipping founder/provider keys; landed in PR #565.
- [x] Account/license persistence replaces stateless trial responses; Neon-backed persistence landed in PR #569.
- [x] Signing/notarization completed for public `v2026.3.15`.
- [x] Sparkle non-UI update completion passed from public `v2026.3.14` to `v2026.3.15`.
- [x] Beta email activation + 14-day trial landed in PR #647.
- [x] Launch package/pricing/README/demo draft landed in PR #646.
- [x] First-pass macOS Settings cleanup landed in PR #628. Settings now uses a
      cleaner left-sidebar layout, Browser and AI access are top-level settings
      sections, General is less cluttered, and the consumer Telegram Channels setup
      no longer renders the cramped nested sidebar.
- [ ] Recut/upload public artifacts from current `main` before claiming post-#634/#638 fixes ship broadly.
- [ ] Subscription/trial-gated update entitlement UX is production-ready.
- [x] Render service has durable production account/license persistence.

Remaining Settings/UI polish after PR #628:

- Reduce copy density and card heaviness inside Channels, AI access, and
  Permissions.
- Keep the next pass focused on beta onboarding clarity rather than a full
  Liquid Glass redesign.

Verified Render truth as of 2026-05-11 before backend creation:

- Render workspace `My Workspace` has no service pointing at
  `https://github.com/artemgetmann/openclaw` or `services/jarvis-backend`.
- Existing `jarvis-api` and `jarvis-frontend` services point at
  `https://github.com/artemgetmann/jarvis-voice-ai`, not this repo.
- `https://jarvis-api-n70e.onrender.com/health` returns healthy for the legacy
  voice API, but this is not the Jarvis macOS backend contract.
- The macOS backend service still needs to be created from this repo's root
  `render.yaml` `jarvis-backend` service and configured with production env
  values before a notarized Jarvis package can point at it.

Verified Render backend state as of 2026-05-12 after Neon configuration:

- Created Render web service `jarvis-backend` in workspace `My Workspace`.
- Service ID: `srv-d80sqc8g4nts738v1j80`.
- URL: `https://jarvis-backend-klvq.onrender.com`.
- Region: `virginia`.
- Plan: `starter`.
- Repo/branch: `https://github.com/artemgetmann/openclaw` `main`.
- Build command: `cd services/jarvis-backend && pip install -r requirements.txt`.
- Start command: `cd services/jarvis-backend && uvicorn app.main:app --host 0.0.0.0 --port $PORT`.
- Neon project `jarvis-backend` was created on the Neon Free plan in
  `AWS US East 1 (N. Virginia)`.
- Render env `NEON_DATABASE_URL` is configured from the pooled Neon connection
  string. The value is stored outside Git in local macOS Keychain under service
  `Jarvis Neon Database`, account `NEON_DATABASE_URL`.
- Deploy `dep-d81agunlk1mc73a8m020` is live from commit
  `1ab30c2cca15b54e8b86fba7c8b1c3a31f6e6fe6`.
- `GET /healthz` returns 200 with `service=jarvis-backend`,
  `environment=production`, `providers.openai=true`, and
  `providers.anthropic=false`.
- `POST /v1/account/login` returns 200 and creates a persisted 14-day trial.
- `POST /v1/license/status` returns 200 for a valid account access token and
  preserves the account/device trial link.
- Repeating activation for the same email returns 409 and does not leak a new
  account token.
- License lookup with an invalid account access token returns 401.
- `POST /v1/managed/utilities/smoke` returns 200 with the backend token,
  proving the managed utility contract is live and provider keys are
  server-held.
- `JARVIS_BACKEND_API_TOKEN` was generated and stored outside Git in local
  macOS Keychain under service `Jarvis Render Backend`, account
  `JARVIS_BACKEND_API_TOKEN`.

Remaining backend follow-up:

- Anthropic is not configured yet. This is not a blocker for the current
  OpenAI-backed backend smoke, but should be configured before claiming
  Anthropic-managed utility coverage.

### Imported from retired consolidation trackers

The active owner for these items is this launch plan. The retired consolidation
docs remain historical proof only:

- `docs/consumer/archive/openclaw-main-consumer-consolidation-plan.md`
- `docs/consumer/archive/openclaw-main-consumer-divergence-tracker.md`

| Item                                             | Owner                                     | Status                            | Launch-plan handling                                                                                                                                                                                                                                    |
| ------------------------------------------------ | ----------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Final package through deterministic release lane | Release lane from current `main`          | Open, only when app work is ready | Use PR #658 release automation. Release env path is `~/Library/Application Support/OpenClaw/release.env`. Keep secrets in Keychain or outside repo. Use async notarization submit/poll/staple flow; do not block blindly on Apple's queue.              |
| Public `v2026.3.15` asset replacement            | Release lane with explicit Artem approval | Open, approval-gated              | Current public assets still point at old provenance `205d5f596602ff82270b1af5a3de24c33c32b532`. Prior local recut proof existed from `1ec69a58fd441e1c63a91e5af4468fd6fe53f272`; if app work continues, recut again from final `main` before uploading. |
| Release assets involved                          | Release lane                              | Open, approval-gated              | Replace/upload only after explicit approval: `Jarvis.dmg`, `Jarvis.zip`, the dSYM zip, and the Jarvis appcast generated for the consumer feed.                                                                                                          |
| Optional Sparkle dialog smoke                    | Release/GUI smoke lane                    | Optional                          | Deterministic non-UI Sparkle update already passed. Run visual interactive Sparkle dialog smoke only if the product claim needs exact popup/user-click proof. Not a blocker by default.                                                                 |
| Launch audit                                     | Launch/commercial readiness lane          | Open                              | Track account state, trial/license state, backend-managed surfaces, bundled config/secrets, and public package audit here. This is launch/commercial readiness, not consolidation work.                                                                 |
| Overlay/defaults hygiene                         | Future product/platform lane              | Deferred, non-blocking            | Keep onboarding/model/default behavior explicit in policy/config layers. Avoid scattered product conditionals. Not a release blocker.                                                                                                                   |
| Bundle ID migration                              | Separate migration lane only              | Deferred                          | Visible product naming can move to `Jarvis.app`, but internal bundle id/runtime/update identity stay preserved until there is a deliberate migration plan. Changing bundle id can reset macOS permissions/state and create support churn.               |

Deployment/security boundary:

- Backend source may stay open source.
- Production provider keys, backend tokens, customer license/account state, billing credentials, signing identities, and database URLs must stay outside Git.
- Subscription-login and local raw BYOK model users do not need the backend for
  primary model usage; backend-managed utilities/fallback opt into
  Jarvis-hosted usage.
- Self-hosters can run the same backend with their own env vars.

### P0 — Before wider strangers

- [x] Finalize plan decisions in this document.
- [x] Audit all bundled/secrets/config surfaces enough to block public packages from shipping founder/provider keys; landed in PR #565.
- [x] Implement beta email activation + 14-day trial. Minimal email activation is implemented in the Jarvis backend/client contract for controlled beta account/device/trial tracking. This is not production auth: first activation returns an account token, repeated activation for the same email fails closed, and reinstall/account recovery waits for OTP/magic-code verification. Do not add passwords; Google Auth remains a later optional hardening slice.
- [x] Decide exact plan names and prices. See `docs/consumer/jarvis-launch-package.md`.
- [x] Implement license check + offline grace. Contract MVP exists in PR #560; Neon persistence landed in PR #569.
- [x] Implement and prove baseline update check/install path through Sparkle non-UI update completion.
- [x] Sign/notarize macOS app for public `v2026.3.15`.
- [ ] Recut/upload public artifacts from current `main` before claiming post-#634/#638 fixes ship broadly.
- [ ] Implement subscription/trial-gated update entitlement UX.
- [x] Remove or proxy all founder keys from public builds. Backend/proxy contract exists in PR #560; public-package audit guard landed in PR #565.
- [ ] Define self-modification boundaries: normal mode, guarded mode, developer mode, fork mode.
- [ ] Define config/defaults update policy: migrate/merge without clobbering user config.
- [ ] Define bundled skill vs workspace skill update policy.
- [ ] Audit and simplify user-facing skill/tool names.
- [x] Create GitHub README launch page outline. See `docs/consumer/jarvis-launch-package.md`.
- [x] Draft 60-second demo script. See `docs/consumer/jarvis-launch-package.md`.

### P1 — First public launch

- [ ] Launch on Reddit with GitHub repo link.
- [ ] Collect early users manually.
- [ ] Fix onboarding bugs aggressively.
- [ ] Add managed utilities tier if key setup kills activation.
- [ ] Add website only after the message is proven.

### P2 — Scale

- [ ] Website + Stripe checkout.
- [ ] Paid ads only after activation is good.
- [ ] Managed utility/fallback scale-up from the initial consumer plan.
- [ ] Concierge/pro tier.
- [ ] Business/team features.

## 15. Open decisions

- [ ] Exact license: open source but what license?
- [x] Is Jarvis Core $19 or $29? Decision: $19/mo as the advanced BYOK plan.
- [x] Is there a $29/$39 managed utilities tier, or only Core + Personal? Decision: no Plus tier for launch; Jarvis Personal at $99/mo is the main consumer plan, with subscription-login model usage plus capped managed utilities/fallback.
- [x] What are exact managed fair-use limits? Initial v1 limits are defined in `docs/consumer/jarvis-launch-package.md`.
- [ ] What is the first official distribution surface: GitHub Releases only, or GitHub + minimal website?
- [ ] Use Sparkle/Electron updater/custom updater?
- [x] Keep OpenClaw name internally or fully rename everything? Decision: Jarvis public brand now; OpenClaw technical/developer language remains until a separate internals migration.

## Sources checked

- OpenCode homepage/docs/Zen: open-source agent, BYO providers/subscriptions, optional Zen managed gateway with billing/credits.
- Cursor pricing/docs: subscription plans include model usage pools and optional on-demand usage.
- Claude Code cost docs: token usage, cost tracking, spend/rate limits are expected for serious usage.
- FL Studio download/pricing pages: downloadable app with free trial and paid editions/lifetime updates.

## 16. Self-modification and extensibility model

Decision statement for product/docs/website draft:

> Jarvis is a proactive, self-improving AI assistant that can actually do things. It can learn your preferences, update its workflows, and create custom skills — while keeping the signed core runtime stable and updateable.

More technical version for GitHub/developer docs:

> Jarvis is open source and user-extensible. In normal mode, Jarvis can modify its own configuration, memory, workflows, and custom skills. Deep engine changes require Developer Mode or a fork. Official updates preserve user customizations but replace the managed runtime.

This statement should be refined later for GitHub/website copy.

### 16.1 Core principle

Jarvis can evolve itself through user-space extensions, but the signed app/runtime stays immutable unless updated by the official updater.

This preserves the magic without turning every install into a snowflake.

Consumer simplification: avoid presenting users with too many “modes.” Internally there are layers, but externally the product should feel like:

1. **Normal Jarvis** — safe self-improvement: memory, preferences, workflows, custom skills.
2. **Advanced customization** — explicit approval for more powerful changes.
3. **Developer/fork path** — for people changing the engine.

### 16.2 Normal mode: safe user-modifiable layer

Jarvis may modify:

- [ ] config/settings through validated config flows
- [ ] prompts/personality
- [ ] memory/rules
- [ ] workflows
- [ ] tool permissions, when approved
- [ ] integrations
- [ ] custom workspace skills
- [ ] small scripts/helpers inside a user-owned custom skill folder, when approved

This is the main “teach Jarvis new capabilities” layer.

### 16.3 Guarded mode

Guarded mode means Jarvis can propose certain changes, but the user must explicitly approve them before they are applied.

Requires explicit approval:

- [ ] enabling/installing skills
- [ ] changing config that restarts services
- [ ] adding executable helper scripts
- [ ] modifying permissions/tools
- [ ] anything that expands what Jarvis can access or do

Approval UX to investigate/define:

- [ ] show plain-English summary of the change
- [ ] show risk level
- [ ] show exact files/settings affected
- [ ] allow approve once / approve always for this skill/action class / deny
- [ ] create automatic backup before applying config/skill changes
- [ ] write action to audit log

### 16.4 Developer mode

Developer mode is for advanced users who intentionally want to modify behavior outside the stable product layer.

Possible allowed surfaces:

- [ ] local extension code
- [ ] custom skills
- [ ] local scripts
- [ ] dev-mode config

Developer mode should show a clear warning:

> You are modifying behavior outside the stable Jarvis product layer. Official updates preserve user-space customizations, but not arbitrary engine patches.

### 16.5 Fork mode

Deep architecture changes require a fork.

Fork/dev mode required for:

- [ ] core runtime code
- [ ] bundled skills
- [ ] updater
- [ ] package internals
- [ ] model router
- [ ] gateway/security internals
- [ ] app signing/bundle/launchd behavior

Fork users own merge/rebase/cherry-pick pain. Jarvis should document the trade-off, not try to solve it with impossible auto-merging.

### 16.6 Update policy questions

Must investigate before final implementation:

- [ ] If Jarvis ships new default config, how is it merged into existing user config?
- [ ] Which config fields are user-owned vs product-owned defaults?
- [ ] If Jarvis ships an updated bundled skill, what happens if user customized a workspace copy?
- [ ] Should bundled skills be read-only in normal mode?
- [ ] Should customization happen only by copying a bundled skill into `workspace/skills/`?
- [ ] How does the updater back up config/workspace/skills before updates?
- [ ] How does Jarvis report conflicts to the user?

### 16.7 Hermes comparison

Investigation task:

- [ ] Check how Hermes frames/implements self-improvement/self-modification.
- [ ] Decide whether Jarvis should copy, adapt, or explicitly differ from Hermes.
- [ ] Extract useful GitHub/website copy patterns without copying architecture blindly.

## 17. Config, skills, approvals, and updates — implementation decisions

Based on current OpenClaw Consumer architecture investigation.

### 17.1 Config update policy

Decision:

- [ ] Preserve user config.
- [ ] Apply new product defaults at runtime when fields are missing.
- [ ] Do not write new defaults back into user config automatically.
- [ ] If user explicitly set a value, user value wins.
- [ ] If schema migration is required, back up config first and migrate with visible notes.

Implementation notes:

- Current config behavior already mostly supports this: runtime defaults merge on load and are not written back as explicit config.
- Add consumer-level `productConfigVersion` / migration log before public launch.
- UI should distinguish inherited defaults vs explicit user settings.

### 17.2 Skill update policy

Decision:

- [ ] Bundled skills are official vendor assets and should be read-only in normal UX.
- [ ] User customization happens by copying/forking into user space (`workspace/skills` or managed user skill area).
- [ ] Official bundled skill updates never overwrite user workspace skills.
- [ ] If a user override shadows an updated bundled skill, Jarvis should surface it.

Consumer UX copy:

> WhatsApp skill has an official update. You are using a custom version, so I will not overwrite it. Want me to compare the changes and suggest a safe merge?

Buttons:

- [ ] Keep my version
- [ ] Use official update
- [ ] Compare changes
- [ ] Ask Jarvis to merge safely

Implementation notes:

- Current skill precedence already supports this direction: bundled skills are lower precedence than managed/personal/project/workspace skills.
- Add metadata to custom skill forks where possible:
  - `originSkillKey`
  - `originVersion`
  - `forkedFromBundledAt`
  - `lastComparedToVersion`

### 17.2.1 ClawHub / third-party skill policy for MVP

Do not treat ClawHub like a safe consumer app store. It is a powerful developer ecosystem, but from a consumer product perspective it is an untrusted third-party code marketplace.

V1 decision:

- [ ] ClawHub can be enabled for finding/installing skills.
- [ ] Do not make ClawHub a headline safe-consumer feature.
- [ ] Do not promise that Jarvis can reliably prove a third-party skill is safe.
- [ ] Allow advanced users to use ClawHub, but gate installs with strong warning + explicit confirmation.
- [ ] Bundle or recommend a **skill audit skill** so Jarvis can inspect suspicious/untrusted skills before install.
- [ ] Clearly label skill trust levels.

Recommended trust labels:

- [ ] Official — first-party Jarvis/OpenClaw maintained
- [ ] Trusted ecosystem — reputable source such as Anthropic/Vercel/Microsoft/etc.; still review before install
- [ ] Reviewed — manually reviewed by Jarvis/Artem team
- [ ] Unverified third-party — install at your own risk

Recommended MVP UX:

- Jarvis can discover skills from ClawHub, skills.sh/Vercel-style ecosystems, Anthropic-style stores/repos, GitHub, or the web.
- Before install, Jarvis gives a short plain-English review:
  - what the skill claims to do
  - where it comes from
  - what code/tools/permissions it appears to use
  - whether anything looks suspicious
  - a blunt disclaimer that review is not a guarantee
- User must explicitly confirm install.

Website/GitHub copy direction:

> Jarvis can be extended with third-party skills, including skills from ClawHub and other ecosystems. Third-party skills may run code on your machine, so they are risky by default. Ask Jarvis to review a skill for safety before installing it, and only install skills from sources you trust.

Strategic direction later:

- [ ] Build a Jarvis Store / Jarvis Hub with reviewed/verified skills.
- [ ] Consider paid skills/subscriptions later.
- [ ] Keep ClawHub-compatible discovery for advanced users, but do not make it the main trust story.

Find Skills / Vercel Labs note:

- The `find-skills` concept is useful as a discovery helper.
- The current Vercel Labs `find-skills` skill is focused on the open skills ecosystem / skills.sh / `npx skills`, not specifically ClawHub.
- Jarvis should adapt the concept into a broader **skill discovery** flow that can include ClawHub, skills.sh, Anthropic-style skills, GitHub, and the web.
- Discovery is not verification. Pair discovery with the skill-audit capability before install.

### 17.3 Consumer-facing modes simplification

Avoid exposing too many modes. Internally there are policy layers, but product UX should be simple:

1. **Normal Jarvis** — learns preferences, edits memory, workflows, custom skills.
2. **Advanced customization** — asks before enabling new powers, permissions, executable helpers, or persistent config changes.
3. **Developer/fork path** — for changing engine/core code.

Implementation note:

- Internally implement this as resolved policy, not just prompt text.
- Same policy must drive UI, gateway methods, skill enablement, config mutation, tool access, and update behavior.

### 17.4 Approval UX

Approval should be based on intent + scope + persistence + trust level.

Approval classes:

- [ ] Enable skill
- [ ] Change persistent config
- [ ] Add executable helper/local script
- [ ] Modify permissions/tools
- [ ] Install/update official runtime or managed skill package

Approval scopes:

- [ ] once
- [ ] this session
- [ ] always

For executable helpers:

- [ ] show path
- [ ] show content hash
- [ ] show owning skill
- [ ] require re-approval if file hash changes
- [ ] never trust by path alone

### 17.5 Update architecture

Preserve forever:

- [ ] user state dir/config
- [ ] secrets/tokens/session data
- [ ] workspace
- [ ] workspace skills
- [ ] managed/user-installed skills

Replace on official update:

- [ ] app bundle/runtime
- [ ] bundled skills
- [ ] built-in plugins/extensions
- [ ] bundled docs/templates/examples

First launch after update:

- [ ] run config migrations if needed
- [ ] rescan skills
- [ ] detect shadowed bundled skills
- [ ] show any relevant update notes/conflicts

### 17.5.1 Where update/conflict UX lives

Decision:

- [ ] Bot-first for communication and decisions.
- [ ] App-first for local execution of install/update/restart/backup steps.

Meaning:

- The macOS app handles download, install, restart, local state backup, and OS-native update flow.
- Jarvis in Telegram is the primary place where the user sees plain-English explanations, conflict questions, and optional advanced choices.
- The app may show a minimal native notice like "Update available" or "Jarvis needs your decision," but it should not become a giant desktop settings/control panel.

Consumer principle:

- conversational decisions in the bot
- local runtime/updater mechanics in the app
- only advanced users see compare/merge/diff detail

Future direction:

- [ ] Jarvis should proactively notify the user in Telegram when an update is available: "A new Jarvis update is available. Want me to update this Mac?"
- [ ] Useful for Mac Mini / tucked-away machines where users do not regularly open the app UI.
- [ ] Not P0 if it complicates updater implementation; app-driven manual update is acceptable first.

## 18. Permission UX simplification — v1 decision

Decision direction from Artem: do not overbuild approval UX before distribution.

### 18.1 V1 modes

Use two simple permission modes, not many modes:

1. **Autopilot / Full Access**
   - Default for early users/beta unless changed later.
   - Jarvis can read/write files and run tools without repeated approvals.
   - User relies on instructions, visibility, logs, and rollback/backups rather than approve-every-command friction.
   - This mirrors how many developers already run Claude/Codex/OpenCode in bypass/full-permission modes because approval-heavy flows slow real work down.

2. **Protected / Approval Mode**
   - For paranoid users, sensitive environments, businesses, enterprise later.
   - Runs in sandbox by default.
   - Requires explicit approval for actions outside sandbox or persistent/high-risk changes.
   - Not P0 unless required by public launch risk.

### 18.2 Visibility instead of approval spam

Rename developer-facing verbose behavior into consumer-friendly visibility controls.

Possible command/copy:

- `/visibility off` — keep output clean; only show final results and important decisions.
- `/visibility on` — show important actions, files changed, commands run.
- `/visibility full` — show detailed under-the-hood activity.

Goal:

- make Jarvis feel transparent without forcing approvals every 30 seconds.
- user can inspect what happened after the fact.
- pair with backups/action logs for recovery.

### 18.3 Later approval system

Do not delete the approval architecture idea; defer it.

Later, for Protected/Enterprise mode, implement scoped approvals for:

- permissions/tool widening
- executable helper trust
- persistent config changes
- external sends/payments/destructive actions
- sandbox escapes

But this is not the main v1 distribution blocker.
