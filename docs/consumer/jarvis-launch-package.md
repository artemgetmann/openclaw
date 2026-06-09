# Jarvis Launch Package

Status: Jarvis Consumer RC launch package tracker
Owner: Artem
Last updated: 2026-06-09

Purpose: launch-facing package, pricing, copy, and artifact truth.

Use this document for what Jarvis says, sells, packages, and ships once the
launch plan is ready. Do not duplicate detailed implementation tracker state
here; link to `docs/research/jarvis-consumer-launch-plan.md` for current task
status, owners, and proof.

This document turns the launch plan into decisions that can be shipped into the
GitHub README, release notes, pricing copy, and the first 60-second demo.

## Brand and rename boundary

Jarvis is the public consumer brand from the start. OpenClaw can appear as
technical, developer, repo, or "powered by OpenClaw" language only.

Public-facing app/docs, visible app name, release artifacts, and app icon are
Jarvis now.

For the small trusted tester ring only, bundle ID, runtime identity, update
feed identity, and deeper internal renames intentionally stay on
`ai.openclaw.consumer.mac` and OpenClaw paths so the next package can ship
fastest. That trusted ring includes the already-prepared tester package and the
next 4-5 waiting testers after the P0 onboarding fixes. Before Reddit/GitHub,
public-ish beta, or any broader beta, `ai.jarvis.mac` bundle
ID/runtime/update identity migration is a required launch gate. Do not treat
that migration as a quick rename; it needs a deliberate lane because it can
affect permissions, state, LaunchAgents, and update continuity.

## Backend deployment status

Current beta backend:

- Render service: `jarvis-backend`
- Service ID: `srv-d80sqc8g4nts738v1j80`
- URL: `https://jarvis-backend-klvq.onrender.com`
- Region/plan: `virginia` / `starter`
- Source: `https://github.com/artemgetmann/openclaw` on `main`

Verified on 2026-05-12 and refreshed on 2026-05-18:

- `/healthz` is live and reports production mode.
- OpenAI is configured server-side.
- Anthropic is not configured yet.
- Firecrawl, Google Places, Gemini, and Brave provider env are configured
  server-side.
- The managed utility smoke endpoint works with the backend token.
- Real managed utility endpoints for `firecrawl.search`, `firecrawl.scrape`,
  `google_places.search`, `brave.search`, and `gemini.image.generate` are
  deployed on Render and returned HTTP 200 in live redacted smokes.
- Neon persistence is configured server-side in Render.
- Render now has the Managed Bots env enabled and redeployed; the redacted
  health smoke returned `providers.telegram_managed_bots=true`.
- Live Managed Bots start/status proof passed on 2026-05-18: setup
  `tgms_3LBqIilzthPPfPZZ-aIaTw` connected as
  `@JarvisManagedSmoke184350Bot` with bot id `8882555895`; the managed child
  token was redacted in proof output.
- Account activation creates a persisted 14-day trial.
- License status succeeds for a valid account token.
- Repeated activation for the same email fails closed with 409.
- Invalid account access tokens reject with 401.

Backend/account persistence and the first managed utility endpoints are ready
for the next beta package smoke. Anthropic remains unset. Firecrawl
app/runtime calls, Google Places/goplaces ordinary search, Brave `web_search`,
and the Nano Banana text-to-image wrapper use Render in managed mode when
configured.
Google Places details/resolve/reviews and Nano Banana input-image editing still
require direct BYOK until the backend exposes managed utilities for those shapes.

## Release package status

Current release truth as of 2026-06-09:

- Same-user RC onboarding is accepted. The normal-user run on 2026-06-09
  proved the restored `Wake up, my friend` copy, bot-side
  `Return to the Jarvis app.` copy, first-message replay, and `Verify Telegram`
  recovery path are good enough for this release lane.
- Telegram UX issues from the same-user run are no longer release blockers.
  Do not reopen them unless the clean-user Gate2 run exposes a real regression.
- Jarvis visible branding is in place for the app name, release artifacts, and
  app icon.
- Bundle ID/runtime/update identity remain `ai.openclaw.consumer.mac` and
  OpenClaw paths only for the small trusted tester ring by deliberate 80/20
  decision.
- Non-secret Sparkle release config lives at
  `~/Library/Application Support/OpenClaw/release.env` and should be inherited
  by all worktrees/chats. API token and Neon URL stay outside Git in macOS
  Keychain.
