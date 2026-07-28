# OpenClaw Codex compatibility pilot

This bundled extension is the first isolated same-Mac Codex thread-control slice
for the consumer fork. It deliberately does not replace Pi as OpenClaw's
default runtime.

## What the pilot supports

- Owner-only status, compact fleet inventory, list, search, read, create,
  message, resume, and fork controls through `/codex` and the `codex_threads`
  agent tool.
- Explicit conversation binding to one durable native Codex thread with
  `/codex bind [thread-id]`.
- Fail-closed routing for bound conversations. If the extension, binding, or
  App Server is unavailable, the request is not passed to Pi.
- One active continuation per thread, selected progress projection, and one
  stable final reply.
- Nonblocking owner delegation through `delegate_async`: Jarvis returns after
  Codex accepts the turn, then the completed result starts a new delivered
  Jarvis turn in the exact originating session.
- Launcher-owned worker handback for every async turn: Codex receives the
  delegation id, exact native thread id, and instructions to finish with
  `complete`, `blocked`, or `decision-needed`, plus the useful result and
  relevant proof/next-action details. The owner task remains unchanged inside
  a delegation-specific payload boundary.
- Exact return attribution for async relays: the continuation carries the
  native Codex thread and turn ids plus trusted inter-session provenance.
- Proactive worker callbacks through one Jarvis-owned dynamic App Server tool.
  The natural message body is carried inside a deterministic envelope binding
  the delegation, exact native thread and turn, originating Jarvis session,
  callback id, monotonic sequence, and `progress`, `blocked`,
  `decision-needed`, or `complete` status.
- Proactive callbacks are guaranteed only for callback-capable threads created
  through this App Server client. The pinned App Server protocol cannot install
  dynamic tools while resuming a pre-existing thread, so those workers may not
  have `jarvis_callback`; their terminal result still returns through the
  launcher-owned relay fallback.
- Callback authority is process-local and turn-scoped. Jarvis accepts the tool
  request only from its owned App Server connection while the exact
  delegation/thread/turn grant is active; forged, stale, wrong-turn, malformed,
  non-monotonic, and receipt-only callbacks fail closed. Exact retries are
  deduplicated before Jarvis wakes or delivers twice.
- Async replies can target the same native thread through `message_async`;
  while the reported turn is still active, Jarvis uses App Server
  `turn/steer` with the exact expected turn id. After terminal completion, the
  existing same-thread follow-up path starts a new turn. Receipt-only
  acknowledgements and relay-triggered recursive delegation are explicitly
  forbidden to prevent ping-pong loops.
- Fleet inventory paginates the metadata-only catalog, always retains every
  active thread, and reports how many inactive historical threads were omitted
  from the compact roster.
- Fleet inventory is deliberately read-only. A standalone extension App Server
  does not necessarily own turns running in another Codex process, so this
  surface does not claim cross-process steering or interruption.
- One-time Telegram approval buttons for archive and unarchive, with
  sender-bound tokens and a fresh native state check before mutation.

The extension never creates Telegram topics automatically. Binding an existing
conversation or topic is always explicit.

## Async relay boundary

The relay covers native turns started by this Jarvis-owned App Server process.
It does not claim that messages sent through an unrelated Codex process are
broadcast into this stdio client. Cross-process subscription requires a shared
supervisor or broker and is outside this compatibility slice.

The worker does not call `send_message_to_thread` back to Jarvis. A Jarvis
session is not a native Codex thread address. When available, the scoped
`jarvis_callback` dynamic tool is the proactive return transport; Jarvis
validates its server-owned thread/turn identity, wakes the exact originating
session, and retains ownership of user delivery and Telegram routing. No
Telegram credential, chat id, or topic authority is exposed to Codex.

The launcher-owned terminal listener remains reconciliation fallback. A valid
`complete` callback suppresses the duplicate terminal wake; if the worker never
calls back—or the resumed thread does not expose `jarvis_callback`—terminal
output still reaches the originating Jarvis session.

The native thread remains durable across normal follow-up turns, but an active
async relay is process-local: stopping the Gateway also stops the App Server
child and its completion listener. The extension never retries that interrupted
turn automatically because doing so could duplicate work or side effects.

## Configuration

The default transport starts the locally installed Codex App Server over stdio:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          command: "codex",
          args: ["app-server", "--listen", "stdio://"],
          defaultWorkspaceDir: "/absolute/readable/workspace",
        },
      },
    },
  },
}
```

Every pilot turn uses a read-only sandbox, disables tool network access, and
declines App Server approval requests that cannot be safely projected.

## Deliberate next slice

The older consumer fork does not yet contain upstream's complete AgentHarness
runtime, native approval bridge, media projection, compaction, or supervised
session catalog. Those remain a selective follow-up port. This pilot keeps its
contract narrow instead of recreating those systems speculatively.
