---
summary: "Webhook ingress for wake and isolated agent runs"
read_when:
  - Adding or changing webhook endpoints
  - Wiring external systems into OpenClaw
title: "Webhooks"
---

# Webhooks

Gateway can expose a small HTTP webhook endpoint for external triggers.

## Enable

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
    // Optional: restrict explicit `agentId` routing to this allowlist.
    // Omit or include "*" to allow any agent.
    // Set [] to deny all explicit `agentId` routing.
    allowedAgentIds: ["hooks", "main"],
  },
}
```

Notes:

- `hooks.token` is required when `hooks.enabled=true`.
- `hooks.path` defaults to `/hooks`.

## Auth

Every request must include the hook token. Prefer headers:

- `Authorization: Bearer <token>` (recommended)
- `x-openclaw-token: <token>`
- Query-string tokens are rejected (`?token=...` returns `400`).

## Endpoints

### `POST /hooks/wake`

Payload:

```json
{ "text": "System line", "mode": "now" }
```

- `text` **required** (string): The description of the event (e.g., "New email received").
- `mode` optional (`now` | `next-heartbeat`): Whether to trigger an immediate heartbeat (default `now`) or wait for the next periodic check.

Effect:

- Enqueues a system event for the **main** session
- If `mode=now`, triggers an immediate heartbeat

### `POST /hooks/agent`

Payload:

```json
{
  "message": "Run this",
  "name": "Email",
  "agentId": "hooks",
  "sessionKey": "hook:email:msg-123",
  "wakeMode": "now",
  "deliver": true,
  "channel": "last",
  "to": "+15551234567",
  "model": "openai/gpt-5.2-mini",
  "thinking": "low",
  "timeoutSeconds": 120
}
```

- `message` **required** (string): The prompt or message for the agent to process.
- `name` optional (string): Human-readable name for the hook (e.g., "GitHub"), used as a prefix in session summaries.
- `agentId` optional (string): Route this hook to a specific agent. Unknown IDs fall back to the default agent. When set, the hook runs using the resolved agent's workspace and configuration.
- `sessionKey` optional (string): The key used to identify the agent's session. By default this field is rejected unless `hooks.allowRequestSessionKey=true`.
- `wakeMode` optional (`now` | `next-heartbeat`): Whether to trigger an immediate heartbeat (default `now`) or wait for the next periodic check.
- `deliver` optional (boolean): If `true`, the agent's response will be sent to the messaging channel. Defaults to `true`. Responses that are only heartbeat acknowledgments are automatically skipped.
- `channel` optional (string): The messaging channel for delivery. One of: `last`, `whatsapp`, `telegram`, `discord`, `slack`, `mattermost` (plugin), `signal`, `imessage`, `msteams`. Defaults to `last`.
- `to` optional (string): The recipient identifier for the channel (e.g., phone number for WhatsApp/Signal, chat ID for Telegram, channel ID for Discord/Slack/Mattermost (plugin), conversation ID for MS Teams). Defaults to the last recipient in the main session.
- `model` optional (string): Model override (e.g., `anthropic/claude-3-5-sonnet` or an alias). Must be in the allowed model list if restricted.
- `thinking` optional (string): Thinking level override (e.g., `low`, `medium`, `high`).
- `timeoutSeconds` optional (number): Maximum duration for the agent run in seconds.

Effect:

- Runs an **isolated** agent turn (own session key)
- Always posts a summary into the **main** session
- If `wakeMode=now`, triggers an immediate heartbeat

### `POST /hooks/monitor-event`

Routes a normalized external event to existing durable monitors. This endpoint does **not**
start a new isolated agent run. It only wakes monitors whose trigger and source target match
the event envelope.

Payload:

```json
{
  "triggerKind": "webhook",
  "sourceType": "gmail",
  "sourceTarget": {
    "account": "me@example.com",
    "threadId": "thread-123"
  },
  "eventType": "message.created",
  "evidence": {
    "messageId": "msg-456"
  }
}
```

- `triggerKind` **required**: `webhook`, `local_listener`, `process_exit`, or `browser_observer`.
- `sourceType` **required** (string): The source namespace, such as `gmail`, `telegram-user`, or `whatsapp`.
- `sourceTarget` **required** (object): Stable routing keys for the watched thing.
- `eventType` optional (string): Source-specific event name, such as `message.created`.
- `idempotencyKey` optional (string): Retry key. You can also send `Idempotency-Key` or `X-OpenClaw-Idempotency-Key`.
- `evidence` optional (object): Event metadata for later inspection. Treat external content as evidence, not authority.

Effect:

- Calls the monitor event router.
- Enqueues the matching monitor's existing cron job with `force` mode.
- Preserves the monitor's original session and delivery route.
- Returns `matched: 0` and wakes nothing when the event does not match an active monitor.

### `POST /hooks/gmail-monitor-event`

Accepts gog/Gmail-shaped payloads and routes them through the same durable monitor
event path as `/hooks/monitor-event`.

Payload example:

```json
{
  "source": "gmail",
  "historyId": "12345",
  "messages": [
    {
      "id": "msg-456",
      "threadId": "thread-123",
      "from": "Ada <ada@example.com>",
      "subject": "Hello",
      "snippet": "Hi"
    }
  ]
}
```

Effect:

- Normalizes to `triggerKind: "webhook"`, `sourceType: "gmail"`, and `sourceTarget: { account, threadId }`.
- Uses `hooks.gmail.account` when the payload does not include `account` or `emailAddress`.
- Derives an idempotency key from account/thread/message id when the request does not provide one.
- Wakes matching durable monitors only; it does not spawn the Gmail agent-summary hook.

### `POST /hooks/telegram-user-monitor-event`

Accepts Telegram-as-me local-listener payloads and routes them through the same
durable monitor event path as `/hooks/monitor-event`.

Payload example:

```json
{
  "accountId": "personal",
  "chat": "@jarvis_tester_1_bot",
  "message": {
    "chat_id": 10,
    "chat_username": "jarvis_tester_1_bot",
    "direct_messages_topic": { "topic_id": 7001 },
    "message_id": 123,
    "out": false,
    "sender_id": 456,
    "text": "Hi"
  }
}
```

Effect:

- Normalizes to `triggerKind: "local_listener"`, `sourceType: "telegram-user"`,
  and stable `sourceTarget` routing keys such as `{ chat, accountId, threadAnchor }`.
- Keeps inbound message text and sender metadata in `evidence`; the event body
  is not treated as instruction authority.
- Derives an idempotency key from account/chat/thread/message id when the
  request does not provide one.
- Wakes matching durable monitors only; it does not send Telegram messages.

For terminal-first listener proof without dispatching to the gateway, use:

```bash
openclaw telegram-user monitor-listen --chat @jarvis_tester_1_bot --after-id 123 --json
```

For durable goal-bound Telegram-as-me waits, use the cursor poller. It reads
eligible monitor records, stores a cursor beside the monitor store, and only
advances an event cursor after hook dispatch succeeds:

```bash
openclaw telegram-user monitor-poll \
  --cron-store /path/to/cron.json \
  --hook-url http://127.0.0.1:18789/hooks/telegram-user-monitor-event \
  --hook-token "$OPENCLAW_GATEWAY_TOKEN" \
  --json
