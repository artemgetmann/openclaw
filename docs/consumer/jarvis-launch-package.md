# Jarvis Launch Package

Status: v1 launch package draft
Owner: Artem
Last updated: 2026-05-14

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

Current package truth:

- Jarvis visible branding is in place for the app name, release artifacts, and
  app icon.
- Bundle ID/runtime/update identity remain `ai.openclaw.consumer.mac` and
  OpenClaw paths only for the small trusted tester ring by deliberate 80/20
  decision.
- Non-secret Sparkle release config lives at
  `~/Library/Application Support/OpenClaw/release.env` and should be inherited
  by all worktrees/chats.
- API token and Neon URL are stored outside Git in macOS Keychain.
- Final trusted-tester package from 2026-05-14 was built from commit
  `ab9c3c1ca1` at
  `/Users/user/Programming_Projects/openclaw/.worktrees/jarvis-package-recut-20260514/dist/Jarvis.dmg`
  and copied to `/Users/user/Programming_Projects/openclaw/Jarvis.dmg`.
  `Jarvis.dmg` is Gatekeeper-accepted as Notarized Developer ID.
- Public release assets for `v2026.3.15` now include `Jarvis.dmg`,
  `Jarvis.zip`, and `jarvis-appcast.xml`; the Jarvis appcast URL returns 200
  and points Sparkle at the uploaded `Jarvis.zip`.
- `/Applications/Jarvis.app` on Artem's machine has been installed from the
  final trusted-tester DMG and now reports `OpenClawGitCommit=ab9c3c1ca1`,
  `CFBundleDisplayName=Jarvis`, and `CFBundleIdentifier=ai.openclaw.consumer.mac`.
  The installed app passes `scripts/verify-consumer-mac-app.sh --release`,
  Gatekeeper accepts it as Notarized Developer ID, and stapler validation
  succeeds.
- Prior installed app smoke on the older Jarvis build passed: visible app name
  and icon were Jarvis, bundle ID intentionally remained
  `ai.openclaw.consumer.mac`, runtime takeover was green, `/healthz` returned
  `{"ok":true,"status":"live"}`, and Channels showed Telegram live/verified as
  `@Jarvis_cl4w_bot`.
- Computer Use GUI smoke on the installed app verified the Settings sidebar
  exposes only General, Channels, Browser, AI access, Permissions, and About by
  default. The Permissions primary list contains only Screen Recording,
  Accessibility, Automation (AppleScript), and Location. Notifications,
  Microphone, Camera, and Speech Recognition are under "More permissions
  (optional)".
- About -> Check for Updates no longer returns Update Error; the installed app
  reaches Sparkle and reports "You're up to date! Jarvis 2026.3.14 is currently
  the newest version available." This proves feed retrieval, not a newer-version
  update installation.
- Clean trusted-tester smoke passed: the DMG hash matched
  `784ee3b1c77f8612a4bf3525b8f8ca8b2e9f63863e0f94732f2f6d309c48ac89`, the
  installed app reports commit `ab9c3c1ca1`, targeted Settings tests passed, and
  the isolated fresh-user packaged smoke passed from the final root
  `Jarvis.dmg` with isolated state, isolated gateway health, onboarding
  observed, and real user config unchanged. A true separate macOS account smoke
  was deliberately skipped as unnecessary for the 3 trusted waiting testers.
- Post-launch app-bundle mutation has a code fix in the packaging/runtime
  branch. Root cause was packaged Jarvis treating bundled app resources as the
  gateway project root while the `acpx` plugin could lazily run `npm install`
  under `dist/extensions/acpx`. The fix treats `OpenClawRuntime` resources as
  seed-only, prefers the seeded Application Support runtime for packaged
  gateway identity, and routes managed `acpx` dependencies to
  `$OPENCLAW_STATE_DIR/cache/extensions/acpx` outside `/Applications/Jarvis.app`.
  Validation on 2026-05-16: targeted `acpx` Vitest coverage passed, macOS
  `ConsumerBundledRuntimeTests` plus `GatewayLaunchAgentManagerTests` passed per
  suite, and an isolated generated-runtime proof installed `acpx@0.3.0` under
  `$OPENCLAW_STATE_DIR/cache/extensions/acpx` while leaving
  `dist/extensions/acpx/node_modules` absent. Copied-app proof also passed from
  a temp signed Jarvis app: `acpx` installed under isolated state/cache, the app
  bundle still had no `dist/extensions/acpx/node_modules`, and
  `codesign --verify --deep --strict` passed after the runtime path was
  exercised.
