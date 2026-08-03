# Local fleet resource control

This Mac is a dedicated agent host and the production Jarvis host. Local agent
throughput may consume spare capacity aggressively, but it must not trade away
machine survival, remote access, or Jarvis availability.

## Hard limits

- Eight to twelve open lanes are a valid scheduling target. Open or waiting
  lanes do not need to hold an expensive local execution slot.
- Run at most one heavy local command across all worktrees.
- Give broad tests and builds one worker unless a focused command cannot do so.
- Prefer remote CI for full suites.
- Never overlap packaging, deployment, or shared-runtime work.
- Load Xcode, browser, web-research, and other specialist MCP servers only for
  lanes that need them. Do not preload every specialist server in every chat.

A command is heavy when it can run longer than 30 seconds, starts worker
processes, builds an app/package, runs a broad test or review suite, performs a
browser/GUI E2E, or materially increases CPU or memory use.

Multiple lanes may reason, inspect files, make source edits, or wait on remote
CI in parallel while the host remains healthy. The expensive proof phase is the
serialized resource, not the conversation count.

## Failure taxonomy

The machine-wide guard exists because these failures were observed across
parallel feature lanes, not because parallel source ownership is inherently
unsafe:

- CPU: overlapping builds, broad tests, Swift/Xcode work, browsers, and model
  tooling starved the interactive host and Jarvis event loop.
- RAM: multiple worker trees and specialist processes reduced headroom until
  the workstation became unreliable even when no single command looked fatal.
- Disk: hundreds of worktrees plus repeated dependencies, build products,
  packages, archives, and simulator artifacts pushed the Data volume to 96%
  used with only 44 GiB free in the 2026-07-28 incident snapshot. Disk retention
  was still unmerged, so that snapshot was evidence—not an active cleanup
  guarantee.
- Worktree multiplication: creating a lane was cheap conversationally but often
  cloned another dependency/build footprint; old lanes also retained stale
  guard code.
- Raw-command bypass: direct `pnpm`, `swift`, `xcodebuild`, manual
  `launchctl`, or noncanonical scripts can avoid repository entrypoint guards.
- Merge/rebase churn: multiple independent PRs advancing `main` created routine
  `BEHIND` states, stacked dependencies, and repeated proof. A central merge
  agent did not remove that Git truth; feature owners must refresh and continue.
- Package/release overlap: app bundles, release receipts, notarization, appcast,
  and install state are shared machine resources even when source worktrees are
  isolated.
- Runtime/live collisions: concurrent deploy, restart, tester-runtime, GUI, or
  Telegram acceptance campaigns can invalidate provenance, message evidence,
  session cleanup, and the result another lane is trying to prove.

## Required wrapper

Run every heavy command through the shared slot:

```bash
scripts/with-heavy-local-slot.sh --label "<thread-id>:<purpose>" -- \
  pnpm vitest run path/to/focused.test.ts --maxWorkers 1
```

For a diagnostic snapshot only, use the read-only preflight:

```bash
scripts/with-heavy-local-slot.sh --label "<thread-id>:preflight" --check
```

`--check` does not reserve the slot. Never use a successful check followed by a
separate unguarded command as admission; another lane can win that race. Use one
bounded acquire-and-run transaction when the caller can wait:

```bash
scripts/with-heavy-local-slot.sh \
  --label "<thread-id>:focused-proof" \
  --wait-seconds 900 \
  -- pnpm vitest run path/to/focused.test.ts --maxWorkers 1
```

The bounded path waits without holding the lease, acquires and health-checks
atomically before launch, and executes the command once. It prints at most one
`Heavy-local slot queued` notice even if the refusal reason changes while
waiting. `occupied` and `host_unhealthy` are retryable; `guard_internal` fails
immediately because retrying ambiguous guard state could hide a sandbox,
measurement, metadata, or identity failure.