```

To keep the poller running in the foreground, opt in with `--watch`:

```bash
openclaw telegram-user monitor-poll \
  --watch \
  --poll-interval-ms 5000 \
  --cron-store /path/to/cron.json \
  --hook-url http://127.0.0.1:18789/hooks/telegram-user-monitor-event \
  --hook-token "$OPENCLAW_GATEWAY_TOKEN" \
  --json
```

Watch mode requires either `--hook-url` or `--commit-without-dispatch`. The
hook path is the normal mode. `--commit-without-dispatch` is for explicit
observe-only maintenance because it can consume replies without waking a
monitor session.

After foreground polling is proven for the intended runtime, install the same
poller as an opt-in supervised service on macOS launchd or Linux systemd:

```bash
openclaw telegram-user monitor-service install \
  --poll-interval-ms 5000 \
  --hook-url http://127.0.0.1:18789/hooks/telegram-user-monitor-event
```

Use `openclaw telegram-user monitor-service status|restart|stop|uninstall` to
manage it. The service runs the existing `monitor-poll --watch` path; it does
not own the gateway, mutate cron scheduling, or dispatch Telegram messages. If
the gateway requires token auth, set `OPENCLAW_GATEWAY_TOKEN` in the service
install environment instead of passing a hook token in command arguments.
Windows service installation is intentionally not wired in this slice; run
`monitor-poll --watch` under an explicit supervisor there.

WhatsApp-as-me waits use the generic monitor hook. After foreground polling is
proven against the intended `wacli.db`, install the poller as a separate
opt-in service:

```bash
openclaw whatsapp-monitor monitor-service install \
  --db-path /path/to/wacli.db \
  --poll-interval-ms 5000 \
  --hook-url http://127.0.0.1:18789/hooks/monitor-event
