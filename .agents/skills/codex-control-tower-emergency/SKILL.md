---
name: codex-control-tower-emergency
description: "EMERGENCY ONLY: run, drain, or rotate a bounded Codex Control Tower after the user explicitly invokes 'Control Tower' or an authorized incident owner declares a fleet incident. Never trigger from ordinary implementation, parallel work, repository reading, multiple PRs, worktree count, resource pressure, or a slow task. Never self-elect, create a dashboard, admit workers, or begin Tower-style coordination without that explicit emergency activation."
---

# Emergency Codex Control Tower

Coordinate durable Codex workstreams without turning the coordinator into an
immortal command dispatcher. Apply `codex-orchestration` to every worker brief
and `stuck-session-handoff` when recovering a predecessor.

## Pass the emergency activation gate

Use this playbook only when at least one activation condition is explicit:

1. the user says `Control Tower` and asks to start, take over, drain, or rotate
   one; or
2. the user or already-authorized incident owner declares a fleet incident and
   names the affected fleet or coordination scope.

If neither condition exists, stop applying this skill and return to the
feature-owning workflow in `docs/agent-guides/workflow.md`. Ordinary
implementation, parallel agents, repository reading, several open PRs, many
worktrees, CPU/RAM/disk pressure, a slow coordinator, or routine merge/rebase
drift do not declare a fleet incident by themselves.

Before activation, never:

- self-elect as a tower or coordinator;
- create or adopt a dashboard, event log, wake driver, or tower goal;
- admit, reroute, pause, resume, or schedule workers;
- infer authority from a historical dashboard, archived receipt, prior Tower,
  or the mere availability of native thread tools; or
- impose Tower-style handbacks on independent feature owners.

An activated Tower remains a read-only emergency control plane. Preserve the
dashboard validation, incident handoff, drain, rotation, and historical receipt
procedures below; do not use them as a reason to widen the declared incident.

## Start an epoch

An epoch is one bounded coordinator lifetime.

### Place the tower on the control clone

When the repository defines a sacred, control, runtime-anchor, or pull-only
`main` clone, run the tower there as a read-only control plane. Do not create or
adopt a tower-specific worktree: the tower coordinates several branches and
must not inherit one implementation lane's checkout as fleet truth.

The tower may inspect repository and native thread state from the control clone
and may update its external dashboard. It must never edit repository files,
build, package, run implementation proof, or perform lane work in that clone.
Every implementation or proof lane uses its own temporary worktree according to
the repository workflow. If no control-clone convention exists, use a stable
read-only checkout and record the choice in the dashboard.

1. Verify the current roster from native thread state and relevant PR/runtime
   evidence. Do not trust predecessor status labels alone.
2. Create one compact dashboard at a durable user-approved path.
3. Record a finite epoch contract in the dashboard covering only its named
   lanes, current authority, rotation thresholds, and exactly one wake driver.
   Prefer a canary-proven native thread automation when the current product
   exposes it; otherwise use one finite epoch goal. Use manual pull only as the
   explicit degraded fallback.
4. Default to at most 20 tracked open lanes in one campaign, including parked
   approval and dependency lanes. Track execution capacity separately: target
   5 concurrently active workers, allow a normal burst ceiling of 8, and keep
   exactly one heavy owner. A user may explicitly choose lower limits or raise
   the active ceiling to 10.
5. Record the tower thread ID, host ID, epoch counters, thresholds, and exact
   approval boundaries.
6. Create or archive native threads only when the user explicitly authorizes
   those thread actions.

When replacing a predecessor, activation is transactional:

1. Reconcile every owned open lane from live evidence.
2. Write the successor thread ID into the dashboard as the current reporting
   destination.
3. Send a callback-only reroute to every owned open worker. Tell each worker to
   resolve the current destination from the dashboard before every material
   handback; an embedded thread ID is only a checked snapshot.
4. Verify delivery to every worker. Do not require routine reply
   acknowledgments because that wakes waiting workers and creates noise.
5. Prove the route with one material callback canary: prefer a real pending
   handback; otherwise use a synthetic read-only event with a stable event ID.
6. Mark takeover verified only after all deliveries and the canary succeed.
7. Archive the predecessor only with explicit authority after takeover is
   verified.

A created successor, delivered activation prompt, or copied dashboard is not a
takeover.

