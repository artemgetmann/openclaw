---
name: what-can-you-do
description: Answer user-facing capability and intro questions like "what can you do?", "how can you help me?", "what is this bot good at?", or "how should I use you?". Use when the user wants a grounded overview of what this bot can currently do in this runtime. Tailor the answer to the user, explain the relevant skills currently available, give concrete examples, and clearly separate ready-now abilities from anything that still needs setup.
user-invocable: false
metadata: { "openclaw": { "always": true, "emoji": "🤖" } }
---

# What Can You Do

Use this skill when the user asks what you can do, how you can help, what is
available right now, or gives a generic intro like "what are you good at?".

## Primary Goal

Give the user a useful, grounded orientation to this specific bot instance.
They should come away knowing:

- what this bot can help with right now
- which skills or integrations are available
- what kinds of tasks are a good fit
- what still needs setup, if anything
- what they should ask for next

## Personalize The Answer

- Tailor the answer to the user when context makes that possible.
- If the visible memory or context suggests an engineering user, emphasize
  things like coding help, sub-agents, ACP/runtime work, debugging, docs,
  browser automation, and building tools.
- If the visible memory or context suggests a personal-operator user, emphasize
  things like email, messaging, daily digests, monitoring, reminders, research,
  travel/admin tasks, browser help, and personal workflows.
- If you do not have enough context to specialize confidently, give a balanced
  answer that covers both personal-operator and builder use cases.
- If `user.md`, `memory.md`, daily memory, or memory tools are visible in the
  current context, explain those only as they actually exist here. Do not assume
  a memory layout that you cannot see.

## Grounding Rules

- Ground the answer in the current runtime, loaded skills, tool availability,
  channel constraints, and visible context files only.
- Treat the skills visible in `<available_skills>` as the ready-now skill
  surface unless the current runtime clearly indicates setup is still needed.
- Mention built-in non-skill capabilities only when they are actually visible in
  the current runtime context, such as browser control, messaging, coding,
  document work, memory, charts/HTML output, or image generation/editing.
- Separate ready-now capabilities from setup-needed capabilities.
- If something is installed but blocked by setup, say that directly instead of
  pretending it is fully available.

## Answer Shape

- Start with a short plain-language summary of the strongest things the bot can
  help with right now.
- For broad intro questions, include the visible skill inventory instead of
  giving only a generic summary.
- Then explain the relevant visible skills one by one:
  - skill name
  - short description in plain language
  - what it is useful for
- Then mention broader capabilities if they are actually visible here, such as:
  - coding / debugging / sub-agents
  - browser automation and form-filling
  - booking, ordering, travel planning, and admin tasks done through the web
  - research and web tasks
  - document creation or conversion
  - data visualization / HTML outputs / PDF export
  - image understanding or image generation/editing
  - email / WhatsApp / Google / maps / reminders / notes
- Then call out anything that still needs setup.
- End with a few concrete example requests the user can try next.

## Skills Section

- If the user is asking a broad capability question, tell them every visible
  skill you have access to unless the list is extremely large.
- If the list is large, keep it compact, but still mention each visible skill by
  name with a short plain-language use case.
- Do not hide multiple skills behind vague summaries.
- Tell the user the skill names and what each one is useful for.
- Prefer a compact, scannable list over a giant paragraph.
- If a skill description is visible, use that description as the starting point,
  then translate it into user language.
- If a skill is visible but clearly setup-bound, say so:
  - "I have X available, but it still needs setup before I can use it."
- If the `skill-creator` skill is available, mention that the user can teach
  the bot a repeatable workflow and ask it to turn that workflow into a new
  skill.
- Prefer user outcomes over internal implementation detail. For example, say
  "I can help book flights or fill web forms in your browser" before explaining
  browser variants or technical routing.

## Memory Section

- If memory is visible in this runtime, explain it in plain language.
- Distinguish user memory, bot long-term memory, and any daily/rolling memory
  only if those surfaces are actually present in the context.
- Explain what each one is for in practical terms:
  - stable preferences/about-the-user memory
  - ongoing bot/project memory
  - day-specific or short-horizon notes
- Do not invent exact filenames or storage behavior unless you can see them.

## Tone

- Conversational, useful, and direct.
- Not a menu dump.
- Not a help-center article.
- No fluff, no self-promotion, no fake confidence.

## What Not To Do

- Do not invent abilities that are not present in the current runtime.
- Do not dump every slash command unless the user explicitly asks for commands.
- Do not answer in generic marketing language.
- Do not bury setup gaps inside a polished answer.
- Do not list obscure internal details unless they help the user decide what to
  ask for.

## Good Framing

When the user asks broadly, answers should sound like:

- "Here is what I can help with right now."
- "These are the main skills I have access to here, and what each one is good for."
- "These parts are ready now, and these parts still need setup."
- "If you want, pick one and I can show you a concrete example."
