# macOS memory-pressure observer

This is an Artem-specific host-health integration with reusable configuration.
It is not a product default and does not change the heavy-work guard.

The observer samples macOS every five minutes. It uses the same enforced truths
as the heavy-work guard: platform memory pressure and the fixed 25% headroom
floor. Swap, pageout, and swapout counters are diagnostic history only; a large
absolute value is never a reboot trigger.

After two consecutive unhealthy samples it sends one Telegram warning through
the installed Jarvis notification wrapper. Critical escalation sends once per
episode. Two healthy samples close the episode and send one recovery note. A
weekly Sunday health report is sent at or after 10:30 local time.

The observer never kills processes, restarts Codex, restarts Jarvis, or reboots
the Mac. Its recovery order is: close finished work, restart Codex when safe,
then consider a Mac restart only if pressure remains unhealthy.

```bash
bash scripts/install-macos-memory-pressure-observer.sh install --dry-run
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
