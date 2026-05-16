# Jarvis Launch Package

Status: v1 launch package draft
Owner: Artem
Last updated: 2026-05-14

This document turns the launch plan into decisions that can be shipped into the
GitHub README, release notes, pricing copy, and the first 60-second demo.

## Brand and rename boundary

Jarvis is the public consumer brand from the start. OpenClaw can appear as
technical, developer, repo, or "powered by OpenClaw" language only.

Public-facing app/docs, visible app name, release artifacts, and app icon are
Jarvis now.

For the 3 trusted waiting testers only, bundle ID, runtime identity, update
feed identity, and deeper internal renames intentionally stay on
`ai.openclaw.consumer.mac` and OpenClaw paths so the notarized package can ship
fastest. Before Reddit/GitHub, public-ish beta, or any wider beta beyond that
tiny trusted ring, `ai.jarvis.mac` bundle ID/runtime/update identity migration
is a required launch gate. Do not treat that migration as a quick rename; it
needs a deliberate lane because it can affect permissions, state, LaunchAgents,
and update continuity.

## Backend deployment status

Current beta backend:

- Render service: `jarvis-backend`
- Service ID: `srv-d80sqc8g4nts738v1j80`
- URL: `https://jarvis-backend-klvq.onrender.com`
- Region/plan: `virginia` / `starter`
- Source: `https://github.com/artemgetmann/openclaw` on `main`

Verified on 2026-05-12:

- `/healthz` is live and reports production mode.
- OpenAI is configured server-side.
- Anthropic is not configured yet.
- The managed utility smoke endpoint works with the backend token.
- Neon persistence is configured server-side in Render.
- Account activation creates a persisted 14-day trial.
- License status succeeds for a valid account token.
- Repeated activation for the same email fails closed with 409.
- Invalid account access tokens reject with 401.

Backend/account persistence is ready for the next beta package smoke. Anthropic
remains unset, so do not claim Anthropic-managed utility coverage yet.

## Release package status

Current package truth:

- Jarvis visible branding is in place for the app name, release artifacts, and
  app icon.
- Bundle ID/runtime/update identity remain `ai.openclaw.consumer.mac` and
  OpenClaw paths only for the 3 trusted waiting testers by deliberate 80/20
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
- Known trusted-build caveat: after launch, Jarvis can materialize extension
  dependencies under
  `/Applications/Jarvis.app/Contents/Resources/OpenClawRuntime/openclaw/dist/extensions/acpx/node_modules`.
  That mutates the signed app bundle and makes a later `codesign --verify`
  report a sealed-resource failure until the app is reinstalled from the DMG.
  This is acceptable for the 3 trusted waiting testers as an early trusted
  build caveat, but it is a required fix before Reddit/GitHub, public-ish beta,
  or any wider beta. Runtime-writable extension dependencies must move to
  Application Support or another writable state/cache path outside
  `/Applications/Jarvis.app`.
- Sending `Jarvis.dmg` to the 3 trusted waiting testers is allowed. Do not send
  wider/public until the `ai.jarvis.mac` identity migration and remaining wider
  beta gates are complete.
- Full newer-version Sparkle update-cycle testing is deferred for speed. Current
  proof covers appcast/feed reachability and no Update Error; a real
  download/verify/install/relaunch/preserve-state cycle should be tested before
  relying on an update to recover trusted users or before broader distribution.
- Recommended release path for the next lane: App Store Connect API key auth
  plus async notarization submit/poll/staple receipts. Set
  `NOTARYTOOL_KEY`, `NOTARYTOOL_KEY_ID`, and `NOTARYTOOL_ISSUER` through the
  machine release env; leave `NOTARYTOOL_PROFILE` unset unless deliberately
  using the fallback path.
- Keychain-profile notarization remains a fallback for emergency/manual
  recovery only. It should not be the default release path because Apple ID
  app-specific password and 2FA recovery made the previous package lane too
  brittle.
- Artem must create or provide the actual App Store Connect API key if it is
  not already present on the machine. Do not block the release docs on fake
  placeholders or commit key material.
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
  in source, but there is still no packaged installed-app GUI proof yet. Do
  not count this as closed for broader launch proof until the packaged app is
  verified.

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
  update identities stay on `ai.openclaw.consumer.mac` only for the 3 trusted
  waiting testers
- `ai.jarvis.mac` migration is required before Reddit/GitHub, public-ish beta,
  or a wider beta, and needs a deliberate migration lane because permissions,
  state, LaunchAgents, and update continuity can be affected
- post-launch app-bundle mutation is also a wider-beta blocker: Jarvis must not
  write extension `node_modules` or other runtime dependencies inside
  `/Applications/Jarvis.app` after signing
- final 2026-05-14 trusted-tester `Jarvis.dmg` from commit `ab9c3c1ca1` is
  notarized, Gatekeeper-accepted, copied to the sacred repo root, uploaded with
  its Jarvis ZIP/appcast assets, installed over Artem's current app, and smoke
  tested. Sending to the 3 trusted waiting testers is allowed; wider
  distribution still waits on `ai.jarvis.mac` migration, post-launch bundle
  immutability, and the remaining beta gates.

### Roadmap

- send the final `/Users/user/Programming_Projects/openclaw/Jarvis.dmg` to the
  3 trusted waiting testers
- focused Channels UI polish to remove duplicated connected-bot text/buttons
- smoother account login and trial activation
- cleaner Telegram setup with one consumer-first command/settings surface
- Apple-style signed, verified updates that keep setup, preferences, and local
  data in place
- App Store Connect API key auth and async submit/poll/staple notarization
  receipts as the default repeatable release packaging path
- move runtime-writable extension dependencies out of the signed app bundle
  before wider beta
- run a real newer-version Sparkle update cycle before relying on updates for
  recovery or wider distribution
- better first-run permission copy
- backend-managed utility cap hardening
- skill audit and safer third-party skill install flow
- `ai.jarvis.mac` bundle ID/runtime/update identity migration before
  Reddit/GitHub, public-ish beta, or any wider beta
- website after GitHub/Reddit signal

### Telegram command/settings strategy

Normal users should see the same Telegram bot behavior Artem uses, but with
consumer-safe defaults. The default `/settings` surface should use plain names,
hide internal IDs, and keep advanced controls off by default.

Advanced/developer controls should be available intentionally, not scattered
through consumer setup. Candidate shape:

- `/settings` shows the normal settings menu and an "Advanced settings" toggle.
- `/advanced` or `/enable advanced` can expose developer/provider/BYO-bot/custom
  command settings for power users.
- Shared/default bot setup stays the consumer path; BYO bot token, custom
  commands, verbose developer detail, and internal tool/skill IDs stay in the
  advanced path.
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