On macOS, run the guard itself outside a restricted sandbox because safe owner
identity requires native `/bin/ps` access. A restricted
`guard_internal owner_publish_failed stage=process_start_unavailable` permits
exactly one identical native rerun; do not poll or delete lease metadata. Run
the real workload in that same native acquire-and-run transaction—a successful
`--check` never authorizes a later unguarded command. A native `occupied` or
`host_unhealthy` result remains a queue/stop outcome; a native `guard_internal`
result requires diagnosis before any workload starts.

The wrapper stores an atomic lease at a stable per-user machine path, so
independent clones and worktrees contend for the same slot. Canonical
build/package/release/runtime entrypoints self-acquire this lease when called
directly. Nested entrypoints reuse it only when the wrapper's capability token
matches live owner metadata and the nested process is a verified descendant of
that exact owner PID/start-time identity. A copied token, caller-provided
boolean, sibling process, or stale environment cannot bypass admission.

The guarded command starts as the leader of a dedicated process group and
session. The wrapper records the leader PID, PID start fingerprint, process
group, and session, then requires an atomic commit marker before work begins.
Pending or uncommitted metadata is never treated as signal authority or proof
that stale recovery is safe. Live PGID and session validation uses POSIX
`getpgid()`/`getsid()` results; macOS `ps -o sess=` is not a numeric SID source
and must not be used for this contract. Root-command exit is not treated as
tree exit: the wrapper sends `TERM`, escalates to `KILL`, and proves the entire
recorded group is gone before releasing the lease. Stale recovery likewise
requires positive proof that both the owner and guarded process group are gone.
A dead wrapper with live orphan workers continues to block admission. Missing
metadata, an incomplete spawn handshake, unreadable process identity, PID or
group reuse, or mismatched start/session identity fails closed instead of
guessing that the lease is stale or signaling an unverified group.

On a Mac intentionally reserved for agents, use the dedicated entrypoint. It
selects the explicit dedicated CPU policy without requiring every caller to
remember the lower-level flag:

```bash
scripts/with-dedicated-agent-slot.sh \
  --label "<thread-id>:capacity-ramp" \
  --wait-seconds 900 \
  -- pnpm vitest run path/to/focused.test.ts --maxWorkers 1
```

The named entrypoint owns CPU policy. Passing a second `--cpu-policy` fails
before admission with `code=wrong_cpu_policy` and directs the caller to remove
the override. Direct `scripts/with-heavy-local-slot.sh --cpu-policy
dedicated-agent` remains supported for lower-level integrations, while an
unflagged call to that general wrapper intentionally stays on the shared-machine
default.

This named mode allows 0% CPU idle while adding dedicated-host observations and
platform safety signals. Preflight and runtime samples emit
`HEAVY_LOCAL_CPU_TELEMETRY`; the grant receipt records
`cpu_policy=dedicated-agent`; and resource receipts report macOS memory-pressure
state, swap allocation, pageout/swapout counters, thermal/performance pressure,
managed-Jarvis identity and HTTP latency, plus guarded-group process count and
RSS. Arguments, environment values, and unrelated process details are never
recorded.

The machine-wide lease, 25% memory floor, disk policy, Tailscale check, process
identity, signal propagation, two-strike runtime stop, and exact cleanup remain
unchanged. Dedicated mode additionally refuses admission while macOS reports
memory warning/critical or thermal/performance pressure. It pins the healthy
managed Jarvis LaunchAgent PID before launch, requires that PID to be the only
listener on port 18789, and treats listener takeover, restart, HTTP failure, or
the existing three-second timeout as health failures. Missing required resource
telemetry fails closed as `guard_internal`. Use the mode only for a dedicated
agent transaction; omitting the flag (or selecting `standard`) retains the
conservative shared/personal-machine behavior without these additional probes.

On macOS the default policy currently refuses admission when:

