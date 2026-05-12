---
name: monitor-router
description: "Route OpenClaw/Jarvis monitor status questions and natural-language follow-ups. Use when a user asks about active monitors, replies to a monitor update, or wants to send, edit, stop, approve, list, or inspect a watched task; resolve one clear monitor or ask a short clarification."
---

# Monitor Router

Use this when the user asks about an active monitor, replies to a recent monitor
status, or wants to send, edit, stop, or continue a monitored task.

## Core Rule

Treat monitor status notes in the main chat as awareness notes. The monitor
session keeps the detailed task state; the main chat can read compact monitor
state and route actions to the right monitor.

## Workflow

1. Read the recent user message and nearby monitor status notes.
2. For status questions about a watched person or task, use the `monitor` tool
   with `action: "list"` before answering from old chat memory.
3. Use `action: "get"` when one or more candidates need detail.
4. Act only when the target monitor is clear from the contact, topic, source,
   nearby status note, or singular active candidate.
5. If two or more monitors could match, ask a short clarification before any
   external action.
6. For clear status questions, answer from compact monitor state first. Open raw
   evidence only if the user asks or the compact state is not enough.
7. For clear updates, persist a compact checkpoint/status with `action:
"update"` and keep raw evidence behind ids, paths, or refs.

## Ambiguity Safety

Do not send, stop, or mutate a monitor from a vague reply when multiple active
monitors could match.

Good clarification:

> Do you mean Chloe or Samantha?

Bad behavior:

- Guessing which "her" the user meant when two people were mentioned recently.
- Sending an external message because the user said "yeah send it" after more
  than one monitor status was visible.
- Hard-coding exact phrases like "send it" as the only valid wording.

## Natural Language

Buttons can be shortcuts, but natural language is the real interface. Interpret
the user's intent with the model, then let tool safety enforce the boundary.

Examples that should route through this skill:

- "what's the status with Chloe?"
- "ask her if today works"
- "change it to ask about Wi-Fi first"
- "stop watching that one"
- "show all active apartment monitors"

## Status Note Style

Write monitor updates like the assistant talking, not like a cron banner.

Good:

> Chloe replied. She says 25 days may work at RM2,800 all-in. Want me to ask
> for a same-day viewing and confirm deposit/Wi-Fi?

Avoid:

> [Monitor update: Chloe] Status=reply received. Suggested next step=...
