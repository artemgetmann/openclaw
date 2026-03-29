---
summary: "Guidance for choosing between heartbeat and cron jobs for automation"
read_when:
  - Deciding how to schedule recurring tasks
  - Setting up background monitoring or notifications
  - Optimizing token usage for periodic checks
title: "Cron vs Heartbeat"
---

# Cron vs Heartbeat: When to Use Each

Both heartbeats and cron jobs let you run tasks on a schedule. This guide helps you choose the right mechanism for your use case.

## Quick Decision Guide

| Use Case                                               | Recommended         | Why                                              |
| ------------------------------------------------------ | ------------------- | ------------------------------------------------ |
| Check inbox every 30 min                               | Heartbeat           | Broad sweep; batches with other checks           |
| Monitor calendar for upcoming events                   | Heartbeat           | Good periodic awareness case                     |
| Background project health check                        | Heartbeat           | Fits heartbeat-style broad status sweeps         |
| Watch this inbox/thread/person until something happens | Cron                | Explicit scoped monitor; needs a stop rule       |
| Send daily report at 9am sharp                         | Cron (isolated)     | Exact timing needed                              |
| Remind me in 20 minutes                                | Cron (main, `--at`) | One-shot with precise timing                     |
| Run weekly deep analysis                               | Cron (isolated)     | Standalone task, can use different model         |
| Keep a general eye on my world and surface big changes | Heartbeat           | Broad ambient awareness, low-frequency is enough |
| Do one daily broad sweep and only alert if it matters  | Heartbeat           | Conservative periodic awareness                  |

## Heartbeat: Ambient Awareness

Heartbeats run in the **main session** at a regular interval (default: 30 min). They are for broad periodic sweeps and ambient awareness that surface what looks important without turning every request into a dedicated forever-monitor.

### When to use heartbeat

- **Broad awareness**: “Keep a general eye on my world and only surface something important.”
- **Multiple periodic checks**: Inbox, calendar, notifications, and project status can be batched into one heartbeat when the user wants a broad sweep instead of a scoped watch.
- **Low-frequency sweeps**: A daily cadence is the safest default starting point, but 30-minute heartbeat sweeps are still valid when the user explicitly wants that tradeoff.
- **Small stable checklist**: `HEARTBEAT.md` should stay tiny, durable, and approval-oriented.
- **Context-aware judgment**: The agent can use main-session context to decide whether something is worth surfacing.
- **Conversational continuity**: Heartbeat runs share the same main-session context, so they can make follow-up judgments without needing isolated monitor jobs for everything.

### When not to use heartbeat

- **Explicit monitors**: “Watch this inbox/thread/person until something happens” should default to cron.
- **Exact schedules**: “Run at 9:00 AM sharp” is cron.
- **Forever-jobs by accident**: if the work needs a cadence, stop condition, or expiry/TTL, model it as cron instead of stuffing it into `HEARTBEAT.md`.

### Heartbeat advantages

- **Broad context**: The agent sees the main session and can judge importance.
- **Low overhead**: A conservative heartbeat is cheaper than a pile of isolated jobs.
- **Batches multiple checks**: One agent turn can review inbox, calendar, notifications, and project status together.
- **Context-aware**: The agent knows what you've been working on and can prioritize accordingly.
- **Smart suppression**: If nothing needs attention, the agent replies `HEARTBEAT_OK` and no message is delivered.
- **Approval-oriented**: Good heartbeat behavior escalates first instead of quietly creating deeper recurring work.

### Heartbeat example: safe `HEARTBEAT.md`

```md
# Heartbeat checklist

- Once each morning, do one broad sweep of my world and only alert me if something materially important stands out.
- If a deeper recurring monitor would help, suggest one cron job with a cadence, stop condition, and expiry first. Otherwise reply HEARTBEAT_OK.
```

The agent reads this on each heartbeat. Keep it broad and low-burn.

Other valid heartbeat items, when the user wants them:

- Check email for urgent messages.
- Review calendar for events in the next 2 hours.
- If a background task finished, summarize results.
- If idle for 8+ hours, send a brief check-in.

