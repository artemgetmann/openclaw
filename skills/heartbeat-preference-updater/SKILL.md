---
name: heartbeat-preference-updater
description: Use when the user naturally changes heartbeat timing or notification preferences, for example "don't nudge me before 11", "don't nudge me on weekends", "urgent only on weekends", or "check every two hours". Confirm before writing agents.defaults.heartbeat via gateway config.patch, never memory or HEARTBEAT.md.
metadata: { "openclaw": { "always": true, "skillKey": "heartbeat-preference-updater" } }
user-invocable: false
---

# Heartbeat Preference Updater

Use this skill when the user asks, directly or indirectly, to change when ambient heartbeat
checks run or which weekend attention they may surface.

## Typed Preferences

Write only the requested fields under `agents.defaults.heartbeat`:

- `every`: ambient check cadence, such as `"1h"` or `"2h"`.
- `activeHours.start`: earliest local check time in `HH:MM` 24-hour format.
- `activeHours.end`: exclusive latest local check time.
- `activeHours.timezone`: normally `"user"` so the window follows the configured user timezone.
- `weekendMode`:
  - `"normal"` for ordinary weekend attention.
  - `"urgent-only"` to check on weekends but surface only urgent/time-sensitive items.
  - `"off"` for no ambient weekend checks.

Do not store these preferences in memory or `HEARTBEAT.md`. Config is the durable source of truth.
Do not change `lightContext` or `isolatedSession` unless the user explicitly asks about heartbeat
cost or context behavior.

## Flow

1. Translate the request into the smallest typed patch.
2. Use `config.schema.lookup` for `agents.defaults.heartbeat`, then `config.get` to preserve
   unspecified active-hours fields.
3. Tell the user the exact plain-language result, including that urgent event-driven reminders
   can still arrive outside ambient cadence and that applying the preference restarts Jarvis.
4. Record the live-chat restart confirmation with `restart.request_confirmation`, ask the
   returned confirmation question, end the turn, and wait for the next user reply.
5. Only after a later user turn clearly confirms, call `config.patch` with the partial patch and
   a short completion note.

Example for "don't nudge me before 11 or on weekends":

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        activeHours: { start: "11:00", end: "20:00", timezone: "user" },
        weekendMode: "off",
      },
    },
  },
}
```

Never imply that heartbeat can discover urgent events instantly without an event source. Calendar,
monitor, webhook, notification, and exact cron events can wake immediately; ordinary ambient
discovery waits until the next allowed heartbeat sweep.