- Sparkle implementation and release assets are already on `main`: commit
  `6a90c8370f` added the Jarvis Sparkle release assets, and tag `v2026.3.16`
  (`00391e8b76`) is the current mainline release bump. That is implementation
  truth, not end-to-end update proof.
- The fast RC package path still produces a Developer ID signed but
  unnotarized app. Gatekeeper rejection is expected for `--fast` local smoke
  artifacts and must not be presented as a final release regression.
- The next real release blocker is clean-user Gate2 proof with the distinct
  `Jarvis Consumer Gate2` identity on port `25229`.
- Final release proof still requires a notarized DMG and ZIP built from the
  synced final head, stapled successfully, and accepted by Gatekeeper.
- Sparkle still requires a real N-to-N+1 proof on the release candidate path:
  download, signature verification, install, relaunch, and state preservation.
- Older trusted-tester/public artifacts remain useful historical evidence, but
  they are not the current release truth for this final RC lane.
- Recommended release path remains App Store Connect API key auth plus async
  notarization submit/poll/staple receipts. Set `NOTARYTOOL_KEY`,
  `NOTARYTOOL_KEY_ID`, and `NOTARYTOOL_ISSUER` through the machine release env;
  leave `NOTARYTOOL_PROFILE` unset unless deliberately using the fallback path.
- Read-only preflight previously proved credential readiness only; it did not
  submit notarization, staple, package, upload, or mutate release assets.
- `ai.jarvis.mac` bundle ID/runtime/update identity migration is a required
  launch gate before Reddit/GitHub, public-ish beta, or a wider beta.
- Do not send to Reddit/GitHub/public-ish beta until the `ai.jarvis.mac`
  bundle/runtime/update migration is complete.
- Packaging-smoke iteration can use
  `bash scripts/package-consumer-mac-app-fast.sh --instance <id> --reuse-runtime`
  after one normal fast package when only the app shell changed. Do not use
  `--reuse-runtime` after runtime JS, extension, skill, template, package, Node,
  uv, or bundled dependency changes.

## v1 commercial decision

Launch with Jarvis Personal as the main consumer path. Model usage should use
the user's provider subscription/login where supported. Backend-held
founder/provider keys are limited to managed utilities, onboarding fallback,
controlled beta support, and non-model tool surfaces.

| Plan                     | Price    | Buyer                      | Public at launch | Main boundary                                   |
| ------------------------ | -------- | -------------------------- | ---------------- | ----------------------------------------------- |
| Jarvis Personal          | $99/mo   | normal consumers           | yes              | subscription-login models plus capped utilities |
| Jarvis Core              | $19/mo   | technical and power users  | yes              | BYOK raw API keys and advanced provider setup   |
| Jarvis Founder Concierge | $299/mo+ | high-touch pilot customers | no               | onboarding, workflow setup, priority support    |

The public launch page should lead with Jarvis Personal because the consumer
promise is "it just works." Jarvis Core exists for advanced users who want to
bring raw API keys or own more of the provider setup.
Founder Concierge is sales-led and should not clutter the README.

## Trial and account rules

- Trial: 14 days.
- Trial entry: account login required.
- Credit card: not required for the first GitHub/Reddit beta.
- Later paid ads: require credit card before trial.
- Offline grace: 7 days after the last successful license check.
- Expired account keeps local export access.
- Expired account loses automatic updates, managed services, and support.
- Open-source users may still run code they build themselves; the paid product
  sells convenience, updates, managed services, onboarding, and trust.

## Entitlement boundaries

### Jarvis Personal

Personal is the main consumer plan.

Personal includes:

- signed/notarized Jarvis app downloads while subscription is active
- automatic signed, verified updates while subscription is active
- local-first Jarvis runtime on the user's Mac
- Telegram assistant setup
- connected apps, local tools, and allowed external tools where installed
- preferred model access through the user's local provider subscription/login
  where supported
- capped managed utilities for voice/search/scraping/maps/image generation
- bundled official skills and workflows
- visibility/logging controls
- priority onboarding support for early customers

Initial monthly fair-use allowance:

- backend-managed utility/service-cost cap: $45/user/month
- speech-to-text: 1,000 minutes
- standard text-to-speech: 1,000,000 characters
- high-quality TTS: 500 messages or equivalent cap
- search and maps: 5,000 combined requests
- scraping: 2,000 pages
- image generation: 100 images

