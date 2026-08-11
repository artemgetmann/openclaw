# Fleet resource control

The Mac is primarily an agent workstation. Ordinary isolated development work
must run concurrently. Resource control exists to prevent machine damage and
conflicting shared-state mutation, not to serialize every expensive command.

## Default: no machine-wide slot

Run these directly in their own worktree:

- focused or broad tests;
- typechecks, lint, formatting, and Codex review;
- source builds and generated-code checks;
- dependency installation;
- independent read-only analysis;
- isolated gateway, browser, or app fixtures that use distinct ports, profiles,
  state directories, and output paths.

Two or more of these jobs may run concurrently. Each command should keep its
own worker count reasonable, and remote CI remains preferred for broad matrices.
Do not acquire `with-heavy-local-slot.sh` for ordinary work, do not create a
long-lived waiter, and do not wake another chat merely because a test is busy.

## Exclusive lane

Use one narrow machine-wide exclusive transaction only when concurrent owners
could mutate the same protected resource or invalidate each other's proof:

- package, sign, notarize, publish, or install;
- the default/shared Jarvis or OpenClaw runtime and gateway;
- launchd ownership, shared ports, or shared app-support state;
- protected release artifacts and release metadata;
- bounded live/external acceptance that claims a shared bot, account, GUI, or
  provider resource;
- explicit workstation cleanup or repair that mutates shared fleet state.

Use the canonical wrapper around the complete mutation and its cleanup:

```bash
scripts/with-heavy-local-slot.sh \
  --label "<thread-id>:<exclusive-purpose>" \
  -- <command> <args...>
```

Do not split preflight, mutation, proof, and cleanup across separate leases.
Do not bypass an active legitimate owner. A queued shell does not wake a
finished model turn, so prefer starting exclusive work only when the lane is
available. If the client yields, use a continuation mechanism already proven
for that exact task or report the dependency honestly; never burn tokens with
model-driven polling.

The wrapper remains fail-closed for ambiguous owner identity, authorization
failure, runtime-health termination, and internal guard errors. After an
ambiguous external effect, inspect state before any retry.

## Severe host safety stops

Concurrent ordinary work should stop or reduce load only on measured severe
host pressure. The evidence must identify the actual signal, not merely that
another command is running.

Stop new local work when any of these are true:

- the data volume is at the repository's severe disk floor or writes are
  failing from capacity;
- memory pressure is critical, paging is growing materially across observations,
  or the kernel is killing workloads;
- thermal state is serious/critical or the thermal probe itself fails closed
  for a protected operation;
- Jarvis health degrades while local load is the plausible cause;
- a required shared resource has an active exclusive owner.

Prefer reducing per-command workers, letting an admitted command finish, or
moving broad proof to CI. Do not treat ordinary CPU utilization, a warm cache,
or one healthy concurrent build as a fleet incident.

## Disk recovery

Preserve useful source first: commit and push recoverable work. Hourly
`ai.openclaw.worktree-gc` owns routine deletion of eligible worktrees and
artifacts. Do not launch competing cleanup loops from multiple chats.

If disk pressure is already severe and blocks safe work, inspect before
deleting. Use the repository GC tooling for eligible artifacts, keep active or
dirty worktrees, and re-measure the disk floor after cleanup. A cleanup receipt
may justify resuming the same command; it does not grant new runtime, release,
credential, or destructive authority.

## Isolation rules

Concurrency is safe only when jobs do not share mutable state:

- use separate Git worktrees and output directories;
- use explicit isolated gateway profiles, configs, state directories, and
  ports for unmerged runtime proof;
- never point a feature worktree at the default shared gateway or primary bot;
- keep app packaging, installation, signing identities, notarization, and
  shared live acceptance in the exclusive lane;
- avoid duplicate owners for the same issue or external scenario.

The resource model is intentionally simple: parallel by default, exclusive only
for shared mutation, and fail closed only on concrete severe safety evidence.