- The 2026-05-14 `Jarvis.dmg` remains a trusted-ring artifact only. The next
  4-5 waiting testers should receive a recut from current `main` after P0
  onboarding fixes. Do not send wider/public until the `ai.jarvis.mac` identity
  migration and remaining wider beta gates are complete.
- Full newer-version Sparkle update-cycle testing is deferred for speed. Current
  proof covers appcast/feed reachability and no Update Error; a real
  download/verify/install/relaunch/preserve-state cycle should be tested before
  relying on an update to recover trusted users or before broader distribution.
- Recommended release path for the next lane: App Store Connect API key auth
  plus async notarization submit/poll/staple receipts. Set
  `NOTARYTOOL_KEY`, `NOTARYTOOL_KEY_ID`, and `NOTARYTOOL_ISSUER` through the
  machine release env; leave `NOTARYTOOL_PROFILE` unset unless deliberately
  using the fallback path.
- Dry-run release preflight truth from 2026-05-16: ASC API-key lane was ready
  on Artem's machine, the fallback `NOTARYTOOL_PROFILE` was present and usable,
  and the preflight stayed read-only. It did not submit notarization, staple,
  package, upload, or mutate release assets.
- Keychain-profile notarization remains a fallback for emergency/manual
  recovery only. It should not be the default release path because Apple ID
  app-specific password and 2FA recovery made the previous package lane too
  brittle.
- Artem must create or provide the actual App Store Connect API key if it is
  not already present on the machine. Do not block the release docs on fake
  placeholders or commit key material.
- Follow-up preflight on 2026-05-16 confirmed Sparkle `generate_appcast` is
  already available from the repo SwiftPM build. Local Spotlight search found
  no existing `AuthKey_*.p8`, so the missing piece was Apple API-key setup, not
  Sparkle tooling.
- Current ASC blocker captured by the conductor on 2026-05-16:
  `/access/integrations/api` is reachable after login, but it does not show API
  keys. It shows "Permission is required to access the App Store Connect API.
  You can request access on behalf of your organization." with a Request Access
  button.
- Follow-up ASC state on 2026-05-16: Artem approved and submitted the App Store
  Connect API access request. Apple immediately showed "Your request to access
  the App Store Connect API was approved", `Active (0)`, and `Generate API Key`.
  Screenshot proof:
  `/tmp/openclaw/asc-api-access-approved-generate-key.png`.
- Final ASC credential state on 2026-05-16: Artem approved key generation. The
  `Jarvis Notary` team key was created with Developer access, its one-time
  `.p8` was downloaded, moved out of iCloud Downloads, stored at
  `~/Library/Application Support/OpenClaw/release-keys/`, and locked to mode
  `600`. The machine release env now has `NOTARYTOOL_KEY`,
  `NOTARYTOOL_KEY_ID`, and `NOTARYTOOL_ISSUER`. Read-only preflight ended with
  `Final: ASC API key lane ready.`
- `ai.jarvis.mac` bundle ID/runtime/update identity migration is a required
  launch gate before Reddit/GitHub, public-ish beta, or a wider beta.
- Do not send to Reddit/GitHub/public-ish beta until the `ai.jarvis.mac`
  bundle/runtime/update migration is complete.
- Local cleanup on Artem's machine was completed after approval on 2026-05-16:
  the old `/Applications/OpenClaw.app`, stale GUI smoke app processes, and stale
  `gui-verify` / `consolidation-gui-smoke` / `macos-ui-cleanup` LaunchAgents
  were removed. `/Applications/Jarvis.app`, the default gateway, watchdog, mail
  monitor, and the separate Chrome Telegram-live profile were kept.
