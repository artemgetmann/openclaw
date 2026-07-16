# Monitor continuation testing

Use this runbook when changing or recovering Jarvis monitor creation, event
routing, durable continuation, completion, or origin delivery.

## Fast deterministic lane

Start with the cross-module regression:

```bash
pnpm test -- src/gateway/server-cron.test.ts
```

The draft-only WhatsApp reply regression in that file composes the real gateway
monitor handlers, durable monitor store, event router, cron queue, wake builder,
and terminal monitor update. It uses temporary state and a mocked isolated
agent/transport boundary.

It proves the mechanical continuation contract:

- an active origin goal is snapshotted onto the monitor, and that goal,
  original instructions, `notify_draft`, cadence, expiry, and a canonical
  numeric Telegram chat/topic route survive durable reload;
- a nonmatching event leaves the monitor active without enqueueing or starting
  a wake;
- an exact match enqueues the existing cron job for the correct durable monitor
  session;
- the wake retains the original task and draft requirement;
- `notify_draft` falls back to the Telegram origin topic without exposing a
  WhatsApp message-tool target;
- completion persists and disables future cron wakes.

Run adjacent gateway and prompt-contract coverage when those seams change:

```bash
pnpm test -- \
  src/gateway/server-methods/monitor.test.ts \
  src/monitor/delivery.test.ts \
  src/monitor/session.test.ts \
  src/monitor/wake.test.ts
```

Two adjacent tests deliberately own boundaries that the composed regression
does not fake:

- `src/gateway/server-methods/monitor.test.ts` covers focused goal-trigger
  binding variants, including the WhatsApp local-listener case;
- `src/monitor/delivery.test.ts` covers the execution-plan split between
  `notify_draft` origin delivery and `auto_send` watched-surface targeting;
- `src/cron/isolated-agent.direct-delivery-forum-topics.test.ts` proves that a
  canonical numeric Telegram target reaches the exact chat and thread through
  the mocked Telegram transport.

Run the direct-delivery boundary when topic parsing or channel dispatch changes:

```bash
pnpm test -- src/cron/isolated-agent.direct-delivery-forum-topics.test.ts
```

Run ingress coverage when hooks or channel listeners change:

```bash
pnpm test -- \
  src/gateway/server.hooks.test.ts \
  src/telegram-user/monitor-event.test.ts \
  src/whatsapp/monitor-event.test.ts
```

## Proof boundary

The deterministic lane does not prove:

- model judgment, source inspection quality, or draft quality;
- a real WhatsApp, Telegram-as-me, Gmail, or browser listener receiving an
  external event;
- an actual Telegram bot delivering into the intended topic;
- packaged app state, installed listener-service ownership, or survival across
  a real process or machine restart;
- provider-side deduplication or the absence of every possible external send.

The no-auto-send assertion is deliberately narrower: at the mocked execution
boundary, a `notify_draft` wake is routed to the Telegram origin and receives no
WhatsApp message-tool target. This harness has no watched-surface send mock
because channel dispatch lives beyond the mocked isolated runner. Do not report
that assertion as provider-level no-send proof.

## Packaged and live acceptance threshold

Tests are sufficient for changes confined to deterministic monitor state,
routing, prompts, and docs. Add isolated packaged or live acceptance only when
the change affects an installed listener, provider adapter, packaged runtime,
real restart recovery, model behavior, or user-visible Telegram delivery.

When live acceptance is justified:

1. Pass the deterministic lane first.
2. Use an isolated profile, config, state directory, gateway port, and test bot
   or account. Never repoint the shared Jarvis runtime at a worktree.
3. Prove nonmatch before match, then restart recovery, origin-topic delivery,
   completion, and the no-auto-send boundary.
4. Record runtime/package provenance and exact provider-visible evidence.

Keep these claims separate: merged code, local tests, restarted runtime,
healthy provider/listener, Telegram delivery, and correct model output.