Backend-managed utility guardrails:

- managed utilities and fallback support must go through the Jarvis backend
- raw founder/provider keys must never be packaged inside the app
- raw founder/provider keys must never be sent to the app
- backend limits must be configurable without an app update
- Jarvis must stop, degrade, or request approval before backend-managed usage
  burns past the cap
- no video generation in v1

Unlimited backend-paid model usage at consumer pricing is a margin trap. Do
not ship it.

### Jarvis Core

Core is the advanced BYOK plan.

Core includes:

- signed/notarized macOS app downloads while subscription is active
- automatic signed, verified updates while subscription is active
- local-first Jarvis runtime on the user's Mac
- Telegram assistant setup
- connected apps, local tools, and allowed external tools where installed
- bundled official skills and workflows
- visibility/logging controls
- community or self-serve support
- BYO raw model API keys when subscription/login is unavailable or unwanted
- BYO utility keys for search, scraping, maps, speech, image, and other costly
  provider surfaces

Core does not include:

- backend-paid model usage
- managed Brave/Search, Firecrawl, Google Maps, OpenAI, Gemini, or other shared
  provider usage
- priority support
- done-for-you workflow setup

## Provider access boundary

Plain English:

- User-owned subscription login means Jarvis uses a user's existing provider
  subscription or logged-in provider account where supported. This is the
  preferred model path because it keeps model costs with the user while avoiding
  raw API-key setup.
- Backend-managed utilities mean Jarvis uses server-side provider access for
  capped non-model surfaces, onboarding fallback, controlled beta support, and
  utility workflows.
- BYOK raw API keys mean the user manually enters provider API keys. This is an
  advanced escape hatch, not the default consumer path.

User subscription/login model path:

```text
User -> local Jarvis app/browser session -> provider subscription/login
```

Backend-managed utility/fallback path:

```text
User -> Jarvis app -> Jarvis backend -> provider API
```

Rules:

- Primary model usage should use user subscription/login where supported.
- Backend-held founder/provider keys are for limited utilities, onboarding
  fallback, controlled beta support, and non-model tool surfaces.
- Jarvis Core users can use raw BYOK API keys for models/tools when they prefer
  that path or when subscription login is not supported.
- Raw managed provider keys must never be packaged inside the app.
- Raw managed provider keys must never be sent to the app.
- Founder/provider keys live server-side only.
- BYOK provider keys stay local unless the user explicitly opts into a future
  sync/diagnostic flow.
- The backend tracks monthly counters and spend estimates for backend-managed
  utilities/fallback.
- The backend can pause managed utilities independently of local runtime access.

## GitHub README launch outline

The launch README should be a practical landing page, not a marketing site.

### Above the fold

Headline:

> Jarvis is a local-first AI assistant for Mac that actually does things.

Subhead:

> Talk to Jarvis in Telegram. It runs on your Mac, uses your apps and sessions,
> local tools, and allowed external tools, and can handle real workflows across
> browser, files, messages, code, and automations.

Primary buttons/links:

- Download for macOS
- Watch 60-second demo
- Start 14-day trial
- Read the local-first privacy story

### Demo block

Use one short video or GIF. Show one complete workflow, not a feature montage.

Recommended demo:

1. User sends Jarvis a Telegram task.
2. Jarvis checks the local Mac runtime.
3. Jarvis opens/uses browser or local files.
4. Jarvis reports progress in Telegram.
5. Jarvis returns a finished result with commands/files/actions summarized.

### What Jarvis does

- runs on your Mac
- answers in Telegram
- operates browser, files, apps, messages, code, and automations
- uses connected apps, local tools, and allowed external tools where installed
- remembers preferences and workflows
- can be extended with official and user skills
- keeps advanced customization available without forcing it into first setup

### Pricing block

Use only the public plans:

| Plan            | Price  | Best for         | Included provider usage                         |
| --------------- | ------ | ---------------- | ----------------------------------------------- |
| Jarvis Personal | $99/mo | normal consumers | subscription-login models plus capped utilities |
| Jarvis Core     | $19/mo | advanced users   | BYOK raw API keys and advanced provider setup   |

Copy:

> Start with a 14-day no-card trial during the early GitHub/Reddit beta.
> Personal is the main consumer plan: use your existing provider subscriptions
> where supported, while Jarvis covers capped utilities and setup fallback
> through the backend. Core is the advanced BYOK plan for people who want raw
> API-key control.

