---
name: jarvis-consumer-ui-design
description: "Use when designing, reviewing, or editing Jarvis consumer onboarding UI/copy, especially macOS setup pages, Telegram onboarding, Chrome account selection, permissions language, and recovery/error copy."
---

# Jarvis Consumer UI Design

Use this skill before changing Jarvis consumer onboarding screens or judging
whether onboarding copy/layout is ready for users.

## Core stance

Make setup feel like Apple setup assistant: one clear screen, one job, obvious
navigation, and no internal machinery leaking into the user's face.

## Onboarding layout

- Use one screen per job.
- Show a large icon or Jarvis brand signal on each setup page.
- Use a plain title and one short subtitle.
- Keep explanatory text minimal. If the user cannot act on it, cut it.
- Do not use top step tabs for consumer setup.
- Do not use bottom progress dots for consumer setup.
- Use Back and Next as the primary navigation.
- Keep product/page identity visible. Avoid whole-page scrolling that hides the
  title, brand, or current task.
- If a page needs more content, put the long part in a bounded inner scroll
  region so the page identity stays anchored.

## Copy rules

- Prefer consumer language over technically perfect internal terms.
- Use terms that answer the user's real question. For Chrome account selection,
  "Chrome Account" can beat "Chrome Profile" because the user is asking which
  signed-in browser identity Jarvis should use.
- Keep exact internal IDs, provider names, ports, file paths, and runtime labels
  out of primary copy.
- Distinguish required and optional permissions clearly.
- Avoid repeating scary permission text. Say what is needed, why it matters, and
  what the user should do next.
- Hide internal stack traces, ports, file paths, gateway jargon, and runtime
  readiness errors from onboarding UI.
- Surface simple recovery copy instead: what happened, whether Jarvis can retry,
  and the smallest next action.

## Current page baselines

- Chrome title: `Choose Your Main Chrome Account`
- Chrome subtitle: `Jarvis will use this Chrome browser, so you don’t have to log in everywhere again.`
- Telegram: keep the current manual BotFather flow for now. Do not design or
  implement Managed Bots migration from this skill.
- Visual language: color, typography, and deeper brand styling are deferred.
  The current blue accent is acceptable for now.

## Review checklist

Before calling onboarding UI/copy ready, check:

- Can a non-technical user tell what this screen is asking them to do?
- Is there exactly one primary job on the screen?
- Are Back and Next enough, without step tabs or progress dots?
- Does Jarvis identity stay visible while interacting with the page?
- Are required permissions obvious without sounding alarming?
- Are internal errors translated into plain recovery guidance?
- Does Telegram still match the manual BotFather setup path?