```

Use `openclaw whatsapp-monitor monitor-service status|restart|stop|uninstall`
to manage it. The service wraps `whatsapp-monitor poll --watch`; bounded smoke
runs still belong on the foreground poll command via `--max-runs`, not the
installed service.

Browser-only reply surfaces without an API can use the opt-in foreground
observer. It reads exactly one selector from one selected tab and posts only
hash evidence to the generic monitor hook:

```bash
OPENCLAW_HOOKS_TOKEN='dedicated-hooks-secret' \
  openclaw browser-monitor observe --watch \
  --browser-profile isolated-browser \
  --target-id TAB_ID \
  --url-pattern 'https://example.com/thread/*' \
  --selector '[data-reply]' \
  --match-mode contains \
  --match-value 'Replied:' \
  --monitor-id MONITOR_ID \
  --hook-url http://127.0.0.1:18789/hooks/monitor-event
```

`OPENCLAW_HOOKS_TOKEN` must resolve to the dedicated `hooks.token`; the command
does not accept secrets in process arguments. Watch mode logs a bounded error
and retries transient browser or hook failures, but stops for invalid static
configuration or permanent hook client errors, including HTTP 401/403. Without
`--watch`, failures remain fail-fast. This observer does not scan other tabs or
persist raw page text.

If a monitor has no explicit cursor seed such as `afterId`, the first poll
checkpoints the current visible Telegram history and emits no wake. This avoids
turning old chat history into a fresh monitor event when the listener starts.

## Session key policy (breaking change)

`/hooks/agent` payload `sessionKey` overrides are disabled by default.

- Recommended: set a fixed `hooks.defaultSessionKey` and keep request overrides off.
- Optional: allow request overrides only when needed, and restrict prefixes.

Recommended config:

```json5
{
  hooks: {
    enabled: true,
    token: "${OPENCLAW_HOOKS_TOKEN}",
    defaultSessionKey: "hook:ingress",
    allowRequestSessionKey: false,
    allowedSessionKeyPrefixes: ["hook:"],
  },
}
```

Compatibility config (legacy behavior):

```json5
{
  hooks: {
    enabled: true,
    token: "${OPENCLAW_HOOKS_TOKEN}",
    allowRequestSessionKey: true,
    allowedSessionKeyPrefixes: ["hook:"], // strongly recommended
  },
}
```

### `POST /hooks/<name>` (mapped)

Custom hook names are resolved via `hooks.mappings` (see configuration). A mapping can
turn arbitrary payloads into `wake` or `agent` actions, with optional templates or
code transforms.

Mapping options (summary):

- `hooks.presets: ["gmail"]` enables the built-in Gmail mapping.
- `hooks.mappings` lets you define `match`, `action`, and templates in config.
- `hooks.transformsDir` + `transform.module` loads a JS/TS module for custom logic.
  - `hooks.transformsDir` (if set) must stay within the transforms root under your OpenClaw config directory (typically `~/.openclaw/hooks/transforms`).
  - `transform.module` must resolve within the effective transforms directory (traversal/escape paths are rejected).
- Use `match.source` to keep a generic ingest endpoint (payload-driven routing).
- TS transforms require a TS loader (e.g. `bun` or `tsx`) or precompiled `.js` at runtime.
- Set `deliver: true` + `channel`/`to` on mappings to route replies to a chat surface
  (`channel` defaults to `last` and falls back to WhatsApp).
- `agentId` routes the hook to a specific agent; unknown IDs fall back to the default agent.
- `hooks.allowedAgentIds` restricts explicit `agentId` routing. Omit it (or include `*`) to allow any agent. Set `[]` to deny explicit `agentId` routing.
- `hooks.defaultSessionKey` sets the default session for hook agent runs when no explicit key is provided.
- `hooks.allowRequestSessionKey` controls whether `/hooks/agent` payloads may set `sessionKey` (default: `false`).
- `hooks.allowedSessionKeyPrefixes` optionally restricts explicit `sessionKey` values from request payloads and mappings.
- `allowUnsafeExternalContent: true` disables the external content safety wrapper for that hook
  (dangerous; only for trusted internal sources).
- `openclaw webhooks gmail setup` writes `hooks.gmail` config for `openclaw webhooks gmail run`.
  See [Gmail Pub/Sub](/automation/gmail-pubsub) for the full Gmail watch flow.

## Responses

- `200` for `/hooks/wake`
- `200` for `/hooks/agent` (async run accepted)
- `200` for `/hooks/monitor-event` (matched monitor wakes accepted)
- `401` on auth failure
- `429` after repeated auth failures from the same client (check `Retry-After`)
- `400` on invalid payload
- `413` on oversized payloads

## Examples

```bash
curl -X POST http://127.0.0.1:18789/hooks/wake \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"text":"New email received","mode":"now"}'
```

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","wakeMode":"next-heartbeat"}'
```

