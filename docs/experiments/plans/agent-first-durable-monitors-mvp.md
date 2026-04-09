# Agent-First Durable Monitors MVP

## Summary

Replace the current stateless "wake a helper/check script" monitor pattern with a generic agent-first monitor system.

Core behavior:

- the user creates a monitor in normal conversation
- OpenClaw creates a durable monitor session tied to that task
- cron wakes that same monitor session on a schedule
- the waking agent uses normal skills/tools to check the watched source
- the agent decides whether to notify, draft, or act
- default output goes to the origin chat
- default policy is notify + draft
- polling only for MVP, no realtime push/watch requirement

This is intentionally not a WhatsApp-specific redesign. It should work the same way for WhatsApp, Gmail/email, and future sources like YouTube or anything else the agent has tools for.

## Key Changes

### 1. Add a first-class generic monitor record

Create a small monitor record owned by the monitor/cron layer, not by channel-specific code.

The record should store only generic monitor metadata:

- monitorId
- agentId
- originSessionKey
- originDelivery
- monitorSessionKey
- sourceType
  examples: whatsapp, gmail
- sourceTarget
  opaque target payload needed to check the source again
- cadence
- expiry/ttl
- stopCondition
- actionPolicy
  default notify_draft
- status
- optional lastCheckpoint
  minimal cursor/baseline only, not a full source-specific engine

Important design choice:

- the monitor tool / monitor creation path is responsible for ensuring every monitor has:
  - what is being monitored
  - where to report back
  - when to stop
  - optional last checkpoint
- that logic belongs in the generic monitor setup flow, not scattered across per-channel wrappers

### 2. Use a durable monitor session, not isolated wake scripts

Every conversational monitor gets its own persistent monitor session.

Behavior:

- that session holds the real task history and intent
- cron wakes always resume that same monitorSessionKey
- the wake payload is tiny:
  - monitor id
  - monitor metadata
  - optional checkpoint
  - current time / wake reason
- the wake is not supposed to reconstruct the task from scratch

This gives the agent the thing you actually care about:

- same assistant
- same context
- same task memory
- not a fresh mini-brain on every wake

### 3. Make the waking agent fetch fresh state itself

On wake, the agent should use its existing skills/tools to check the source directly.

Examples:

- WhatsApp:
  use wacli skill/helpers/tools as needed
- Gmail/email:
  use existing Gmail/email tools as needed
- future sources:
  same pattern

This is the main architecture rule:

- the monitor core does not contain per-source conversation logic
- the agent does the source check using normal capabilities
- source-specific helpers are optional convenience tools, not the primary architecture

### 4. Keep only tiny built-in checkpointing

MVP should support a minimal checkpoint/cursor when the source makes it cheap and useful.

Purpose:

- avoid reprocessing the same email/message forever
- make "what changed since last wake" reliable
- keep the core scalable

Examples:

- last seen email thread message id/history id
- last seen WhatsApp message id

Important constraint:

- checkpointing is generic monitor state, not a big adapter system
- the monitor core stores it
- the waking agent may update it after a successful check
- the user-facing model stays simple

### 5. Default routing and action policy

Defaults for MVP:

- output route:
  origin chat
- action policy:
  notify + draft
- watched surface auto-send:
  only when the original task explicitly authorized it

So the default loop is:

- agent checks the watched surface
- agent reasons with full monitor-session context
- if something meaningful happened, it reports back in the origin chat with the suggested next step or draft

### 6. Limit MVP to polling, not realtime triggers

For the first implementation:

- cron polling only
- no "wake instantly on inbound email/message" work
- no webhook/push-trigger redesign

That keeps the scope appropriate for demo/MVP while solving the real continuity problem.

## Implementation Changes

### Monitor core

Add a generic monitor subsystem that:

- creates monitor records
- allocates durable monitorSessionKey
- schedules/reschedules wakes through cron
- loads monitor metadata on wake
- resumes the same monitor session
- persists checkpoint/status updates

This should sit near existing cron/session infrastructure, not inside WhatsApp or Gmail code.

### Monitor creation path

Add a first-class monitor creation flow/tool so monitors are set up consistently.

It must capture and persist:

- source type
- source target
- origin route
- cadence
- stop rule
- action policy
- initial checkpoint if available

The agent should no longer need to improvise a custom cron payload for every conversational monitor.

### Wake execution path

Add a dedicated wake path for monitor jobs:

- load monitor record
- resolve monitorSessionKey
- append a monitor wake event to that session
- invoke the agent on that same session
- let the agent decide which tools/skills to call
- persist checkpoint/status after the run

This should explicitly avoid the current "isolated fresh cron run" default for conversational monitors.

### Source support in MVP

Implement two source integrations through the same generic monitor model:

- WhatsApp
- Gmail/email

For both, keep source-specific logic minimal:

- target resolution
- optional checkpoint extraction/update
- helper availability through existing skills/tools

Do not build a large typed adapter tree for MVP.

## Test Plan

### Core monitor/session tests

- creating a monitor creates a durable monitorSessionKey
- repeated wakes resume the same monitor session
- wakes do not create a fresh isolated session
- monitor metadata persists correctly across wakes
- checkpoint updates persist after successful checks
- expiry/stop conditions terminate the monitor cleanly

### Agent continuity tests

- monitor session starts with user intent like:
  monitor Empower replies and draft the next response
- later wake resumes the same session
- agent sees prior monitor discussion/history
- agent is not forced to reason only from the latest inbound item

### WhatsApp tests

- reproduce the negotiation shape:
  - 7pm?
  - assistant says 8pm works better
  - 7:30?
  - 7:45?
- verify the wake resumes the same monitor session
- verify the agent can use WhatsApp tools to inspect fresh state
- verify it does not re-send the same 8pm line as if it forgot prior context
- keep existing repeated-outbound guardrails as safety rails, not the primary fix

### Gmail/email tests

- create a monitor on a Gmail/email thread
- new reply appears
- wake resumes the same monitor session
- agent checks the thread via normal tools
- agent reports back in the origin chat with a draft
- checkpoint prevents the same reply from being re-announced repeatedly

### Routing tests

- origin chat and watched source differ
- monitor result is sent to origin chat by default
- no auto-send to watched source without explicit authorization

## Assumptions and Defaults

- MVP is polling-only
- default action policy is notify + draft
- default output route is the origin chat
- monitors use durable per-channel sessions
- source checking is agent-driven via existing tools/skills
- minimal checkpointing is stored in the generic monitor record
- no big source-specific monitor engine is required for MVP
- first supported watched sources are WhatsApp and Gmail/email