### Configuring heartbeat

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // interval
        target: "last", // explicit alert delivery target (default is "none")
        activeHours: { start: "08:00", end: "22:00" }, // optional
      },
    },
  },
}
```

See [Heartbeat](/gateway/heartbeat) for full configuration.

## Cron: Reminders, Precise Schedules, and Explicit Monitors

Cron jobs run at precise times and can run in isolated sessions without affecting main context.
Recurring top-of-hour schedules are automatically spread by a deterministic
per-job offset in a 0-5 minute window.

### When to use cron

- **Explicit scoped monitors**: “Watch this inbox/thread/person until something happens.”
- **Exact timing required**: "Send this at 9:00 AM every Monday" (not "sometime around 9").
- **Standalone tasks**: Tasks that don't need conversational context.
- **Different model/thinking**: Heavy analysis that warrants a more powerful model.
- **One-shot reminders**: "Remind me in 20 minutes" with `--at`.
- **Noisy/frequent tasks**: Tasks that would clutter main session history.
- **External triggers**: Tasks that should run independently of whether the agent is otherwise active.
- **Bounded recurring checks**: When you can define cadence + stop condition + expiry/TTL instead of a forever-job.

### Cron advantages

- **Precise timing**: 5-field or 6-field (seconds) cron expressions with timezone support.
- **Built-in load spreading**: recurring top-of-hour schedules are staggered by up to 5 minutes by default.
- **Per-job control**: override stagger with `--stagger <duration>` or force exact timing with `--exact`.
- **Session isolation**: Runs in `cron:<jobId>` without polluting main history.
- **Model overrides**: Use a cheaper or more powerful model per job.
- **Delivery control**: Isolated jobs default to `announce` (summary); choose `none` as needed.
- **Immediate delivery**: Announce mode posts directly without waiting for heartbeat.
- **No agent context needed**: Runs even if main session is idle or compacted.
- **One-shot support**: `--at` for precise future timestamps.
- **Scoped monitor contract**: Better fit for “check every N until X happens, then stop.”

### Cron example: Daily morning briefing

```bash
openclaw cron add \
  --name "Morning briefing" \
  --cron "0 7 * * *" \
  --tz "America/New_York" \
  --session isolated \
  --message "Generate today's briefing: weather, calendar, top emails, news summary." \
  --model opus \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

This runs at exactly 7:00 AM New York time, uses Opus for quality, and announces a summary directly to WhatsApp.

### Cron example: Explicit monitor

```bash
openclaw cron add \
  --name "Recruiter reply watch" \
  --every "2h" \
  --session isolated \
  --message "Check the recruiter thread. Only alert me if there is a new reply from Dana. Treat this as a temporary monitor, ask to keep it running if nothing happens after 3 days, and stop once a reply arrives." \
  --announce
```

This is a cron case because it is an explicit scoped monitor with a cadence and stop rule.

### Cron example: One-shot reminder

```bash
openclaw cron add \
  --name "Meeting reminder" \
  --at "20m" \
  --session main \
  --system-event "Reminder: standup meeting starts in 10 minutes." \
  --wake now \
  --delete-after-run
```

See [Cron jobs](/automation/cron-jobs) for full CLI reference.

## Decision Flowchart

```
Does the task need to run at an EXACT time?
  YES -> Use cron
  NO  -> Continue...

Is this a reminder, exact scheduled task, or explicit monitor on a specific inbox/thread/person/condition?
  YES -> Use cron
  NO  -> Continue...

Is the goal broad ambient awareness rather than a scoped monitor?
  YES -> Continue...
  NO  -> Use cron

Would a conservative low-frequency sweep be enough?
  YES -> Use heartbeat (add a tiny stable item to HEARTBEAT.md)
  NO  -> Use cron

Is this a one-shot reminder?
  YES -> Use cron with --at
  NO  -> Keep the heartbeat broad and approval-oriented
```

## Combining Both

The most efficient setup uses **both**:

1. **Heartbeat** handles broad ambient awareness on a conservative cadence.
2. **Cron** handles reminders, precise schedules, and explicit monitors with clear boundaries.

### Example: Efficient automation setup

**HEARTBEAT.md** (checked on a conservative cadence):

```md
# Heartbeat checklist

- Once each morning, do one broad sweep of my world and only alert me if something materially important stands out.
- If a deeper recurring monitor would help, suggest one cron job with a cadence, stop condition, and expiry first. Otherwise reply HEARTBEAT_OK.
```

**Cron jobs** (precise timing):

