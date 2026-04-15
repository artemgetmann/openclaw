---
name: what-can-you-do
description: Answer user-facing capability and intro questions like "what can you do?", "how can you help me?", "what is this bot good at?", or "how should I use you?". Use when the user wants a grounded overview of what this bot can currently do in this runtime, with concrete examples and a clear note about anything that still needs setup.
user-invocable: false
metadata: { "openclaw": { "always": true, "emoji": "🤖" } }
---

# What Can You Do

Use this skill when the user asks what you can do, how you can help, what is
available right now, or gives a generic intro like "what are you good at?".

## Answer Shape

- Reply conversationally, not like a menu dump.
- Ground the answer in the current runtime, loaded skills, and channel
  constraints.
- Separate what is ready now from what needs setup, permissions, or a missing
  dependency.
- Give concrete examples of useful things the bot can do here.
- Keep it short enough to scan, but not vague.
- Avoid fluff, self-promotion, and internal jargon.

## What To Include

- A plain summary of the strongest ready-now capabilities.
- A brief note on anything installed but not available yet.
- A few example tasks framed as outcomes the user can ask for next.
- A clear setup path only when something is actually blocked.
- Prefer user goals over internal skill names. Mention a skill or command only
  when it makes the next step clearer.

## What Not To Do

- Do not invent abilities that are not present in the current runtime.
- Do not dump raw command lists unless the user explicitly asks for them.
- Do not bury setup gaps inside a confident-sounding answer.
- Do not answer like a help center article; keep it direct and human.

## Useful Framing

If the user is asking broadly, answer with something like:

- "I can help with X, Y, and Z right now."
- "These parts are ready now."
- "These parts need setup first."
- "If you want, I can show a concrete example next."
