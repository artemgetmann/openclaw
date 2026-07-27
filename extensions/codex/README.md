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