### Local-first trust block

Say this directly:

> Jarvis runs on your Mac because your real work lives there: browser sessions,
> files, apps, permissions, project tools, and local context. It can also use
> connected apps and external tools that you install and allow. Model usage
> should use your provider subscription/login where supported. Capped utilities
> and fallback support are metered through the Jarvis backend. Advanced BYOK
> users can keep raw API-key usage local.

### Honest limitations

- macOS first
- Telegram first
- setup is improving fast, but early users should expect sharp edges
- primary model subscription/login support depends on each provider surface
- Core/BYOK users must bring their own raw provider keys
- third-party skills can run code and should be treated as untrusted until
  reviewed
- external tools should be installed only from sources the user trusts
- visible app/artifact/icon branding is Jarvis, but internal bundle/runtime/
  update identities stay on `ai.openclaw.consumer.mac` only for the small
  trusted tester ring
- `ai.jarvis.mac` migration is required before Reddit/GitHub, public-ish beta,
  or a wider beta, and needs a deliberate migration lane because permissions,
  state, LaunchAgents, and update continuity can be affected
- post-launch app-bundle mutation is also a wider-beta blocker: Jarvis must not
  write extension `node_modules` or other runtime dependencies inside
  `/Applications/Jarvis.app` after signing
- same-user RC onboarding is accepted; the next proof gate is the clean-user
  Gate2 run, not more same-user Telegram polish
- `--fast` RC packages are Developer ID signed but unnotarized, so Gatekeeper
  rejection is expected. Do not present a fast RC artifact as the final release
- Sparkle assets and mainline release wiring are merged, but full N-to-N+1
  update proof is still pending

### Roadmap

Use `docs/research/jarvis-consumer-launch-plan.md` for the live task tracker,
owners, proof, and P0/P1/P2 status. This package doc keeps only launch-facing
truth:

- Completed for current RC proof: Jarvis visible branding, account/trial
  backend, managed utility backend, page-based onboarding shell, and accepted
  same-user onboarding proof for Telegram verification and first reply.
- Next release blockers: clean-user Gate2 proof, final notarized DMG/ZIP plus
  Gatekeeper/stapler verification, package secret audit, and proof that the
  shipped app matches the synced final RC head.
- Sparkle implementation is merged, but the launch package is not update-ready
  until a real N-to-N+1 update installs and relaunches successfully while
  preserving user state.
- Needed before Reddit / broad public beta: `ai.jarvis.mac` bundle/runtime/
  update identity migration, broader onboarding polish, Claude Code consumer
  exposure, Telegram model-picker cleanup, and copy pass.
- Deferred until evidence of friction: maintenance polish that does not block
  current testers.

### Telegram command/settings strategy

Normal users should see the same Telegram bot behavior Artem uses, but with
consumer-safe defaults. The default `/settings` surface should use plain names,
hide internal IDs, and keep advanced controls off by default.

Advanced/developer controls should be available intentionally, not scattered
through consumer setup. Candidate shape:

- `/settings` shows the normal settings menu and an "Advanced settings" toggle.
- `/help` stays consumer-simple: `/new`, `/status`, `/model`, `/think`, `/tts`,
  `/btw`, `/steer`, and `/advanced`.
- Telegram's normal slash menu should publish only `/help`, `/status`, `/new`,
  `/model`, `/think`, `/tts`, `/btw`, `/steer`, and `/advanced` when the compact
  Jarvis command surface is enabled.
- `/advanced` exposes the full generated command catalog for power users:
  founder/developer commands, plugins, skills, config/debug, approvals, export
  and session tools.
- `/commands` remains callable as a hidden compatibility alias for `/advanced`,
  but should not be promoted in `/help` or Telegram's normal slash menu.
- Managed Bots stays the consumer path; BYO BotFather token, custom commands,
  verbose developer detail, and internal tool/skill IDs stay in the advanced
  path.
- Telegram Managed Bots is the intended consumer path, but it is not currently
  release-proven for the RC. The 2026-05-18 spike proved the backend design can
  create and verify managed child bots, while the 2026-06-05 RC proof is blocked
  by Telegram/BotFather hanging inside the Create Bot transaction before Jarvis
  receives a backend callback. Fallback BotFather token setup is the RC proof
  path; managed creation remains launch-critical unless explicitly waived.
