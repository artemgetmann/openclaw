# OpenClaw Codex compatibility pilot

This bundled extension is the first isolated same-Mac Codex thread-control slice
for the consumer fork. It deliberately does not replace Pi as OpenClaw's
default runtime.

## What the pilot supports

- Owner-only status, compact fleet inventory, list, search, read, create,
  message, resume, and fork controls through `/codex` and the `codex_threads`
  agent tool.
- Natural-language delegation has two execution modes:
  - analysis stays in the selected project with a read-only sandbox, network
    disabled, and no approval prompts
  - implementation creates a generic fresh-branch Git worktree, then gives Codex
    write access only inside that lane, network access, and deterministic
    `on-request` Auto-Review
- A new async launch returns a consumer-readable receipt containing the selected
  project name, source project directory, assigned workspace/worktree directory,
  read/write mode, network state, Auto-Review policy, and native Codex thread id.
  Resumed existing threads are labeled honestly as using their saved policy.
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
- Proactive worker callbacks through the shipped `openclaw codex-callback`
  command and an owner-only durable route registry. The natural message body is
  carried inside a deterministic envelope binding the exact native thread,
  originating Jarvis session, callback id, monotonic sequence, and `progress`,
  `blocked`, `decision-needed`, or `complete` status.
- The route survives the launch turn ending, Gateway/plugin restart, and a
  later same-thread resume through another transport host such as Slingshot.
  New delegations do not install the old process-local `jarvis_callback`
  dynamic tool, because its schema could outlive its callable handler.
- Callback authority is scoped by an unguessable route capability kept in the
  owner-only state directory plus the native `CODEX_THREAD_ID`. Forged,
  cross-thread, malformed, non-monotonic, changed-content, and receipt-only
  callbacks fail closed. Exact retries after confirmed delivery return the
  same receipt without waking Jarvis twice.
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

The terminal listener covers native turns started by this Jarvis-owned App
Server process. Proactive callbacks use a separate durable route: a resumed
worker invokes the local OpenClaw CLI, which authenticates to the Gateway using
normal service configuration and presents only its narrow callback capability.
This is request/response delivery, not a cross-process App Server subscription.

The worker does not call `send_message_to_thread` back to Jarvis. A Jarvis
session is not a native Codex thread address. The scoped `codex-callback` CLI is
the proactive return transport; Jarvis validates the durable route and source
thread, wakes the exact originating session, and retains ownership of user
delivery and Telegram routing. No Telegram credential, chat id, or topic
authority is exposed to Codex.

The launcher-owned terminal listener remains reconciliation fallback. A valid
`complete` callback suppresses the duplicate terminal wake; if the worker never
calls back or the proactive command fails before acquiring delivery authority,
terminal output still reaches the originating Jarvis session. If delivery
becomes ambiguous after its durable claim, Jarvis receives a decision-needed
handback instead of an unsafe duplicate result.

Callback routes and delivery claims are recorded atomically in an owner-only
registry under the OpenClaw state directory. The record contains its scoped
capability and exact Jarvis/native-thread routing, but no task prompt, Telegram
credential, chat id, or topic authority. A delivered `complete` callback closes
the route; other statuses advance its next sequence for later same-thread use.
Completed-route receipts are retained for up to 30 days and pruned oldest-first
when the bounded registry needs room for a new route.

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
workspace-write with the prepared worktree as the only writable root and enable
tool network access. Implementation threads request the canonical App Server
pair `approvalPolicy: "on-request"` and `approvalsReviewer: "auto_review"`;
thread creation fails closed if the server reports a different effective
directory or approval policy. Auto-Review decides supported approval requests
inside Codex. Any residual approval request that reaches this stdio client is
declined because the pilot does not expose a second user-facing approval bridge.
Follow-up turns omit policy overrides so the exact native thread keeps its saved
policy instead of being silently reset.

## Deliberate next slice

The older consumer fork does not yet contain upstream's complete AgentHarness
runtime, a separate projected user-approval UI, media projection, compaction, or
supervised session catalog. Those remain a selective follow-up port. This pilot
keeps its contract narrow instead of recreating those systems speculatively.