- another heavy command owns the slot;
- system memory headroom is below 25%;
- CPU idle capacity is below 35%;
- Data-volume free space is below 25 GiB;
- configured Tailscale is disconnected; or
- the managed Jarvis gateway is installed but unhealthy.

Between 25 GiB and 35 GiB free, admission remains honest but prints one
`HEAVY_LOCAL_DISK_REPORT` warning with the exact available KiB, report
threshold, hard floor, and owner label. That is the trigger to run the
repository retention report before the next build grows the incident. The
runtime monitor also enforces the 25 GiB floor, so a guarded build that consumes
the remaining margin is stopped through the same two-strike tree cleanup used
for CPU and memory pressure.

Refusals retain exit code `75` for compatibility and also emit a stable line:

```text
HEAVY_LOCAL_SLOT_REFUSAL class=<occupied|host_unhealthy|guard_internal> code=<reason> [measurement fields] phase=<admission|runtime> outcome=<refused|terminated> next_action=<safe-action>
```

The class separates normal serialization, measured host pressure, and failures
inside the guard or its measurement backends. The following human line retains
the useful owner, PID, measurement, or recovery detail and names the same next
safe action. Retryable admission pressure additionally emits
`HEAVY_LOCAL_SLOT_PAUSED` with `phase=admission`, `outcome=paused`, the decisive
observation, and the recovery condition before the bounded waiter sleeps. A bounded wait that
expires emits the last retryable class with `code=wait_timeout`.
Measured CPU, memory, Tailscale, and Jarvis refusals also expose stable
`metric`, `observed`, `threshold`, `expected`, and `unit` fields when relevant.
These are refusal telemetry, not a complete capacity profile.

Dedicated transactions also emit three bounded telemetry lines:

- `HEAVY_LOCAL_RESOURCE_TELEMETRY` records elapsed time, macOS memory-pressure
  state, swap used/free KiB, cumulative pageouts/swapouts, thermal state, and
  explicitly labels paging counters as observed telemetry with no kill limit;
- `HEAVY_LOCAL_JARVIS_TELEMETRY` records the matching LaunchAgent/listener PID,
  sample phase/time, HTTP status, and latency; and
- `HEAVY_LOCAL_GROUP_TELEMETRY` records only the guarded PGID's process count and
  aggregate RSS, explicitly labeled as observations under the single-group
  enforcement boundary.

Absolute swap use and process count are observations, not unevidenced kill
thresholds. macOS can retain historical swap after pressure recovers, and the
known workloads have different legitimate helper counts. Derive trends from
successive monotonic samples; do not reinterpret a large absolute value as a
failure when the platform still reports normal pressure.

An owner-metadata publication failure also includes the exact atomic
publication stage and owner path. Inspect that generated lease path and its
live process references; do not delete it or retry-loop the guard merely
because the old message was opaque.

Admitted commands run with background scheduling and reduced process priority.
While the command runs, the wrapper rechecks the host every 15 seconds. Two
consecutive unhealthy samples stop only the guarded command and its worker tree
before VNC, Tailscale, or Jarvis can remain starved for minutes. The slot is
released when the command exits. Exit code `75` means "temporarily unavailable"
or "stopped to protect host health"; wait for recovery instead of bypassing the
guard.

For a temporary availability wait, retain the exact source/checkpoint state and
poll infrequently. Prefer a product-native monitor or scheduled wake at a
five-to-ten-minute cadence when one is available. If the active environment has
no reliable wake mechanism, do not start a tight sleep loop or hammer the
guard; report the queued checkpoint once and resume when the coordinator or
user wakes the lane. Never use polling for an authorization rejection:
authorization requires explicit approval and cannot become valid with time.
If one fresh retry after verified host recovery fails at the same stage for the
same health reason, stop treating it as a queue wait. Preserve the artifact,
release the lane, and diagnose the command's own resource behavior. Repeatedly
restarting a deterministic offender is not autonomous completion; it is just a
slower denial of service.

