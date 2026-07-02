---
name: telegram-chat-management
description: Use for Telegram chats/topics/threads, forum topic creation, handoff prompts, send as me, and Telegram-as-me routing when the user wants an instruction posted into a Telegram chat/topic/thread rather than a status update sent back to them.
metadata: { "openclaw": { "emoji": "🧵", "displayName": "Telegram Chat Management" } }
---

# Telegram Chat Management

Use this when the user wants Jarvis to create, continue, or seed a Telegram
chat/topic/thread so another bot or agent can act there.

## Core Rule

Separate these two jobs:

1. Bot/status update to the user: reply normally in chat, or use the normal
   Telegram bot channel when the user only needs a progress report.
2. User-style handoff into a Telegram chat/topic/thread: use `telegram-user`
   and send through Telegram-as-me so the instruction appears from the user's
   real Telegram account.

If the user says "message me through Telegram," report to the user. If they say
"send this as me," "put this in that topic," "handoff to the thread," "tell the
bot there," or "start a topic for this," use Telegram-as-me.

## When To Use

Use this skill for:

- creating a Telegram forum topic for a workstream;
- posting a plan or prompt into an existing Telegram topic/thread;
- handing work to a bot or agent that watches a Telegram topic;
- fixing a topic that was created but not seeded with the executable prompt;
- mirroring a local handoff file into Telegram for another runtime to continue.

Do not use this skill for:

- ordinary status updates to the user;
- BotFather setup or bot-token onboarding;
- broad Telegram inbox triage;
- sending external DMs or public posts without explicit approval.

## Handoff Shape

A useful handoff says:

- what the receiving bot/agent should do now;
- source-of-truth file paths, if any;
- what already happened;
- exact expected output;
- constraints on sends, public posts, purchases, writes, or external actions;
- whether to summarize, continue, or execute.

Keep internal run ids, token counts, and system metadata out of Telegram.

## Workflow

1. Identify the target chat and topic.
   - Existing topic: get the chat id and topic anchor.
   - New topic: get the chat id and a short topic title.
2. For non-trivial handoffs, save the plan in the relevant project directory
   first, then reference the path in the Telegram message.
3. If creating a topic, use Telegram-as-me:

```bash
openclaw telegram-user topic-create --chat -1003783709877 --title "launch follow-up" --json
```

4. Send the handoff into the topic as the user:

```bash
openclaw telegram-user send --chat -1003783709877 --topic-anchor 12345 --message "Jarvis, continue this workstream from docs/plans/launch-follow-up.md. Reply in this topic with the next 3 actions. Do not post publicly or DM anyone without approval." --json
```

5. Report proof back in the original conversation:
   - chat/topic title;
   - topic anchor;
   - Telegram-as-me message id;
   - what was included;
   - any limitation or fallback.

## Safety Checks

- Read `telegram-user` before sending as the user's real account.
- Use the installed CLI first: `openclaw telegram-user ...`.
- Confirm the target chat/topic before write actions when the user did not name
  it exactly.
- Do not replace a user-style handoff with a bot summary. That creates the
  topic but fails to trigger the bot/agent in the user's voice.
- Do not claim a topic-bound agent exists unless the runtime/tool actually
  bound one. If binding is unavailable, say so and use a Telegram-as-me handoff.

## Message Template

```text
Jarvis, continue <workstream> from here.

Source of truth:
<path>

What already happened:
- <facts>

Please reply in this topic with:
1. <requested output>
2. <requested output>
3. <requested output>

Constraints:
- Do not post publicly or DM anyone without approval.
- Do not take external actions unless explicitly approved.
- Keep the response actionable.
```
