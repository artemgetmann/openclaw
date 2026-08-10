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
  --job-a-head "<40-character-commit>" \
  --job-b-root "/absolute/path/to/channels-worktree" \
  --job-b-head "<40-character-commit>" \
  --receipt-dir "/absolute/path/to/new-receipt-directory"
```

The public entrypoint validates its closed argument surface, then re-executes
under one canonical `with-heavy-local-slot` transaction. The guarded pass
revalidates both clean worktrees, test files, and pinned Vitest executables
before starting either child. It accepts an inherited lease only when this
entrypoint is the canonical wrapper's committed root child, so unrelated
guarded work cannot nest the pair beside sibling workloads. Existing admission
floors, Jarvis/Tailscale health checks, runtime sampling, process-session
identity, and whole-group TERM/KILL cleanup remain owned by the canonical
wrapper.

The receipt directory contains `job-a.log`, `job-b.log`, per-job
`job-{a,b}.receipt.env` files, the inner workload `receipt.env`, and the outer
`shared-health-cleanup.env`. The outer receipt is written only after the
canonical wrapper exits and its exact opaque owner token is no longer present;
it records wrapper exit, shared health, whole-group/lease cleanup, and the
unchanged generic-capacity statement. A child failure, signal, health stop, or
unproven cleanup produces a non-passing receipt and nonzero entrypoint exit.

Do not reproduce this shape with two separate wrapper calls: that would create
two owners, lose the measured one-supervisor contract, and race machine-wide
serialization. New workload combinations require their own measurement and
repository review; they are not arguments to this profile.

## Let the guarded transaction wait

Invoke the actual pair command once. The entrypoint uses a 24-hour bounded wait,
releases the lease between admission attempts, and starts the pair exactly once
when capacity is healthy. Do not preflight separately, ask the current owner for
a callback, poll from the model, or stop merely because a different legitimate
job owns the slot. A changing owner is normal scheduling, not a reason to
rebuild the wake chain.

Stop only when the wrapper reports a terminal condition: `guard_internal`, an
authorization failure, runtime health termination, or bounded-wait expiry.
Preserve that exact receipt; none of those conditions authorize bypassing the
guard or silently restarting an ambiguous workload.

Pairing is allowed only through this entrypoint and only for its two explicitly
compatible focused-test jobs. Generic and unknown workloads remain serialized
at capacity one. The bounded waiter is local to this one shell transaction. It
is not a daemon, broker, dispatcher, cross-thread callback, or second capacity
owner.
