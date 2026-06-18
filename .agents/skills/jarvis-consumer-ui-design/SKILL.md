---
name: jarvis-consumer-ui-design
description: "Use when designing, reviewing, or editing Jarvis consumer onboarding UI/copy, especially macOS setup pages, Telegram onboarding, Chrome account selection, permissions language, and recovery/error copy."
---

# Jarvis Consumer UI Design

Use this skill before changing Jarvis consumer onboarding screens or judging
whether onboarding copy/layout is ready for users.

Read `docs/jarvis/VISION.md` first when the UI/copy change affects product
promise, onboarding strategy, launch positioning, pricing, or user-facing
defaults. For narrow visual fixes, this skill is enough.

## Core stance

Make setup feel like Apple setup assistant: one clear screen, one job, obvious
navigation, and no internal machinery leaking into the user's face.

Default to subtraction. If the title, subtitle, card heading, helper text, and
button all say the same thing, the design is not simple yet. Keep the strongest
version and remove the rest.

## Onboarding layout

- Use one screen per job.
- Show a large icon or Jarvis brand signal on each setup page.
- Use a plain title and one short subtitle.
- Keep explanatory text minimal. If the user cannot act on it, cut it.
- Do not repeat the page job inside nested cards. For a single-field setup page,
  the ideal first impression can be just title, subtitle, field, primary action,
  and Back/Next.
- Do not use top step tabs for consumer setup.
- Do not use bottom progress dots for consumer setup.
- Use Back and Next as the primary navigation.
- Keep product/page identity visible. Avoid whole-page scrolling that hides the
  title, brand, or current task.
- If a page needs more content, put the long part in a bounded inner scroll
  region so the page identity stays anchored.

## Copy rules

- Prefer consumer language over technically perfect internal terms.
- Copy should be short, concrete, and singular. Avoid saying the same intent in
  multiple places, such as title plus subtitle plus card title plus helper plus
  button.
- Use terms that answer the user's real question. For Chrome account selection,
  "Chrome Account" can beat "Chrome Profile" because the user is asking which
  signed-in browser identity Jarvis should use.
- Keep exact internal IDs, provider names, ports, file paths, and runtime labels
  out of primary copy.
- Distinguish required and optional permissions clearly.
- Avoid repeating scary permission text. Say what is needed, why it matters, and
  what the user should do next.
- Keep recovery/error copy out of the default first impression. Only show it
  after there is an actual problem.
- Hide internal stack traces, ports, file paths, gateway jargon, and runtime
  readiness errors from onboarding UI.
- Surface simple recovery copy instead: what happened, whether Jarvis can retry,
  and the smallest next action.

## Simplification examples

For an account email step, prefer this shape:

- Title: `Continue with Email`
- Subtitle: `Enter your email to set up Jarvis on this Mac.`
- Body: email field and `Continue`

Avoid adding a second visible card title like `Continue with email` plus helper
text that repeats the same job. If the backend only supports email activation,
do not imply password, OAuth, or a full register/sign-in flow.

## Current page baselines

- Chrome title: `Choose Your Main Chrome Account`
- Chrome subtitle: `Jarvis will use this Chrome browser, so you don’t have to log in everywhere again.`
- Telegram uses Managed Bots as the primary onboarding path; manual
  BotFather/BYO bot stays fallback/advanced.
- Visual language: color, typography, and deeper brand styling are deferred.
  The current blue accent is acceptable for now.

## Review checklist

Before calling onboarding UI/copy ready, check:

- Can a non-technical user tell what this screen is asking them to do?
- Is there exactly one primary job on the screen?
- Does the screen say that job once, instead of repeating it in several labels?
- Are Back and Next enough, without step tabs or progress dots?
- Does Jarvis identity stay visible while interacting with the page?
- Are required permissions obvious without sounding alarming?
- Are internal errors translated into plain recovery guidance?
- Does Telegram follow the Managed Bots-first path with BotFather fallback?