Default manual-rotation thresholds are the first of:

- 10 actual context compactions;
- 10 terminal lane transitions;
- 24 elapsed hours;
- 8 MiB of transcript bytes.

Use `scripts/measure_epoch.py` against the tower transcript to measure actual
`event_msg.payload.type == "context_compacted"` records, elapsed time, and
bytes. The dashboard owns the terminal-transition counter.

Do not automatically create the replacement tower. When a limit is reached,
freeze intake, write a verified handoff, notify the user, and remain idle.

### Select exactly one wake driver

The dashboard contract is the source of coordination truth, but it does not
wake an idle Codex thread. Every epoch therefore selects exactly one active
driver in this order:

1. **Native thread automation.** Use it only when the current environment
   exposes a callable create/update control and a live canary proves that the
   scheduled run returns to this exact tower thread, reads the dashboard,
   accesses native thread read/send tools, and reconciles or steers one worker.
   Product documentation, a UI label, or a successful detached CLI process is
   not proof. Record the automation ID, canary event ID, and verification time.
   If the control is absent or the canary fails, record `unavailable` or
   `failed`, remove any failed test schedule, and fall through.
2. **Finite epoch goal.** Use one goal when native thread automation is not
   verified. Before creating it, use the live goal control to prove that no
   unfinished goal exists. Never create a duplicate beside an active or
   blocked goal. The goal drives only the current epoch until all executable
   lanes reach proof, checkpoint, publication, approval, or dependency
   boundaries; a rotation threshold is reached; or bounded capacity recovery
   is exhausted.
3. **Manual pull.** Use only when neither prior driver can run. Set
   `degraded-idle`, `reconciliation_due: true`, and `alert_required: true`;
   record the exact next manual action and notify the user once.

Use this finite-goal objective as the canonical contract, adapted only for the
named lanes and explicit authority:

> Drive this Control Tower epoch until every executable owned lane reaches its
> proof, checkpoint, publication, approval, or dependency boundary, or until
> rotation is due. On each continuation, pull-reconcile every owned lane,
> maintain exactly one heavy owner, fill safe light-worker capacity, enforce
> authority, update and validate the dashboard, and process material callbacks
> once. A heavy-slot capacity refusal is expected scheduling pressure: retry
> only on the next continuation, at most three times, with one guard preflight
> per continuation and no busy loop. When only parked lanes remain, rotation is
> due, or bounded capacity recovery is exhausted, write the handoff, notify as
> required, and mark this goal complete. Never mark normal waiting blocked and
> never create the successor tower automatically.

A finite epoch goal is a bounded execution driver, not an immortal monitor.
Expected remote CI, callback, lease, dependency, or approval waiting must not
be represented as a blocker. At most three goal continuations may retry a
heavy-slot capacity refusal; each continuation performs one preflight and may
wait once for at most 60 seconds. After that, write a degraded manual handoff,
notify the user, and complete the goal. Reserve `blocked` for a genuine impasse
that meets the product's blocked-goal rules.

If an old tower goal remains active or blocked, do not falsely complete,
replace, or duplicate it. Record the product-state mismatch, enter
`degraded-idle`, and tell the user the exact stale goal to resolve. Once the
user resolves it, create the single finite epoch goal and continue.

## Use Dashboard v2

Keep the live dashboard small. Use this structure:

```yaml
epoch:
  id: tower-YYYYMMDD-N
  tower_thread_id: ...
  predecessor_thread_id: ...
  host_id: ...
  started_at: ...
  lifecycle_state: active|awaiting-pull|healthy-idle|degraded-idle|draining
  wake_mode: thread-automation|finite-goal|manual-pull
  wake_driver_status: verified|active|unavailable|failed|complete
  wake_driver_verified_at: null
  automation_id: null
  automation_canary_event_id: null
  goal_state: absent|active|complete|blocked
  goal_started_at: null
  capacity_retry_count: 0
  capacity_retry_limit: 3
  reconciliation_due: false
  next_reconcile_by: ...
  last_wake_at: ...
  last_material_event_at: ...
  alert_required: false
  context_compactions: 0
  terminal_lane_transitions: 0
  transcript_bytes: 0
  rotation_status: healthy
campaign:
  max_open_lanes: 20
  open_lane_count: 0
  target_active_workers: 5
  max_active_workers: 8
  active_worker_count: 0
  parallelism_gap: 5
  parked_lane_count: 0
  intake_state: open|frozen
routing:
  callback_delivery: guaranteed|best-effort
  expected_owned_lanes: 0
  verified_deliveries: 0
  callback_canary_event_id: ...
  takeover_verified_at: ...
heavy:
  owner_lane_id: null
  state: free
telemetry:
  event_log: ...
  last_event_at: ...
  last_failure_at: ...
decisions: []
lanes:
  - id: stable-lane-id
    owner_thread_id: ...
    phase: active|queued|waiting-approval|waiting-dependency|complete
    authority: source-only|bounded-bundle|protected
    dependency: ...
    next_event: ...
    last_event_id: ...
    dispatch_verified_at: ...
    callback_tower_thread_id: ...
    routing_event_id: ...
    routing_verified_at: ...
```

