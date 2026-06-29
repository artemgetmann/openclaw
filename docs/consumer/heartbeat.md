---
title: "Jarvis Heartbeat"
summary: "Consumer heartbeat defaults, setup boundaries, and follow-up rules"
---

# Jarvis Heartbeat

Heartbeat is Jarvis's quiet periodic check-in. It is for broad awareness, not a
hidden task queue.

The default consumer behavior should be simple:

- Run during active hours.
- Deliver to the user's Telegram DM, not a group or topic.
- Say nothing unless something likely needs attention.
- Send at most 1-3 short items.
- Reply `HEARTBEAT_OK` when nothing matters.

## Workspace Template

Consumer workspaces get a `HEARTBEAT.md` template when bootstrap can do that
safely. Jarvis should not overwrite an existing file.

An empty or comment-only `HEARTBEAT.md` is an intentional opt-out: it disables
heartbeat model calls for that workspace.

Users can customize `HEARTBEAT.md` when they want a different sweep. Keep the
instructions broad. Exact reminders, "watch this thread until X happens" jobs,
and long-running checks belong in cron or monitors with cadence, expiry, and a
stop condition.

## Telegram Pairing Defaults

After consumer Telegram DM pairing, Jarvis can fill missing heartbeat delivery
settings:

- `agents.defaults.heartbeat.every = "1d"`
- `agents.defaults.heartbeat.target = "telegram"`
- `agents.defaults.heartbeat.to = <paired DM recipient>`
- `agents.defaults.heartbeat.accountId = "default"`
- active hours: `09:00` to `20:00` in the user's timezone

This setup must preserve explicit custom routing. If the user already routed
heartbeat to a group, topic, other channel, or custom account, Telegram setup
must not silently replace it.

## Personal Tools

Personal communication tools are high-risk because they are noisy, private, and
token-expensive.

Default heartbeat can scan connected low-risk context such as calendar and
workspace/session follow-up. Email, WhatsApp-as-me, Telegram-as-me, and similar
personal accounts should be treated as selected tools, not silently assumed.

When WhatsApp-as-me or Telegram-as-me is enabled, heartbeat may read them for
action-needed items. It must not send messages, mark risky state, delete data,
or speak as the user without approval.

## Follow-Up Context

Heartbeat reminders are only useful if the user can recover the source context.

For abandoned tasks or prior-chat blockers, Jarvis should include a source link
when available, for example a Telegram topic link or thread reference. If a
source link is not available, Jarvis should say which source it used and keep the
summary short.

Do not continue a task inside the heartbeat DM when the real work belongs in an
existing Telegram topic. The safer behavior is:

- DM the user only for lightweight attention and approval.
- Link to the source topic when possible.
- If continuing requires a message in the original topic, ask before posting
  there as the user or creating a new topic.

This keeps heartbeat useful without turning the DM into a messy parallel task
thread.
