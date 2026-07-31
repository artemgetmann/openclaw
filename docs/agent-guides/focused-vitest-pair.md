# Focused Vitest pair

`scripts/run-focused-vitest-pair.sh` is a one-shot, named exception for one
measured workload pair. It does not raise the generic heavy-local capacity:
unknown work, broad tests, Xcode, browser work, packaging, deployment, runtime
operations, restarts, and live tests remain exclusive beneath
`scripts/with-heavy-local-slot.sh`.

## Exact profile

The profile runs exactly these two jobs concurrently beneath one canonical
heavy-local supervisor:

- Durable monitor authority: the five fixed Vitest files declared in the
  script.
- Channels status JSON contract: the one fixed Vitest file declared in the
  script.

Each job is forced to `--maxWorkers 1 --no-file-parallelism`. The entrypoint
accepts no command, test-path, worker-count, policy, runtime, package, Xcode, or
deployment arguments. No environment variable selects the profile or turns
generic capacity into two slots.

## Run it

Use two distinct, clean, fully prepared Git worktrees whose pinned local Vitest
executables already exist. Choose a new absolute receipt directory so prior
evidence cannot be overwritten:

```bash
scripts/run-focused-vitest-pair.sh \
  --label "<thread-id>:focused-pair" \
  --job-a-root "/absolute/path/to/monitor-worktree" \
  --job-b-root "/absolute/path/to/channels-worktree" \
  --receipt-dir "/absolute/path/to/new-receipt-directory"
```

The public entrypoint validates its closed argument surface, then re-executes
under one canonical `with-heavy-local-slot` transaction. The guarded pass
revalidates both clean worktrees, test files, and pinned Vitest executables
before starting either child. Existing admission floors, Jarvis/Tailscale
health checks, runtime sampling, process-session identity, and whole-group
TERM/KILL cleanup remain owned by the canonical wrapper.

The receipt directory contains `receipt.env`, `job-a.log`, and `job-b.log`.
The structured receipt binds both Git heads, direct child PIDs and exit codes,
the fixed worker/file-parallelism limits, and the unchanged generic-capacity
statement. A nonzero child or signal produces a non-passing receipt and a
nonzero entrypoint exit.

Do not reproduce this shape with two separate wrapper calls: that would create
two owners, lose the measured one-supervisor contract, and race machine-wide
serialization. New workload combinations require their own measurement and
repository review; they are not arguments to this profile.

## Coordinate the one heavy owner directly

Before requesting the pair, identify the current canonical heavy-local owner
from the guard refusal. The waiting owner asks that exact owner to send one
direct material-release callback after its process group is gone, owner
metadata is removed, and fresh admission is possible. The waiting owner does
not poll the guard, route routine acknowledgments through a coordinator, delete
lease state, retry a refusal, or bypass admission. If another legitimate owner
wins before the callback is used, stop and request the next direct release from
that owner.

Pairing is allowed only through this entrypoint and only for its two explicitly
compatible focused-test jobs. Generic and unknown workloads remain serialized
at capacity one. This human callback contract is deliberately repository-local
documentation, not a daemon, broker, queue, dispatcher, bot, scheduler, or
service.
