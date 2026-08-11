# Fleet resource control

The Mac is primarily an agent workstation. Parallel work is the default.
Resource control prevents measured machine damage and simultaneous mutation of
the same shared resource; it does not serialize work merely because it is
expensive.

## Ordinary work has no machine lock

Run these directly in their own worktree:

- focused or broad tests;
- typechecks, lint, formatting, and Codex review;
- source builds and generated-code checks;
- dependency installation and worktree preparation;
- independent read-only analysis;
- isolated gateway, browser, or app fixtures with distinct ports, profiles,
  state directories, and output paths;
- ChatGPT or provider authentication through the supported UI or CLI.

Keep local worker counts reasonable and prefer remote CI for broad matrices.
Authentication normally updates the provider profile/config and rechecks
readiness; it does not acquire a fleet lock or restart the shared gateway under
the default hybrid reload policy. An explicit `gateway.reload.mode=restart` or
a separate stale-runtime repair remains shared gateway work.

## Lock only the resource being changed

Use a named lock only when two operations could mutate the same protected
resource or invalidate each other's proof:

- `release-jarvis`: protected release artifacts, signing/notarization,
  publication, and release metadata;
- `gateway-main`: default/shared Jarvis runtime, gateway, launchd ownership,
  and shared ports;
- `app-install`: installation or replacement of the same app instance;
- `live-telegram-main`: bounded acceptance that claims the primary bot/account.

Canonical entrypoints select these names themselves. For a new protected
entrypoint, wrap only the complete shared mutation and its cleanup:

```bash
scripts/with-shared-resource-lock.pl \
  --resource <resource-name> \
  --label <diagnostic-purpose> \
  -- <command> <args...>
```

The operating system owns the lock. It is released automatically when the
guarded process exits or is killed. The persistent lock file contains no PID,
thread ID, or owner record and can never become a stale lease. An ephemeral
capability only proves that a nested command inherited the exact locked file;
it grants nothing without that descriptor. Labels are diagnostics only.

Native Codex thread delivery, wakeups, and chat cleanup must never be required
to acquire, release, or recover a resource.

Different resources run concurrently. Package/build staging should use unique
output directories and remain lock-free; acquire `release-jarvis` only for the
protected artifact/publication transaction. Do not invent a global fallback
resource for an unclassified operation.

The historical `scripts/with-heavy-local-slot.sh` remains a compatibility
frontend for packaged callers. It maps known protected operations onto the
named locks above. Do not add new callers to it.

## Severe host safety stops

Concurrency limits, not locks, handle resource pressure. Stop or reduce new
local work only on measured severe evidence:

- the data volume is at the severe floor or writes fail from capacity;
- memory pressure is critical, paging grows materially, or the kernel kills
  workloads;
- thermal state is serious/critical;
- Jarvis health degrades and local load is the plausible cause.

Prefer fewer workers, lower process priority, remote CI, or letting admitted
work finish. Ordinary CPU use, a warm cache, or one healthy build is not a fleet
incident.

## Isolation and cleanup

- use separate worktrees and output directories;
- use explicit profiles/config/state/ports for unmerged runtime proof;
- never point a feature worktree at the default shared gateway or primary bot;
- use the same named resource for mutation, proof, and exact cleanup;
- use hourly `ai.openclaw.worktree-gc` for routine worktree/artifact cleanup;
- after an ambiguous external effect, inspect state before retrying the effect.

The model is intentionally small: parallel by default, four named shared
resources, OS-owned cleanup, and no conversational recovery protocol.