The 25% memory threshold, standard-policy 35% admission CPU-idle threshold,
standard-policy 20% runtime CPU-idle threshold, 25 GiB disk floor, 35 GiB
disk-report threshold, 15-second interval, two-strike stop rule, and three-second
health timeout remain fixed product policy in this revision. Environment
variables cannot lower, disable, corrupt, or stretch them. Only the named
dedicated entrypoint (or its exact lower-level `--cpu-policy dedicated-agent`
equivalent) makes CPU idle telemetry-only; unknown or conflicting values fail
closed.

## Task-owned disk receipts

The wrapper measures only known generated directories inside the guarded
command's starting Git worktree. It never scans source, shared caches, Codex
history, browser state, credentials, or another lane. When one guarded task
creates at least 1 GiB there, task exit prints
`HEAVY_LOCAL_DISK_RECEIPT` with the exact worktree, before/after generated KiB,
host free-space KiB, and threshold.

That receipt is accountability, not deletion authority. The owner must preserve
outputs still needed for its PR/release handoff. Otherwise it runs the
repository cleanup report for that exact lane's generated state and retires the
whole temporary worktree through `gc-worktrees.sh` only after clean,
recoverable, process-free proof. Active, dirty, unmerged, release, runtime, and
ambiguous state remains protected.

## Dedicated-host capacity policy

The one-heavy lease is a failure-containment boundary, not interactive-headroom
policy. It remains machine-wide for every profile.

Current protection separates platform danger signals from capacity evidence:

- CPU: the default retains admission and runtime CPU-idle checks; the explicit
  dedicated-agent transaction records CPU idle without enforcing a floor. Both
  modes retain background scheduling and reduced priority. Dedicated mode also
  refuses/stops on macOS thermal or performance pressure.
- Memory: the fixed 25% headroom floor remains. Dedicated mode also consumes the
  macOS normal/warn/critical pressure state and reports swap allocation plus
  cumulative pageout/swapout counters. It deliberately has no absolute swap or
  paging-rate cutoff because no universal failure boundary has been measured.
- Disk: admission reports below 35 GiB and refuses below 25 GiB; retention
  tooling still owns candidate classification and deletion.
- Availability: configured Tailscale connectivity remains required. Dedicated
  mode additionally pins the managed Jarvis PID, matches it to the only listener,
  and records HTTP latency under the existing three-second timeout. VNC or
  another remote-desktop path is not probed directly.
- Overlap: the machine-wide lease and process-group supervision prevent two
  guarded heavy trees from running concurrently. Dedicated runtime samples also
  expose the one guarded group's process count and aggregate RSS.

Dedicated-agent mode still does not pretend that observed capacity receipts are
universal thresholds. Paging-rate, Jarvis-latency trend, and per-process fanout
limits remain deferred until a bounded experiment measures a failure boundary:

1. Preserve the built-in redacted resource, Jarvis, and group telemetry for
   representative Node, Swift/Xcode, browser, and package workloads run one at
   a time under the existing lease. Record admission, every 15-second runtime
   sample, workload exit, and any Jarvis or remote-access interruption.
2. Establish stop limits from the first observed paging, latency, fanout, disk,
   or availability degradation, then apply an explicit safety margin. A threshold
   change is invalid if no failure boundary was observed.
3. Repeat deterministic guard tests and a bounded host soak before
   considering any default change or broader dedicated-host profile.

Until that experiment is complete, describe swap/pageout, latency, and group
size as trend telemetry—not numeric enforcement. Direct platform memory and
thermal pressure, Jarvis identity/HTTP health, disk, Tailscale, serialization,
signals, and cleanup are enforced safety boundaries.

