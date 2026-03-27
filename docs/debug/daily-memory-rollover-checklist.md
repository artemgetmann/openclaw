# Daily Memory Rollover Checklist

- [ ] Trust model is explicit: owner-only contexts are `personal`, mixed/shared contexts are `shared`
- [ ] Personal sessions can auto-load `MEMORY.md`
- [ ] Shared sessions never auto-load personal `MEMORY.md`
- [ ] Personal sessions inject `memory/YYYY-MM-DD.md` for today + yesterday when present
- [ ] Shared sessions never inject daily notes from the personal memory lane
- [ ] First personal inbound after the 4am boundary writes one agent-wide daily snapshot for the closed window
- [ ] Snapshot aggregation scans all personal sessions/topics for the agent, not only the triggering thread
- [ ] Triggering session rotates after the boundary so startup runs again in active threads
- [ ] Shared/group transcripts do not leak into personal daily snapshots
- [ ] Build + focused tests pass before checkpoint commit
- [ ] Create a checkpoint commit immediately after the first green slice
