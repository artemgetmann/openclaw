---
name: cross-channel-triage
description: Use when the user asks to triage messages, emails, chats, inboxes, unread messages, recent messages, open replies, or who they owe replies to across one or more channels such as WhatsApp, Telegram, Gmail/email, Slack, Signal, iMessage, browser portals, or files. First produce a scoped prioritized triage list, then handle items one by one with user approval before any external reply/send.
metadata: { "openclaw": { "emoji": "📬", "displayName": "Cross-Channel Triage" } }
---

# Cross-Channel Triage

Use this for messy inbox or communication triage across one channel or many:
email, Telegram, WhatsApp, Signal, iMessage, Slack, browser portals, or files.
The same protocol applies to a single inbox when there are multiple threads to
prioritize.

## Core Rule

Do not draft and send everything in one batch by default.

Default flow:

1. Scope the sweep: channel(s), timeframe, unread/recent/all, and any people or
   topics the user named.
2. Shortlist first: inspect snippets, previews, sender, timestamps, unread
   state, and labels before reading full bodies or long histories.
3. Filter noise early: newsletters, receipts, calendar churn, automated alerts,
   low-signal notifications, and routine FYI items should not consume deep-read
   budget unless the user asks.
4. Deep-read only the likely actionable items, active conversations, or threads
   where a snippet is not enough to classify urgency or reply-needed state.
5. Return explicit buckets and recommended next actions.
6. Handle items one by one, starting with the highest-impact item.
7. Require approval before any external send, purchase, deletion, archive, label
   action, calendar change, or other risky action.

## Buckets

Use these buckets when they help the user scan:

- Urgent: direct asks with time pressure, blockers, deadlines, or operational
  risk if ignored.
- Needs reply soon: direct asks, active conversations, or follow-ups that will
  go stale if ignored.
- Waiting on them: the user already replied or the current blocker belongs to
  someone else.
- Schedule: the next useful action is a meeting, reminder, follow-up monitor, or
  calendar task.
- Delegate: the work should become a task for Jarvis, another agent, or a human
  rather than a simple reply.
- Archive / no action: receipts, newsletters, resolved threads, or low-value
  notifications that are safe to ignore or clean up after confirmation.
- FYI: useful context with no immediate action.

Treat "needs reply" as an inference, not a guaranteed state. Say "looks like"
or "likely" when the channel does not expose a definitive next-responder state.

## Triage Output

Keep the first pass short. Prefer the top 3-7 actionable items unless the user
asks for everything.

For each item include:

- Contact/thread
- Channel
- Latest message date/time
- Latest sender/author
- Bucket
- What they want or why it matters
- Recommended action
- Needs user input? yes/no
- Source ref/id when available

Always state:

- Scope checked: channels, timeframe, filters, and approximate result count.
- Confidence: high / medium / low, with a short reason.
- Coverage limits: what was excluded or only sampled.

End with the next concrete step:

> I recommend starting with #1. Want me to draft that one?

## Reply Loop

For each selected item:

1. Fetch enough fresh context to understand the latest ask, participants, tone,
   and whether the conversation moved forward.
2. Include the exact latest relevant inbound text when available and useful.
   Summaries are helpful, but they must not replace the sender's wording when
   wording matters.
3. Draft in the user's voice.
4. Ask: send, edit, skip, schedule, delegate, archive, or next?
5. If approval is delayed, re-check the thread before sending.
6. Update compact status: pending, drafted, sent, skipped, scheduled,
   delegated, archived, waiting, or blocked.

## Modes

Default supervised mode:

- Use for users, friends, investors, hiring, sales, conflict, negotiation,
  emotional threads, or anything reputational.
- Draft one at a time and wait.

Batch-draft mode:

- Use only if the user asks to review several drafts before action.
- Draft multiple replies, but send none until explicitly approved.

Low-risk batch-send mode:

- Use only if explicitly authorized and the messages are routine: confirmations,
  receipts, simple scheduling, or "thanks, received."
- Ask before the first batch send unless the user already authorized the batch.

## Channel Adapters

Use the most specific available channel skill/tooling:

- WhatsApp-as-me: use `wacli`.
- Telegram-as-me: use `telegram-user`.
- Gmail / Google Workspace: use `gog`.
- Generic IMAP/SMTP email: use `himalaya`.

For monitors or waiting for replies, prefer deterministic helper scripts from
the relevant channel skill. Do not make a recurring monitor vague; define the
target, cadence, stop condition, expiry, and whether it may draft only or send.

## Tracker

For more than about five actionable items, or when the user will review across
turns, keep a compact tracker in the workspace or project directory.

Track only status and refs, not private transcripts:

- item number
- contact/thread
- channel
- latest message date/time
- bucket
- status
- source ref/id
- next action

Fetch fresh source context when acting.