- The duplicate connected-bot Settings copy/buttons issue has been addressed
  in source. Current-main GUI proof was captured on 2026-05-16 with the
  isolated `channels-proof` native UI-smoke app: Settings -> Channels rendered
  one Telegram detail pane, one `Connected bot` section, one verified card, and
  one `Open your bot` action. Screenshot:
  `/tmp/openclaw/full-after-ready-channel-click.png`. This proves the merged
  UI state, but the existing trusted-tester `Jarvis.dmg` was built before PR
  #719, so exact release-DMG proof still requires a recut if we want to ship
  that polish in a public artifact.
- Packaging-smoke iteration speed note from 2026-05-16: the full fast package
  loop was slow because it still staged the full bundled runtime, redeployed the
  large production `node_modules` tree, recopied Node/uv payloads, and signed
  runtime binaries on every shell-only app smoke. Local smoke lanes can now run
  `bash scripts/package-consumer-mac-app-fast.sh --instance <id> --reuse-runtime`
  after one normal fast package, but shipping/default package behavior remains
  unchanged.

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
- final 2026-05-14 trusted-tester `Jarvis.dmg` from commit `ab9c3c1ca1` is
  notarized, Gatekeeper-accepted, copied to the sacred repo root, uploaded with
  its Jarvis ZIP/appcast assets, installed over Artem's current app, and smoke
  tested. It remains a trusted-ring artifact only; the next 4-5 waiting testers
  should receive a current-main recut after P0 onboarding fixes. Wider
  distribution still waits on `ai.jarvis.mac` migration, post-launch bundle
  immutability, and the remaining beta gates.

### Roadmap

Use `docs/research/jarvis-consumer-launch-plan.md` for the live task tracker,
owners, proof, and P0/P1/P2 status. This package doc keeps only launch-facing
truth:

| State                                                            | Launch-facing item                                                                                                                                                                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Completed for trusted testers                                    | Jarvis visible branding, notarized trusted-tester DMG, public Jarvis ZIP/appcast assets, account/trial backend, managed utility backend, page-based onboarding shell, Managed Bots-first Telegram path.      |
| Needed before the next 4-5 waiting testers receive a new package | A recut from current `main` after the P0 onboarding fixes, plus package verification that source polish and secret-safety gates are actually in the shipped artifact.                                        |
| Needed before Reddit / broad public beta                         | `ai.jarvis.mac` bundle/runtime/update identity migration, full Sparkle update-cycle proof, broader onboarding polish, Claude Code consumer exposure, Telegram model-picker cleanup, and public-copy cleanup. |
| Deferred until evidence of friction                              | Maintenance polish that does not block current testers.                                                                                                                                                      |

### Telegram command/settings strategy

Normal users should see the same Telegram bot behavior Artem uses, but with
consumer-safe defaults. The default `/settings` surface should use plain names,
hide internal IDs, and keep advanced controls off by default.

Advanced/developer controls should be available intentionally, not scattered
through consumer setup. Candidate shape:

- `/settings` shows the normal settings menu and an "Advanced settings" toggle.
- `/advanced` or `/enable advanced` can expose developer/provider/BYO-bot/custom
  command settings for power users.
- Managed Bots stays the consumer path; BYO BotFather token, custom commands,
  verbose developer detail, and internal tool/skill IDs stay in the advanced
  path.
- Telegram Managed Bots is viable. The 2026-05-18 live spike proved Jarvis can
  run a manager bot, let the user approve creation of a personal managed Jarvis
  bot, fetch the managed token server-side, verify the child bot, and restrict
  access. The follow-up live smoke proved Render health with
  `telegram_managed_bots=true` and a connected start/status session with token
  output redacted. The normal path is now replacing the manual BotFather setup
  step with this manager-bot approval flow while keeping BYO BotFather tokens in
  the advanced path.
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
