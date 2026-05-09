# Jarvis Launch Package

Status: v1 launch package draft
Owner: Artem
Last updated: 2026-05-09

This document turns the launch plan into decisions that can be shipped into the
GitHub README, release notes, pricing copy, and the first 60-second demo.

## v1 commercial decision

Launch with two public plans and one invite-only plan.

| Plan                     | Price    | Buyer                         | Public at launch | Main boundary                                      |
| ------------------------ | -------- | ----------------------------- | ---------------- | -------------------------------------------------- |
| Jarvis Core              | $19/mo   | technical and power users     | yes              | BYOK model and tool providers                      |
| Jarvis Plus              | $39/mo   | users who hate API-key setup  | yes              | BYOK model, managed utility budget                 |
| Jarvis Managed AI        | $99/mo   | non-technical early customers | invite-only      | managed model plus managed utility fair-use budget |
| Jarvis Founder Concierge | $299/mo+ | high-touch pilot customers    | no               | onboarding, workflow setup, priority support       |

The public launch page should show Core and Plus. Managed AI can be mentioned
as "early access" only if the backend controls and cost caps are ready.
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

### Jarvis Core

Core includes:

- signed/notarized macOS app downloads while subscription is active
- automatic updates while subscription is active
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

### Jarvis Plus

Plus includes everything in Core plus a managed utility budget for normal
personal use.

Plus still expects the user to bring their primary model access at v1. This is
the sane middle ground: it removes the six-key setup pain without pretending
heavy AI model usage fits inside a $39 subscription.

Included monthly managed utility allowances:

- speech-to-text: 300 minutes
- standard text-to-speech: 250,000 characters
- high-quality TTS: 100 messages or equivalent cap
- search and maps: 1,000 combined requests
- scraping: 500 pages
- image generation: 25 images

Plus backend guardrails:

- hard service-cost cap: $8/user/month unless Artem manually raises it
- abuse/rate cap: backend configurable without app update
- overflow: ask user to add BYOK keys, upgrade, or wait until next cycle
- no video generation in v1

### Jarvis Managed AI

Managed AI is invite-only until real usage data proves the economics.

Managed AI includes:

- managed model access
- managed utility budget
- higher fair-use limits
- priority onboarding support

Initial monthly fair-use allowance:

- managed model service-cost cap: $45/user/month
- speech-to-text: 1,000 minutes
- standard text-to-speech: 1,000,000 characters
- high-quality TTS: 500 messages or equivalent cap
- search and maps: 5,000 combined requests
- scraping: 2,000 pages
- image generation: 100 images

Managed AI must stop, degrade, or request approval before it burns past the cap.
Unlimited managed AI at consumer pricing is a margin trap. Do not ship it.

## BYOK versus managed boundary

Plain English:

- BYOK means the user brings their own provider accounts and pays those
  providers directly.
- Managed means Jarvis uses backend-owned provider access and meters usage per
  Jarvis account.

BYOK call path:

```text
User -> local Jarvis app -> provider API
```

Managed call path:

```text
User -> Jarvis app -> Jarvis backend -> provider API
```

Rules:

- Core users are BYOK by default.
- Plus users are BYOK for primary models and managed for limited utilities.
- Managed AI users are managed for primary models and utilities.
- Raw managed provider keys must never be packaged inside the app.
- Raw managed provider keys must never be sent to the app.
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

| Plan        | Price  | Best for                 | Included provider usage             |
| ----------- | ------ | ------------------------ | ----------------------------------- |
| Jarvis Core | $19/mo | power users              | BYOK                                |
| Jarvis Plus | $39/mo | fewer keys, easier setup | managed utilities, BYOK model usage |

Copy:

> Start with a 14-day trial. Core is for people who prefer their own provider
> keys. Plus removes most utility-key setup for normal personal use. Managed AI
> is invite-only while we tune cost controls.

### Local-first trust block

Say this directly:

> Jarvis runs on your Mac because your real work lives there: browser sessions,
> files, apps, permissions, project tools, and local context. Managed services
> are optional and metered. BYOK users can keep provider usage local.

### Honest limitations

- macOS first
- Telegram first
- setup is improving fast, but early users should expect sharp edges
- some integrations require user-owned accounts or API keys
- third-party skills can run code and should be treated as untrusted until
  reviewed
- managed AI is invite-only until usage economics are proven

### Roadmap

- smoother account login and trial activation
- cleaner Telegram setup
- automatic signed updates
- better first-run permission copy
- managed utility tier hardening
- skill audit and safer third-party skill install flow
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

> "Jarvis is open source, Mac-first, and built for delegation. Start with Core
> if you bring your own keys, or Plus if you want managed utilities included."

## Launch copy snippets

Reddit/GitHub angle:

> I built a local-first Jarvis for Mac that can actually operate your computer.
> It is open source, Telegram-first, and I am looking for early users who want a
> personal AI operator instead of another chatbot.

One-line product description:

> Jarvis is a Telegram-first AI operator that runs on your Mac and gets real
> computer work done.

Pricing one-liner:

> Core is $19/mo for BYOK power users. Plus is $39/mo with managed utilities for
> normal personal use.

## Open Artem decisions

- Confirm whether the product name is Jarvis for public launch while OpenClaw
  remains the engine/repo name.
- Confirm whether Managed AI should be visible as invite-only in the README or
  hidden until backend cost data exists.
- Confirm whether the first public trial should require no credit card for all
  users or only for GitHub/Reddit beta cohorts.
- Confirm exact launch artifact name once the next signed build is cut.
