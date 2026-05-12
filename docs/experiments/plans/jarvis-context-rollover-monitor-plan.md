# Jarvis Context Rollover and Monitor Continuity Plan

Status: active implementation plan
Owner: Jarvis/OpenClaw runtime
Created: 2026-05-11
Last updated: 2026-05-12

## Problem

Long Telegram topics can become too large for reliable agent work. In the May
2026 Jarvis incident, the old Telegram topic kept receiving tool-heavy work,
watchdog pings, WhatsApp monitor updates, and repeated retries until the model
hit `context_length_exceeded`.

The user-facing failure was simple: Jarvis felt slow, stuck, and confused.

The design goal is also simple: users should not have to manage context windows.
Jarvis should preserve continuity while keeping active working context small.

## Current Evidence

- OpenClaw already resolves context windows per model, not by one global token
  limit.
- Current compaction default reserve floor in code is `20000` tokens, but the
  live Jarvis config had `reserveTokensFloor: 4000`.
- Session pruning trims old tool results in memory for selected providers.
- Tool-result truncation exists as overflow recovery.
- PR #670 added durable monitor sessions and human-style monitor status
  guidance.
- PR #677 exposed monitor state to Telegram-capable agents and injected compact
  active-monitor awareness into same-session Telegram turns. It merged at
  2026-05-12 16:54 Malaysia time.
- PR #679 added model-aware context pressure warnings to status surfaces. It
  merged on 2026-05-12.
- PR #681 adds the first normal-chat checkpoint nudge when a session crosses
  roughly 75% of the resolved context window. It is open for review.
- After the latest pull, monitors have their own durable `monitorSessionKey`.
- Monitor wakes now run against that monitor session with
  `sessionDefaultResetMode: "manual"`, so monitor state can persist across
  wakes.
- The active packaged-app/shared gateway config is
  `~/Library/Application Support/OpenClaw/.openclaw/openclaw.json`, not the
  legacy CLI default `~/.openclaw/openclaw.json`.
- Monitor status notes should read like a human assistant talking to the user,
  not like a cron log.

## Progress

Done:

- Monitor wakes now use their own durable monitor sessions instead of resetting
  on each wake.
- Telegram-capable agents can see compact active-monitor awareness and use the
  `monitor` tool.
- The monitor-router skill owns natural-language routing guidance, so the global
  system prompt stays small.
- Isolated Telegram tester proof covered baseline delivery and the monitor
  status/route prompt path. The shared main Jarvis runtime still needs an
  explicit build/restart before this code is live there.
- The bad `reserveTokensFloor: 4000` override was fixed to `20000` in both the
  legacy CLI config and the app-owned Application Support config.
- Status surfaces now warn at roughly 75% of the resolved model context window.
- PR #681 is open with a one-time normal-chat context-pressure nudge. It does
  not switch sessions automatically.

Not done:

- Merge and deploy PR #681 if review passes.
- There is no automatic fresh-session rollover yet.
- Monitor creation is not deduplicated yet.
- Oversized raw tool outputs are not yet moved into structured artifacts with
  compact evidence pointers.
- The `~/.openclaw/openclaw.json` legacy/default CLI config path is still in
  use by docs and some non-app flows; do not delete it until that split is
  documented or migrated.
- Reply-message metadata, where Telegram replies directly to a monitor update
  carry the exact `monitorId`, is intentionally deferred until current behavior
  proves insufficient.

## Non-Goals

- Do not build a perfect long-term memory architecture now.
- Do not make users manually copy/paste summaries as the main consumer flow.
- Do not hide raw debugging evidence permanently.
- Do not force every monitor update to carry the entire origin conversation.

## Design Principles

1. Model-aware, not fixed-size.
   - Use percentage of the current model context window.
   - File size is only a secondary warning signal.

2. Consumer UX first.
   - Telegram and app users should see natural language continuity.
   - Slash commands can exist for power users and emergency recovery.

3. Separate thinking from notification.
   - A monitor should keep its durable focused state in its own monitor session.
   - The original chat can still receive concise status updates.

4. Main chat must be able to ask about monitors.
   - Monitor state cannot be hidden in a private silo.
   - The main chat needs a cheap lookup path: "what is the status of Chloe?"

5. Raw evidence stays available.
   - Active prompt gets compact facts.
   - Raw tool output/logs go to artifacts or session transcript references.

## Proposed Product Model

There are three layers:

1. Main conversation
   - Human-facing chat/topic.
   - Good for planning, questions, and general coordination.

2. Monitor session
   - Focused durable task state.
   - Example: "Watch Chloe / Arte Mont Kiara replies."
   - Stores task, last seen message, last action, open question, and evidence
     references.

3. Monitor registry/state
   - Machine-readable summary of all active monitors.
   - Lets any chat ask "what's the Chloe status?" without loading the monitor's
     full transcript.

The key product rule:

> Monitor work happens in the monitor session, but monitor status is readable
> from the main chat.

## Natural Language UX

Avoid making buttons the primary flow.

Good:

> Chloe replied. She says 25 days is possible at RM2,800 all-in. I drafted a
> reply asking for viewing today. Say "send it", "change it to ...", or "stop
> watching Chloe".

Power-user buttons may exist as shortcuts, but the natural-language path should
work first:

- "send it"
- "change the reply to ..."
- "stop this monitor"
- "what's the status with Chloe?"
- "show me all active apartment monitors"

The intent should come from natural language, with deterministic tool safety
behind it. Buttons are shortcuts, not the control surface.

## Main Chat Status Lookup

When the user asks the main chat about a monitored item, Jarvis should:

1. Detect that the question is about an active monitor or watched contact.
2. Read the monitor registry/state.
3. If registry state is enough, answer directly.
4. If more detail is needed, read the monitor session or raw evidence pointer.

This avoids the brittle behavior where only the monitor session knows the truth.

Current behavior after PR #677: the main Telegram topic gets compact monitor
awareness and can use the `monitor` tool to inspect state. That is the 80/20
path.

Deferred safety rail: plain Telegram replies still do not carry exact
`message_id -> monitorId -> monitorSessionKey` metadata. If testing shows
natural-language routing is too ambiguous, add that bridge later instead of
front-loading it now.

## Monitor Router Module

Keep the routing behavior modular:

- Always-on system prompt: only a small pointer to the monitor routing rule.
- Bundled skill: `skills/monitor-router/SKILL.md` owns the natural-language
  workflow, ambiguity handling, and status-note style.
- Monitor tool: exposes `list`, `get`, `update`, `stop`, and `create` so the
  model can inspect compact state before acting.

The core rule is intentionally simple: a natural-language reply can route to a
monitor only when exactly one monitor is clear from the message, nearby status
note, contact, source, or singular active candidate. If two monitors could
match, Jarvis asks a short clarification instead of guessing.

This avoids bloating the global system prompt while still making the behavior
available anywhere monitors are used.

## Rollover UX

When a topic is getting heavy, Jarvis should not say "type /new and paste this"
as the consumer path.

Preferred UX:

> This conversation is getting heavy, so I made a clean continuation point. I'll
> continue from there.

Then Jarvis creates or selects a fresh session and injects the compact handoff.

Power-user fallback:

- `/checkpoint`
- `/compact`
- `/new`

## Context Thresholds

Use model-aware triggers:

- Warning/checkpoint at roughly 70-80% of resolved model context window.
- Earlier trigger when there are repeated watchdog pings.
- Earlier trigger after provider `context_length_exceeded`.
- Earlier trigger when tool-result payloads dominate the session.
- File size threshold can be secondary telemetry only.

## Tool Output Policy

Active prompt:

- concise facts
- decisions
- latest status
- ids/paths to raw evidence

Artifacts/logs:

- raw wacli JSON
- browser snapshots
- long command outputs
- screenshots or media metadata

The agent should be able to fetch raw evidence when debugging.

## Monitor Deduplication

Create an idempotency key from:

- agentId
- sourceType
- normalized watched target/contact/thread
- actionPolicy
- optional purpose label

If an active matching monitor exists, update it instead of creating another cron
job. Allow explicit advanced override for separate monitors.

## Open Questions

1. Should `~/.openclaw/openclaw.json` stay as a supported CLI/dev default, or
   should docs/code migrate harder toward Application Support for app-owned
   runtimes?
2. Should monitor status continue through `lastCheckpoint`, a separate registry
   field, or both?
3. How often does current natural-language monitor routing become ambiguous in
   real Telegram use?
4. What visual/natural-language treatment should Telegram use for rollover
   messages?
5. Should the macOS app show a "Continue Fresh" action, or should rollover be
   completely automatic?

## 80/20 Implementation Order

1. Restore sane Jarvis compaction reserve floor. Done on 2026-05-12 for both
   `~/.openclaw/openclaw.json` and
   `~/Library/Application Support/OpenClaw/.openclaw/openclaw.json`.
2. Add monitor status lookup from main chat. Done in PR #677 for the 80/20
   Telegram path; deeper reply-message metadata is deferred.
3. Improve monitor checkpoint fields so each wake has compact durable state.
   Partially done through durable `lastCheckpoint` plumbing; richer structured
   evidence fields remain.
4. Add model-aware rollover warning/checkpoint. Status warning done in PR #679;
   normal-chat nudge is open in PR #681.
5. Deduplicate monitor creation.
6. Move oversized raw tool output out of active prompt while keeping evidence
   fetchable.
7. Add consumer-friendly automatic rollover UX after #681 has been reviewed in
   real chat.

## Validation Gates

- A main Telegram topic can ask "what's the status with Chloe?" and Jarvis
  answers from monitor state without loading the giant old topic.
- A monitor wake uses the monitor session, not the origin topic session.
- A monitor update delivered to Telegram remains concise.
- A monitor status note reads like an assistant, not a cron banner.
- A natural-language reply like "send it" works without requiring buttons.
- Duplicate monitor creation returns or updates the existing monitor.
- Raw evidence remains inspectable for debugging.
- Context rollover creates a usable continuation without manual paste.