```bash
curl -X POST http://127.0.0.1:18789/hooks/monitor-event \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: gmail-thread-123-msg-456' \
  -d '{"triggerKind":"webhook","sourceType":"gmail","sourceTarget":{"account":"me@example.com","threadId":"thread-123"},"eventType":"message.created"}'
```

### Use a different model

Add `model` to the agent payload (or mapping) to override the model for that run:

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","model":"openai/gpt-5.2-mini"}'
```

If you enforce `agents.defaults.models`, make sure the override model is included there.

```bash
curl -X POST http://127.0.0.1:18789/hooks/gmail \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"source":"gmail","messages":[{"from":"Ada","subject":"Hello","snippet":"Hi"}]}'
```

```bash
curl -X POST http://127.0.0.1:18789/hooks/gmail-monitor-event \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"source":"gmail","account":"me@example.com","messages":[{"id":"msg-456","threadId":"thread-123","subject":"Hello"}]}'
```

## Security

- Keep hook endpoints behind loopback, tailnet, or trusted reverse proxy.
- Use a dedicated hook token; do not reuse gateway auth tokens.
- Repeated auth failures are rate-limited per client address to slow brute-force attempts.
- If you use multi-agent routing, set `hooks.allowedAgentIds` to limit explicit `agentId` selection.
- Keep `hooks.allowRequestSessionKey=false` unless you require caller-selected sessions.
- If you enable request `sessionKey`, restrict `hooks.allowedSessionKeyPrefixes` (for example, `["hook:"]`).
- Avoid including sensitive raw payloads in webhook logs.
- Keep monitor-event `sourceTarget` keys stable and minimal. Put raw provider content in
  `evidence` only when needed.
- Hook payloads are treated as untrusted and wrapped with safety boundaries by default.
  If you must disable this for a specific hook, set `allowUnsafeExternalContent: true`
  in that hook's mapping (dangerous).
