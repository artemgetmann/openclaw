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

On macOS the wrapper currently refuses admission when:

- another heavy command owns the slot;
- system memory headroom is below 25%;
- CPU idle capacity is below 35%;
- configured Tailscale is disconnected; or
- the managed Jarvis gateway is installed but unhealthy.

Refusals retain exit code `75` for compatibility and also emit a stable line:

```text
HEAVY_LOCAL_SLOT_REFUSAL class=<occupied|host_unhealthy|guard_internal> code=<reason> [measurement fields]
```

The class separates normal serialization, measured host pressure, and failures
inside the guard or its measurement backends. The following human line retains
the useful owner, PID, measurement, or recovery detail. A bounded wait that
expires emits the last retryable class with `code=wait_timeout`.
Measured CPU, memory, Tailscale, and Jarvis refusals also expose stable
`metric`, `observed`, `threshold`, `expected`, and `unit` fields when relevant.
These are refusal telemetry, not a complete capacity profile.

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

The 25% memory threshold, 35% admission CPU-idle threshold, 20% runtime
CPU-idle threshold, 15-second interval, two-strike stop rule, and three-second
health timeout remain fixed product policy in this revision. Environment
variables cannot lower, disable, corrupt, or stretch them.

## Dedicated-host capacity policy

The one-heavy lease is a failure-containment boundary, not interactive-headroom
policy. It remains machine-wide for every profile.

Current protection is narrower than the failure list:

- CPU: admission and runtime CPU-idle checks plus background scheduling and
  reduced priority. There is no direct thermal-pressure or shutdown-risk probe.
- Memory: `memory_pressure` accounts for compression, but the guard does not
  separately bound swap size or swap-growth rate.
- Disk: retention tooling can report pressure, but admission has no free-space
  or exhaustion check.
- Availability: configured Tailscale connectivity and managed Jarvis HTTP
  health are checked. VNC or another remote-desktop path is not probed directly.
- Overlap: the machine-wide lease and process-group supervision prevent two
  guarded heavy trees from running concurrently.

That evidence does not justify lowering CPU or memory thresholds yet. Doing so
would replace an interactive-headroom guess with a thermal, swap, and disk
guess. The dedicated-host profile stays deferred until this bounded experiment
is completed in a separate PR:

1. Add a read-only sampler that records monotonic time, CPU idle,
   `memory_pressure`, `vm.swapusage`, Data-volume free space, macOS thermal
   state, Tailscale state, Jarvis health, and the structured guard reason. It
   must redact command arguments and environment values.
2. Run representative Node, Swift/Xcode, browser, and package workloads one at
   a time under the existing lease. Record admission, every 15-second runtime
   sample, workload exit, and any Jarvis or remote-access interruption.
3. Establish stop limits from the first observed thermal, swap-growth, disk, or
   availability degradation, then apply an explicit safety margin. A threshold
   change is invalid if no failure boundary was observed.
4. Add a named, non-ambient dedicated-host policy that can raise utilization
   only while thermal, swap, disk, Tailscale, Jarvis, serialization, and
   process-tree checks remain enforced. Repeat deterministic guard tests and a
   bounded host soak before making it default.

Until that experiment exists, queue/wait removes coordination waste without
claiming more safe machine capacity than the guard can prove.

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
