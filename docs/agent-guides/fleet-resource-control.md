# Local fleet resource control

The founder's Mac is an interactive workstation and the production Jarvis host.
Remote desktop, Tailscale, and Jarvis responsiveness outrank local agent
throughput.

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

## Required wrapper

Run every heavy command through the shared slot:

```bash
scripts/with-heavy-local-slot.sh --label "<thread-id>:<purpose>" -- \
  pnpm vitest run path/to/focused.test.ts --maxWorkers 1
```

Use the read-only preflight before assigning the slot:

```bash
scripts/with-heavy-local-slot.sh --label "<thread-id>:preflight" --check
```

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

On macOS the wrapper refuses admission when:

- another heavy command owns the slot;
- system memory headroom is below 25%;
- CPU idle capacity is below 35%;
- configured Tailscale is disconnected; or
- the managed Jarvis gateway is installed but unhealthy.

Admitted commands run with background scheduling and reduced process priority.
While the command runs, the wrapper rechecks the host every 15 seconds. Two
consecutive unhealthy samples stop only the guarded command and its worker tree
before VNC, Tailscale, or Jarvis can remain starved for minutes. The slot is
released when the command exits. Exit code `75` means "temporarily unavailable"
or "stopped to protect host health"; wait for recovery instead of bypassing the
guard.

The 25% memory threshold, 35% admission CPU-idle threshold, 20% runtime
CPU-idle threshold, 15-second interval, two-strike stop rule, and three-second
health timeout are fixed product policy. Environment variables cannot lower,
disable, corrupt, or stretch them.

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

1. machine-wide heavy-local slot;
2. canonical Jarvis release lock.

Canonical self-guarding includes the shared runtime build/deploy/restart lanes,
main-gateway shipping, worktree creation/bootstrap/prewarm, and the existing
package/release entrypoints. A nested canonical call reuses the outer lease only
through the verified ancestry contract above.

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
