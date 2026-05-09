# Jarvis Launch Package

Status: v1 launch package draft
Owner: Artem
Last updated: 2026-05-09

This document turns the launch plan into decisions that can be shipped into the
GitHub README, release notes, pricing copy, and the first 60-second demo.

## Brand and rename boundary

Jarvis is the public consumer brand from the start. OpenClaw can appear as
technical, developer, repo, or "powered by OpenClaw" language only.

Public-facing app/docs should move toward Jarvis now. The visible app name and
release artifacts should become Jarvis soon, but bundle ID, runtime identity,
update feed identity, and deeper internal renames are a separate migration
task. Do not imply those internals are already renamed.

## v1 commercial decision

Launch with managed service as the main consumer path and BYOK as the advanced
escape hatch.

| Plan                     | Price    | Buyer                      | Public at launch | Main boundary                                |
| ------------------------ | -------- | -------------------------- | ---------------- | -------------------------------------------- |
| Jarvis Managed           | $99/mo   | normal consumers           | yes              | managed model and utility budget             |
| Jarvis Core              | $19/mo   | technical and power users  | yes              | BYOK model and tool providers                |
| Jarvis Founder Concierge | $299/mo+ | high-touch pilot customers | no               | onboarding, workflow setup, priority support |

The public launch page should lead with Jarvis Managed because the consumer
promise is "it just works." Jarvis Core exists for advanced users who want to
bring their own model keys, provider accounts, or subscription logins.
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

### Jarvis Managed

Managed is the main consumer plan.

Managed includes:

- signed/notarized Jarvis app downloads while subscription is active
- automatic signed, verified updates while subscription is active
- local-first Jarvis runtime on the user's Mac
- Telegram assistant setup
- managed model access through Jarvis backend-held provider keys
- managed voice/search/scraping/maps/image utility budget
- bundled official skills and workflows
- visibility/logging controls
- priority onboarding support for early customers

Initial monthly fair-use allowance:

- managed model service-cost cap: $45/user/month
- speech-to-text: 1,000 minutes
- standard text-to-speech: 1,000,000 characters
- high-quality TTS: 500 messages or equivalent cap
- search and maps: 5,000 combined requests
- scraping: 2,000 pages
- image generation: 100 images

Managed backend guardrails:

- managed usage must go through the Jarvis backend
- raw founder/provider keys must never be packaged inside the app
- raw founder/provider keys must never be sent to the app
- backend limits must be configurable without an app update
- Jarvis must stop, degrade, or request approval before it burns past the cap
- no video generation in v1

Unlimited managed AI at consumer pricing is a margin trap. Do not ship it.

### Jarvis Core

Core is the advanced BYOK plan.

Core includes:

- signed/notarized macOS app downloads while subscription is active
- automatic signed, verified updates while subscription is active
- local-first Jarvis runtime on the user's Mac
- Telegram assistant setup
- bundled official skills and workflows
- visibility/logging controls
- community or self-serve support
- BYO model keys or subscriptions
- BYO utility keys for search, scraping, maps, speech, image, and other costly
  provider surfaces

Core does not include:

- managed model usage
- managed Brave/Search, Firecrawl, Google Maps, OpenAI, Gemini, or other shared
  provider usage
- priority support
- done-for-you workflow setup

## BYOK versus managed boundary

Plain English:

- BYOK means the user brings their own provider accounts and pays those
  providers directly. It is advanced, not the main launch promise.
- Managed means Jarvis uses backend-owned provider access and meters usage per
  Jarvis account. It is the main consumer path.
- User-owned subscription login means Jarvis uses a user's existing provider
  login where supported. Treat it like an advanced BYOK path, not as managed
  provider access.

BYOK call path:

```text
User -> local Jarvis app -> provider API
```

Managed call path:

```text
User -> Jarvis app -> Jarvis backend -> provider API
```

Rules:

- Jarvis Managed users are managed for primary models and utilities.
- Jarvis Core users are BYOK by default.
- Raw managed provider keys must never be packaged inside the app.
- Raw managed provider keys must never be sent to the app.
- Founder/provider keys live server-side only.
- BYOK provider keys stay local unless the user explicitly opts into a future
  sync/diagnostic flow.
- The backend tracks monthly counters and spend estimates per Jarvis account.
- The backend can pause managed usage independently of local runtime access.

## GitHub README launch outline

The launch README should be a practical landing page, not a marketing site.

### Above the fold

Headline:

> Jarvis is a local-first AI assistant for Mac that actually does things.

Subhead:

> Talk to Jarvis in Telegram. It runs on your Mac, uses your apps and sessions,
> and can handle real workflows across browser, files, messages, code, and
> automations.

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
- remembers preferences and workflows
- can be extended with official and user skills
- keeps advanced customization available without forcing it into first setup

### Pricing block

Use only the public plans:

| Plan           | Price  | Best for         | Included provider usage                      |
| -------------- | ------ | ---------------- | -------------------------------------------- |
| Jarvis Managed | $99/mo | normal consumers | managed models and utilities                 |
| Jarvis Core    | $19/mo | advanced users   | BYOK keys and user-owned subscription logins |

Copy:

> Start with a 14-day no-card trial during the early GitHub/Reddit beta.
> Managed is the main consumer plan: Jarvis uses backend-held provider access so
> setup stays simple. Core is the advanced BYOK plan for people who want to use
> their own provider keys or subscription logins.

### Local-first trust block

Say this directly:

> Jarvis runs on your Mac because your real work lives there: browser sessions,
> files, apps, permissions, project tools, and local context. Managed provider
> access is metered through the Jarvis backend. Advanced BYOK users can keep
> provider usage local.

### Honest limitations

- macOS first
- Telegram first
- setup is improving fast, but early users should expect sharp edges
- Core/BYOK users must bring their own provider keys or subscription logins
- third-party skills can run code and should be treated as untrusted until
  reviewed
- visible app/artifact naming is moving to Jarvis, but internal runtime/update
  identities need a separate migration

### Roadmap

- smoother account login and trial activation
- cleaner Telegram setup
- Apple-style signed, verified updates that keep setup, preferences, and local
  data in place
- better first-run permission copy
- managed usage cap hardening
- skill audit and safer third-party skill install flow
- visible app/artifact rename to Jarvis without breaking bundle/runtime/update
  identity
- website after GitHub/Reddit signal

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
> Managed if you want it to just work, or Core if you want to bring your own
> provider access."

## Launch copy snippets

Reddit/GitHub angle:

> I built a local-first Jarvis for Mac that can actually operate your computer.
> It is open source, Telegram-first, and I am looking for early users who want a
> personal AI operator instead of another chatbot.

One-line product description:

> Jarvis is a Telegram-first AI operator that runs on your Mac and gets real
> computer work done.

Pricing one-liner:

> Managed is $99/mo for the simple consumer path. Core is $19/mo for advanced
> BYOK users.

## Open Artem decisions

- Confirm exact public wording for "powered by OpenClaw" in developer-facing
  surfaces.
- Confirm exact launch artifact name once the next signed build is cut.