The live view contains only the epoch, heavy owner, pending user decisions, and
open lanes. Keep detailed coordination failures in an append-only JSONL event
log and only its path/latest timestamps in the dashboard. Move terminal lane
receipts into a separate append-only archive. Do not paste command transcripts
or historical narration into the live view.

After every dashboard write, run
`scripts/validate_dashboard.py <dashboard-path>`. A YAML parser or duplicate-key
check alone is insufficient. Do not end the tower turn until the semantic
validator passes. If it rejects a manual-pull stall, write `degraded-idle`, set
`reconciliation_due: true` and `alert_required: true`, record the exact
recovery action, and notify the user once.

Record these event types with `scripts/record_event.py`: `wake_attempt`,
`wake_success`, `wake_skipped_active`, `wake_deferred_capacity`, `wake_failed`,
`callback_missing_reconciled`, `callback_duplicate`, `self_callback_blocked`,
and `dashboard_stale`. Never put secrets, message bodies, command output, or
full paths from worker reports into telemetry details.

Treat native thread `idle` as a transport state, not a health verdict:

- `active`: the tower is executing a bounded coordination pass.
- `awaiting-pull`: accepted workers are in flight, no tower action is due now,
  and a guaranteed callback or scheduled/manual pull must reconcile them.
- `healthy-idle`: no worker is in flight, no coordination action is due, every
  open lane is genuinely waiting on dependency/approval or terminal, and the
  next external wake source is explicit.
- `degraded-idle`: action is due but no pass is running, routing is missing or
  stale, a callback canary failed, or a newly blocked coordinator goal prevents
  execution. An executable lane with no accepted in-flight worker bundle is
  degraded, not healthy waiting. An overdue pull reconciliation is also
  degraded. A known stale blocked goal that the goal-less epoch contract has
  superseded is recorded as product drift but does not by itself keep the tower
  degraded.
- `draining`: a rotation threshold was reached and new intake is frozen.

Update `last_wake_at` on every bounded pass and `last_material_event_at` only
for a non-duplicate material callback or user decision. Set `alert_required`
when entering degraded idle; clear it only after recovery is verified.

Record wake truth explicitly:

- Use `thread-automation` only after the native scheduled canary passes. Record
  its ID, verified timestamp, canary event ID, and next deadline.
- Use `finite-goal` only after live goal inspection proves there is no
  unfinished goal. Keep `goal_state: active` while executable coordination work
  remains. Complete the goal cleanly at a parked-only boundary, rotation, or
  bounded manual handoff; do not leave it active merely to wait.
- Otherwise use `manual-pull`, set `reconciliation_due: true` whenever action or
  reconciliation remains, and state plainly that the tower is not autonomous
  after its turn ends.

A scheduled wake is real only after a live test proves the resumed turn can use
the native thread read and send tools required for reconciliation. A CLI/exec
wake that rejects dynamic native-thread tools does not qualify. Local transcript
inspection is a stale recovery aid, not equivalent live evidence and not enough
to dispatch or verify acceptance. Do not install or retain that scheduler; log
`wake_failed` and fall through to the finite goal.

Native Codex thread relay is best-effort. Routing instructions and a successful
canary do not upgrade it to a guaranteed callback.

Increment `terminal_lane_transitions` once when a stable lane becomes complete,
cancelled, or genuinely blocked. Expected queue waiting is not terminal. A
reopened lane receives a new transition identity for the current epoch.

