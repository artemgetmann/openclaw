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

The wrapper stores an atomic lease in Git's common directory, which is shared
by every worktree in the clone. On macOS it refuses admission when:

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

## Resume sequence after an incident

1. Stop every heavy local command.
2. Verify Tailscale, remote desktop, and Jarvis health.
3. Wait for two healthy host snapshots.
4. Resume one light source-only lane.
5. Admit one focused heavy command through the wrapper.
6. Observe host and Jarvis health before admitting the next command.

Do not restore twelve-way heavy concurrency. Parallelize reasoning and source
edits; serialize expensive proof and send full validation to CI.
