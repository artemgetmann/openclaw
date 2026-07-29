# OpenClaw Codex compatibility pilot

This bundled extension is the first isolated same-Mac Codex thread-control slice
for the consumer fork. It deliberately does not replace Pi as OpenClaw's
default runtime.

## What the pilot supports

- Owner-only status, compact fleet inventory, list, search, read, create,
  message, resume, and fork controls through `/codex` and the `codex_threads`
  agent tool.
- Natural-language delegation has two execution modes:
  - analysis stays in the selected project with a read-only sandbox
  - implementation creates a generic fresh-branch Git worktree, then gives Codex
    write access only inside that lane
- Implementation workers read repository policy and use any repo-owned
  worktree adoption/bootstrap path before editing. The owner does not need to
  know the repository's worktree mechanics.
- An explicit direct-workspace override is available for clean, named-branch
  checkouts. Canonical OpenClaw home clones and configured protected roots are
  always rejected for direct writes.
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
- Durable monitor authority for one exact preapproved continuation:
  `codex.thread.unarchive_resume` binds a goal, stable purpose, native thread,
  continuation prompt, expiry, stop condition, and idempotency key. The monitor
  store consumes the grant before unarchiving or starting the turn, so restart
  and duplicate wakes cannot execute the action twice.

Monitor sessions may still use read-only Codex inventory. Generic mutating
Codex actions are rejected from monitor sessions; only the exact durable action
above can cross that boundary. Interactive owner commands keep their existing
one-time approval flow, and no global permission is widened.

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

Accepted async relays are recorded in an atomic owner-only registry under the
OpenClaw state directory before acceptance returns to Jarvis. The record binds
the delegation, originating Jarvis session, native thread and turn, lifecycle,
stable delivery key, and reconciliation timestamps. It contains no task prompt,
Telegram credential, chat id, or topic authority.

Stopping the Gateway still stops its App Server child and process-local
completion listener. On startup, the extension uses only
`thread/read(includeTurns: true)` to inspect the exact persisted native turn. A
proven completed turn with a final agent message is relayed once. A nonterminal,
missing, mismatched, failed, interrupted, malformed, or stale record wakes the
originating Jarvis session with a decision-needed report when exact routing
identity exists. A crash after delivery starts is also reported as ambiguous;
the result is not sent again. Startup never resumes observation, subscribes to
an unrelated Codex process, infers completion, or retries the task because any
of those actions could duplicate work or side effects.

A returned Jarvis `runId` proves only that the continuation was accepted for
execution. The registry finalizes delivery only after `agent.wait` reports that
exact Jarvis run completed. Likewise, successfully queueing a system event and
requesting a heartbeat is volatile wake evidence, not a durable delivery
receipt. Both crash windows remain non-final and reconcile to an explicit
decision-needed report; neither can silently suppress the terminal handback.

Decision-needed classification is irreversible. Reconciliation atomically
claims its one permitted report before invoking Jarvis; after a crash, startup
does not inspect Codex again or resend that report. This at-most-once boundary
may leave delivery ambiguous, but it cannot turn a stale or uncertain relay
back into a terminal-result candidate. Run and heartbeat timestamps are
diagnostic only and never refresh the lifecycle staleness clock. These receipts
prove Jarvis-run completion and a finished delivery path/attempt—not durable
Telegram or provider delivery.

Reconciliation isolates each durable record. A failed inspection or Jarvis
dispatch is logged after its fail-closed claim and cannot prevent later,
unrelated relays from reconciling during the same startup pass.

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
          worktreesRoot: "/absolute/codex/worktrees",
          protectedWorkspaceDirs: ["/absolute/protected/checkout"],
        },
      },
    },
  },
}
```

Analysis turns use a read-only sandbox. Implementation turns use
workspace-write with the prepared worktree as the only writable root. Both
disable tool network access and decline App Server approval requests that
cannot be safely projected.

## Deliberate next slice

The older consumer fork does not yet contain upstream's complete AgentHarness
runtime, native approval bridge, media projection, compaction, or supervised
session catalog. Those remain a selective follow-up port. This pilot keeps its
contract narrow instead of recreating those systems speculatively.
