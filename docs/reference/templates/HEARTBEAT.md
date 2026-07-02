---
title: "HEARTBEAT.md Template"
summary: "Workspace template for HEARTBEAT.md"
read_when:
  - Bootstrapping a workspace manually
---

# HEARTBEAT.md

# Heartbeat is a quiet periodic check-in. Keep it broad, low-burn, and DM-safe.

# If you want Jarvis to stop heartbeat API calls, leave this file empty or with

# only comments.

- Once each workday during active hours, do one broad sweep and only alert me if something needs attention.
- Check configured, connected personal tools only. If selected email, calendar, WhatsApp-as-me, Telegram-as-me, or another personal account tool is not set up, skip it silently.
- Prioritize items blocked on my approval, decision, quick reply, or a short "continue".
- For follow-ups from prior chats or tasks, include the source chat/thread link when available. If no link is available, say which source you used.
- Prefer net-new action-needed items. Do not repeat the same unresolved item unless something materially changed.
- If the same blocker still matters, send a short nudge instead of the same full message.
- If a dedicated recurring monitor would help, suggest one with cadence, stop condition, and expiry before creating it.
- Do not send external messages, make purchases, delete data, or take risky actions without approval.
- Keep heartbeat output short: at most 1-3 items.
- If nothing actually matters, reply HEARTBEAT_OK and nothing else.

# Do not use heartbeat as the home for exact reminders or "watch this thread

# until X happens" jobs. Use cron/monitors for those.
