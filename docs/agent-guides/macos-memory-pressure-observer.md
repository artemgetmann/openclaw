# macOS memory-pressure observer

This is an Artem-specific host-health integration with reusable configuration.
It is not a product default and does not change the heavy-work guard.

The observer samples macOS every five minutes. The internal heavy-work guard
continues to react to platform memory pressure independently. User-visible FYI
warnings require measured memory headroom below the fixed 25% floor for six
consecutive samples; a transient kernel warning with ample headroom stays
silent. Swap, pageout, and swapout counters are diagnostic history only; a
large absolute value is never a reboot trigger.

Critical pressure still confirms after two consecutive samples. Twelve healthy
samples close an episode and produce at most one recovery note. Notifications
are at-most-once attempts: an ambiguous wrapper failure is recorded but never
replayed automatically. Routine weekly healthy reports are intentionally
suppressed.

Set `OPENCLAW_MEMORY_OBSERVER_THREAD_ID` during installation; installation
fails closed without it so memory notifications cannot fall back to a general
chat. The topic identifier is stored as an explicit LaunchAgent argument and
reused by `run-now`; it is never hard-coded in the portable source.

The observer never kills processes, restarts Codex, restarts Jarvis, or reboots
the Mac. Its recovery order is: close finished work, restart Codex when safe,
then consider a Mac restart only if pressure remains unhealthy.

```bash
OPENCLAW_MEMORY_OBSERVER_THREAD_ID=<topic-anchor> \
  bash scripts/install-macos-memory-pressure-observer.sh install --dry-run
OPENCLAW_MEMORY_OBSERVER_THREAD_ID=<topic-anchor> \
  bash scripts/install-macos-memory-pressure-observer.sh install
bash scripts/install-macos-memory-pressure-observer.sh status
bash scripts/install-macos-memory-pressure-observer.sh run-now --dry-run
bash scripts/install-macos-memory-pressure-observer.sh uninstall
```

Runtime state is owner-only under Jarvis app-support state. Logs contain only
bounded health telemetry and notification outcomes; no tokens or unrelated
process arguments are recorded. Installation copies the observer into the same
stable app-support directory, so removing a temporary source worktree cannot
break the scheduled job.
