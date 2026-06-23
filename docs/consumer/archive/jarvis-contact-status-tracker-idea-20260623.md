# Jarvis Contact / Workstream Status Tracker Idea

Status: archived idea / not urgent.
Date: 2026-06-23.
Owner: Artem.

## Problem

Jarvis often gets asked things like:

- “What is the status with this person?”
- “Did they reply?”
- “What were we supposed to send next?”
- “Check WhatsApp/Telegram/email and tell me who needs attention.”

The current simplest implementation is to fetch the latest conversation context directly from WhatsApp, Telegram, email, or another source each time. That works, but it can be slow, repetitive, and fragile for long-running outreach or multi-step conversations.

## Idea

Maintain compact per-contact or per-workstream status trackers that Jarvis can consult before fetching fresh source context.

This should not duplicate full chat history. It should store a small checkpoint.

Example:

```md
# Contact status: Eva

Last checked: 2026-06-23
Channels: Telegram
Latest known state: setup call postponed; interested but not yet proven high-signal
Latest important inbound: asked/scheduled call around Monday
Pending next action: ask what she would actually delegate before installing Jarvis
Fresh sync needed: yes
```

## Desired behavior

When user asks for context but not necessarily fresh messages:

> “In my tracker, the latest known status with Eva is X from DATE. Do you want me to fetch fresh Telegram/WhatsApp messages?”

When user clearly asks for new replies:

- fetch fresh messages from the source,
- summarize what changed,
- update the tracker,
- propose next action/reply.

When running proactive checks:

- use trackers as lightweight state/checkpoints,
- only alert user when there is meaningful new signal,
- update pending next action.

## Scope

Potential surfaces:

- WhatsApp
- Telegram
- email / IMAP / Gmail
- Instagram DMs later if supported
- outreach/workstream trackers
- long-running goals / conversation-driving tasks

## Design constraints

- Do not store full transcripts unless explicitly needed.
- Store compact state: last checked, latest known state, pending next action, source ids/refs, freshness.
- Track by contact/thread/workstream, not just app.
- Auto-compact if tracker grows.
- Fetch fresh source data when user asks for new replies or when stale.
- Keep raw evidence behind source ids/paths where possible.
- Avoid creating a second unreliable chat database.

## Why it may matter

This could help Jarvis act more like a real assistant:

- remembering conversation status,
- driving follow-ups,
- knowing what is pending,
- not losing context after compaction,
- reducing repeated slow fetches,
- supporting cross-channel inbox triage.

## Risks

- May be a small UX improvement, not a moat.
- Tracker maintenance can become complex.
- Per-person files can grow or go stale.
- Agent may trust tracker when fresh source data is needed.
- Could duplicate data already available in messaging/email tools.

## Strategic framing

This is product value only if it helps Jarvis reliably manage real workflows:

> “What is going on with my people/tasks, who needs attention, and what should we do next?”

It is not valuable if it becomes a giant shadow copy of chats.

## Implementation direction if tested later

Ask an agent to design a small PR rather than manually over-spec everything.

Prompt sketch:

> Design and implement a lightweight contact/workstream status tracker for Jarvis. It should store compact per-contact/thread checkpoints for WhatsApp/Telegram/email, update after message reads/monitors, and let the assistant answer status questions before optionally fetching fresh source messages. Avoid full transcript duplication. Include compaction/staleness rules, evidence refs, and tests.

Review the PR for whether it matches the philosophy:

- agent-driven setup,
- local-first state,
- minimal user configuration,
- no duplicate chat database,
- safe freshness checks before acting.