## Schedule workers

Classify each lane before steering it:

- **Executable:** prerequisites and authority are complete. Give the worker one
  bounded end-to-end goal and the whole implementation-to-handback sequence.
  Verify the worker accepted the bundle and record `dispatch_verified_at`.
- **Queued:** waiting only for the heavy slot. Keep it idle without an active
  goal until admitted.
- **Waiting dependency:** keep it idle; record the exact dependency.
- **Waiting approval:** surface the smallest user decision and keep it idle.
- **Terminal:** review the result, archive its receipt, and increment the
  terminal counter once.

Treat tracking capacity and execution capacity as different resources.
Waiting-approval and waiting-dependency lanes remain visible, but they are
parked and do not consume active-worker capacity. Count a worker as active only
after it has accepted an executable bounded bundle and its current turn is
still in progress. Do not count the tower itself, an idle thread, a delivered
prompt without verified acceptance, or a completed slice waiting for review.

On every wake, compute and record:

- `active_worker_count`;
- `parked_lane_count`;
- `parallelism_gap = max(0, target_active_workers - active_worker_count)`.

Fill the parallelism gap immediately with safe, non-overlapping light work
before ending the coordination turn. Keep exactly one heavy worker, but run
source-only repairs, bounded read-only investigations, independent reviews,
documentation, and remote-CI inspection concurrently when their authority and
ownership are already clear. Do not serialize light work behind the heavy
slot.

If the current roster cannot meet the target, inspect existing unfinished
native threads only when the user has authorized broader campaign intake.
Before resuming one, read its latest live turn and revalidate that its objective
is unfinished, its worktree and ownership remain valid, its next action is
within existing authority, and it does not overlap an active lane. Resume it
with a new bounded bundle and current handback route. Never wake completed,
superseded, archived, approval-blocked, dependency-blocked, or protected-action
threads merely to make the worker count look healthy.

When fewer workers can run than the target, report the exact parallelism gap
and the smallest reason: no executable inventory, user decision, dependency,
ownership conflict, or heavy-slot serialization. A low worker count is healthy
only when no safe authorized work exists; it is degraded when executable work
exists but was not dispatched.

Worker goals are for executable lanes only. The single finite tower epoch goal
is the explicit exception and must follow the bounded contract above. Do not
create or preserve any goal merely to wait for a lease, dependency, callback,
or approval. Expected waiting otherwise burns continuation turns and can
falsely become `blocked`.

Drive every executable lane forward. After dispatch, verify the worker is
active or otherwise explicitly accepted the bundle. If delivery succeeds but
acceptance cannot be verified, keep the tower active for one bounded
reconciliation; if still unverified, enter `degraded-idle` and alert. The tower
itself enters `awaiting-pull` while accepted workers execute unless a guaranteed
callback can wake it. Set the next reconciliation deadline before ending the
turn.

Independent review is executable work, not a dependency, when a fresh bounded
reviewer subagent can perform it under existing authority. Dispatch such
read-only/light reviews concurrently without consuming the heavy slot. Use a
new user-owned native thread only with explicit creation authority. Treat review
as waiting-dependency only when a specific external reviewer, unavailable
artifact, or protected action is genuinely required. Route findings back to the
owning implementation lane.

Every executable worker brief must:

- define a stable lane ID, one bounded objective, and observable completion
  criteria;
- name its owned worktree/scope and prohibit unrelated edits;
- enumerate standing authority for implementation, proof, checkpoint, and
  publication, plus every protected action that remains excluded;
- state exact stop conditions: genuine failure, scope/ownership drift, new
  authority, protected action, or terminal completion;
- name the dashboard path as the authoritative reporting destination;
- include the current tower thread ID only as a checked snapshot;
- authorize the complete known proof/checkpoint/publication bundle;
- require the machine-wide guard for each heavy command without requesting
  fresh conversational approval between already-authorized stages;
- stop only for genuine failure, scope or ownership drift, new authority,
  protected action, or final completion;
- require an actual cross-thread send tool call for every material handback;
  if the sender is not directly exposed, require `tool_search` discovery before
  the worker emits its local final answer;
- treat the handback as delivered only after the send tool returns success;
  writing the report in the worker's own final answer is not delivery;