- Jarvis Consumer RC Telegram proof should treat Telegram Desktop Start,
  BotFather managed bot creation, command-menu screenshots, and follow-up DM
  steps as human handoff when the user is actively using the Mac. The agent may
  open Telegram and capture cropped proof only after the user says ready; a
  full Telegram window capture can expose private chats and does not prove the
  app is foreground or actionable.
- Clean onboarding should be Start -> Jarvis reports the bot is connected ->
  send `Wake up my friend` -> `Verify Telegram` -> `Next` enabled. Asking for
  another DM on that path is a launch blocker/product bug, not expected test
  friction.
- Claude Code should become a consumer-facing model lane, not founder-only, but
  not for the immediate next 4-5 tester package. Gate broader exposure on more
  founder use of the Claude CLI backend. Before website, Stripe, Reddit/GitHub,
  or public-ish beta launch, `/model` should expose Claude when the local
  Claude Code command is installed, authenticated, and intentionally enabled.
- Consumer `/model` should stay decision-oriented, not catalog-oriented:
  - Top level: `Claude`, `ChatGPT`, and `Model Providers`.
  - `Claude` shows `Sonnet 4.6` as the recommended model, mapping to
    `claude-cli/sonnet`.
  - `Claude` -> `More` shows `Opus 4.7` and `Larger context`.
  - `Claude` -> `Larger context` shows `Opus 4.7 (1M)` mapping to
    `claude-cli/opus[1m]` and `Sonnet 4.6 (1M, Max only)` mapping to
    `claude-cli/sonnet[1m]`.
  - Selecting `Sonnet 4.6 (1M, Max only)` should warn that Claude Max may be
    required and that Claude Pro may use paid extra usage instead of
    subscription quota.
  - `ChatGPT` shows `GPT-5.5` as the recommended model; `ChatGPT` -> `More`
    keeps useful mainstream alternatives such as `GPT-5.4` and
    `GPT-5.3 Codex Spark`.
  - Smaller/debug models such as Claude Haiku and GPT mini should not clutter
    the normal `More` menus. Keep them behind `Model Providers` or an advanced
    provider surface for benchmarking, fallback, or power-user use.
  - `Model Providers` groups access paths, not normal model choices:
    subscription logins (`ChatGPT / Codex`, `Claude / Claude Code`), API key
    providers (`OpenAI`, `Anthropic`, `Gemini`, etc.), and developer/legacy
    providers such as `Claude Bridge`.
  - Hide Claude CLI rows unless local Claude Code is installed, authenticated,
    and enabled. Hide Claude API rows unless an Anthropic API key or advanced
    provider settings exist. Hide `Claude Bridge` unless developer/legacy mode
    is enabled.
- macOS onboarding and Settings should follow the same product direction after
  the Claude confidence gate: do not show Claude as "Coming soon" once this
  ships. Show `Claude / Claude Code` when the local Claude Code path is ready;
  keep Anthropic API setup in advanced/BYOK provider settings.
- Current implementation state, acceptance criteria, and remaining Telegram
  gates live in `docs/research/jarvis-consumer-launch-plan.md`.
- Out of scope for this slice: broad onboarding copy polish, `/visibility`
  command cleanup, group/threaded auto-setup,
  `ai.jarvis.mac` identity migration, Sparkle update-cycle proof, final DMG
  packaging, and wider beta blockers.
- `/visibility` should replace stale `/verbose` naming in the Telegram command
  list and runtime behavior. Before wider beta, inspect upstream's current
  command/visibility implementation, then prove the Jarvis command list and
  `/visibility off|on|full` behavior with a tester bot before merging.

## 60-second demo script

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
> changing. The important part: it is working inside the same Mac environment
> where my files, tools, and sessions already exist."

25-40 seconds:

Show local action:

- file open or terminal command
- browser/repo window
- diff preview
- Telegram progress summary

Voiceover:

> "It can use local files, browser state, tools, and project context without me
> moving work into another cloud dashboard."

40-52 seconds:

Show final Telegram answer:

> "It comes back with the result, what changed, what it verified, and what still
> needs a human decision."

52-60 seconds:

Close:

> "Jarvis is open source, Mac-first, and built for delegation. Start with
> Personal if you want the normal consumer path, or Core if you want raw
> API-key control."

## Launch copy snippets

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

## Open Artem decisions

- Confirm exact public wording for "powered by OpenClaw" in developer-facing
  surfaces.
- Confirm exact launch artifact name once the next signed build is cut.