```bash
# Daily morning briefing at 7am
openclaw cron add --name "Morning brief" --cron "0 7 * * *" --session isolated --message "..." --announce

# Weekly project review on Mondays at 9am
openclaw cron add --name "Weekly review" --cron "0 9 * * 1" --session isolated --message "..." --model opus

# One-shot reminder
openclaw cron add --name "Call back" --at "2h" --session main --system-event "Call back the client" --wake now
```

## Lobster: Deterministic workflows with approvals

Lobster is the workflow runtime for **multi-step tool pipelines** that need deterministic execution and explicit approvals.
Use it when the task is more than a single agent turn, and you want a resumable workflow with human checkpoints.

### When Lobster fits

- **Multi-step automation**: You need a fixed pipeline of tool calls, not a one-off prompt.
- **Approval gates**: Side effects should pause until you approve, then resume.
- **Resumable runs**: Continue a paused workflow without re-running earlier steps.

### How it pairs with heartbeat and cron

- **Heartbeat/cron** decide _when_ a run happens.
- **Lobster** defines _what steps_ happen once the run starts.

For scheduled workflows, use cron or heartbeat to trigger an agent turn that calls Lobster.
For ad-hoc workflows, call Lobster directly.

### Operational notes (from the code)

- Lobster runs as a **local subprocess** (`lobster` CLI) in tool mode and returns a **JSON envelope**.
- If the tool returns `needs_approval`, you resume with a `resumeToken` and `approve` flag.
- The tool is an **optional plugin**; enable it additively via `tools.alsoAllow: ["lobster"]` (recommended).
- Lobster expects the `lobster` CLI to be available on `PATH`.

See [Lobster](/tools/lobster) for full usage and examples.

## Main Session vs Isolated Session

Both heartbeat and cron can interact with the main session, but differently:

|         | Heartbeat                       | Cron (main)              | Cron (isolated)                                 |
| ------- | ------------------------------- | ------------------------ | ----------------------------------------------- |
| Session | Main                            | Main (via system event)  | `cron:<jobId>` or custom session                |
| History | Shared                          | Shared                   | Fresh each run (isolated) / Persistent (custom) |
| Context | Full                            | Full                     | None (isolated) / Cumulative (custom)           |
| Model   | Main session model              | Main session model       | Can override                                    |
| Output  | Delivered if not `HEARTBEAT_OK` | Heartbeat prompt + event | Announce summary (default)                      |

Thread/topic routing note:
Heartbeat deliveries use the configured session plus `target`/`to` routing. Cron can also stay thread/topic-bound when you create it from a thread-aware session and bind delivery/session correctly, including Telegram `:topic:` targets where supported.

### When to use main session cron

Use `--session main` with `--system-event` when you want:

- The reminder/event to appear in main session context
- The agent to handle it during the next heartbeat with full context
- No separate isolated run
- Routing that stays anchored to the current chat or topic/thread context instead of drifting into the wrong conversation

```bash
openclaw cron add \
  --name "Check project" \
  --every "4h" \
  --session main \
  --system-event "Time for a project health check" \
  --wake now
```

### When to use isolated cron

Use `--session isolated` when you want:

- A clean slate without prior context
- Different model or thinking settings
- Announce summaries directly to a channel
- History that doesn't clutter main session

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 0" \
  --session isolated \
  --message "Weekly codebase analysis..." \
  --model opus \
  --thinking high \
  --announce
```

## Cost Considerations

| Mechanism       | Cost Profile                                            |
| --------------- | ------------------------------------------------------- |
| Heartbeat       | One turn every N minutes; scales with HEARTBEAT.md size |
| Cron (main)     | Adds event to next heartbeat (no isolated turn)         |
| Cron (isolated) | Full agent turn per job; can use cheaper model          |

**Tips**:

- Keep `HEARTBEAT.md` small to minimize token overhead.
- Use heartbeat for broad ambient awareness, not as a bucket for every recurring monitor idea.
- Use cron when the job needs a cadence, stop condition, or expiry/TTL.
- 30-minute heartbeats are valid if the user explicitly wants that cadence; daily is just the safer default example.
- Use `target: "none"` on heartbeat if you only want internal processing.
- Use isolated cron with a cheaper model for routine tasks.

## Related

- [Heartbeat](/gateway/heartbeat) - full heartbeat configuration
- [Cron jobs](/automation/cron-jobs) - full cron CLI and API reference
- [System](/cli/system) - system events + heartbeat controls