- return one stable event ID such as
  `lane:<lane-id>:checkpoint:<commit-or-sequence>`.

Reject an executable brief that omits objective, completion criteria, ownership,
authority, stop conditions, or handback contract. Do not compensate for an
ambiguous brief with repeated steering.

## Process callbacks

Accept only material blocker, decision-needed, drift, or terminal handbacks.
Store `last_event_id` per lane. If the same event arrives again, do not steer,
notify, increment counters, or duplicate dashboard text.

Process an inbound callback locally. Before any cross-thread send, compare the
resolved destination with both the tower's current thread ID and
`epoch.tower_thread_id`. If either matches, do not send: deduplicate by event ID
and process the callback exactly once. An inbound delegation's
`source_thread_id` is provenance, not a new reporting destination. Never relay a
callback to the tower itself. Treat a self-addressed callback as a transport
duplicate: do not steer, notify, increment counters, update the dashboard, or
send again.

Before every material native-thread handback, the worker must read the dashboard
and use its current `epoch.tower_thread_id`. If that differs from the worker's
snapshot, report to the dashboard value and record the resolved destination in
the event. This makes rotation durable without pretending native Codex provides
a subscription or guaranteed callback.

If the resolved `epoch.tower_thread_id` is the current thread, process and
deduplicate the callback locally. Never call the cross-thread sender back to
the same thread. Treat any self-relayed echo with an already accepted stable
event ID as a duplicate transport artifact: do not steer, notify, increment
counters, add another dashboard entry, or send it again.

The worker must then call the cross-thread sender. If it is not visible, use
`tool_search` to discover `send_message_to_thread` or its current equivalent.
Do not close the worker turn until the send succeeds or an exact tool
absence/error is reported locally. A narrative claim such as "Tower received"
without a successful tool receipt is false.

This coalesces duplicate effects but cannot prevent a closed-source Codex
transport duplicate from entering transcript context. State that limitation
plainly. A user-owned relay may deduplicate earlier only when its contract and
authority permit.

On every tower wake, pull-reconcile all owned open workers before trusting the
dashboard. Reconcile again after a meaningful timeout, suspected stale state,
explicit status request, or missing terminal handback. Never short-poll inside
one turn. A periodic external wake is different from short-polling.

## Serialize heavy work

Maintain exactly one heavy owner. Admission belongs to the repository's
machine-wide guard, not conversational stage approvals. A worker with a bounded
bundle may acquire, release, and reacquire the guard across its authorized
commands. A capacity refusal returns the lane to `queued`; it is not a product
blocker. Under a finite tower goal, retry only on the next continuation within
the bounded capacity-retry contract; never spin or short-poll in one turn.

## Separate incidents

The tower records an incident, pauses affected dependencies, and continues
unrelated coordination. It does not absorb diagnosis or implementation.
Create a dedicated incident thread only with explicit user authorization.
Require one final incident handback to the tower.

## Notify the user

Use `jarvis-telegram-notify` only when the user has authorized Telegram
notifications. Send one concise message for:

- a required user decision;
- material lane completion or failure;
- a serious runtime/resource incident;
- entry into `degraded-idle`, including the exact recovery action;
- a newly blocked coordinator goal that prevents execution, or a failed
  takeover route;
- rotation threshold reached;
- verified replacement-tower activation.

Do not send routine test, lint, lease, or progress receipts. Prefer one
coalesced notification when several events land together.

## Rotate manually

When any lifecycle threshold is reached:

1. Set `rotation_status: draining` and stop accepting new lanes.
2. Reconcile every open lane from live thread/PR/runtime evidence.
3. Write the compact successor dashboard and append terminal receipts.
4. Send one rotation-required Telegram notification if authorized.
5. Ask the user to create the replacement, unless that exact creation was
   already explicitly authorized.
6. Run the transactional activation sequence: reconcile, switch the dashboard
   destination, reroute every owned worker, verify every delivery, and prove one
   callback canary.
7. Verify the replacement accepted the finite dashboard epoch contract and
   selected exactly one wake driver. Prefer a canary-proven native thread
   automation; otherwise create one finite epoch goal after proving no
   unfinished goal exists.
8. Archive the predecessor only after takeover verification and explicit
   archival authority.

Never infer takeover from a created thread or delivered prompt alone.