Live `scripts/ship-jarvis-hotfix.sh` is the one remediation exception. The
helper requests an internal `jarvis-remediation` policy, and the wrapper accepts
that policy only when the resolved guarded command is the canonical hotfix
entrypoint under the same repo root. It skips only the managed Jarvis health
probe because an unhealthy service or its planned restart is the object of the
repair. Memory, CPU, Tailscale, machine-wide serialization, process-group
supervision, and the narrower release lock remain enforced. No ambient
environment variable can select remediation policy.

Read-only `--help`, release `--dry-run`, and release `--authorize` paths remain
outside the expensive slot where their entrypoint contract guarantees that
they do not build, package, deploy, restart, or publish. Executed release lanes
always acquire locks in this order:

1. machine-wide heavy-local slot (the operational reservation);
2. canonical Jarvis release lock.

Canonical self-guarding includes the shared runtime build/deploy/restart lanes,
main-gateway shipping, worktree creation/bootstrap/prewarm, and the existing
package/release entrypoints. It also includes direct macOS build/run, consumer
app launch and UI smoke, Open Computer Use bootstrap, tester Telegram runtime
management, Sparkle apply, shared restart smoke, and Jarvis/shared-main live
Telegram acceptance. A nested canonical call reuses the outer lease only
through the verified ancestry contract above.

`openclaw gateway restart` is a packaged CLI boundary, not only a repository
shell entrypoint. On macOS its complete mutation transaction re-executes through
the same wrapper, and the npm/runtime package therefore includes the canonical
lifecycle command, wrapper, lease helper, and session runner. The detached
launchd handoff acquires that lease independently and publishes an admission
receipt before restart is reported as scheduled. Missing packaged helpers fail
closed with exit `75`; they never downgrade to raw signal, bootstrap, or
kickstart.
The narrow `gateway-lifecycle` admission policy skips managed Jarvis health
only when the validated target is exactly `ai.jarvis.gateway`, because that
restart may block or close the listener while acquiring the lease. Restarts of
default or isolated OpenClaw profiles still require healthy Jarvis. CPU,
memory, remote-access, ownership, ancestry, stale recovery, and runtime
monitoring remain enforced.

This one lease is also the deterministic operational reservation for package,
release, deploy, restart, and live-runtime campaigns. Public Jarvis release
work then acquires the narrower canonical release lock second. Keeping one
machine-wide first lock avoids deadlock and prevents a lightweight live
acceptance script from racing a heavier package or restart.

Mechanical coverage is intentionally bounded to canonical repository
entrypoints. Shell builtins cannot intercept an arbitrary direct `pnpm test`,
`pnpm build`, `swift test`, `xcodebuild`, `launchctl`, manually executed Node
runtime, or third-party tool. Run those commands through
`scripts/with-heavy-local-slot.sh`; do not claim the repository makes arbitrary
shell execution impossible. Old clones remain unprotected until refreshed.

## Proof boundaries and rollout limits

- The generic `http://127.0.0.1:18789/healthz` probe proves that something
  healthy answers on the managed port. It does not by itself bind that response
  to the PID or commit intended for a deployment. Runtime-specific ship/proof
  scripts must keep their deeper PID, source, commit, RPC, and end-user checks.
- This contract takes effect only after a clone has refreshed these helper and
  entrypoint changes. An old clone or long-running old wrapper retains its older,
  weaker behavior until updated or restarted. During rollout, do not infer that
  every local clone is protected merely because one clone contains this patch.
- New helpers intentionally fail closed when they encounter incomplete or
  legacy child-session metadata. That prevents unsafe overlap, but it may
  require operator inspection and cleanup of a lease created during the
  transition.

## Resume sequence after an incident

1. Stop every heavy local command.
2. Verify Tailscale, remote desktop, and Jarvis health.
3. Wait for two healthy host snapshots.
4. Resume one light source-only lane.
5. Admit one focused heavy command through the wrapper.
6. Observe host and Jarvis health before admitting the next command.

Do not restore twelve-way heavy concurrency. Parallelize reasoning and source
edits; serialize expensive proof and send full validation to CI.
