# Jarvis Identity Migration Checklist

Status: active closeout checklist
Owner: Artem
Last updated: 2026-06-24

Purpose: move broad-public Jarvis runtime identity away from OpenClaw-branded
defaults without breaking trusted-tester/debug lanes or the shared main runtime.

## Current Truth

- [x] PR #953 is merged: broad-public defaults use `ai.jarvis.mac`, Jarvis
      state, and `ai.jarvis.gateway`.
- [x] PR #960 is merged: packaged `ai.jarvis.gateway` can own Jarvis config
      without the noncanonical shared-runtime override, and Jarvis repair
      disables stale OpenClaw gateway LaunchAgents.
- [x] Local manual migration/install proof exists.
- [x] Current public package/appcast proof exists for `2026.6.24`, build
      `2026062402`, from current `main`.
- [x] Clean shipped-build smoke passed on the public `2026062402` DMG with
      isolated fake-home state and unchanged real user config.
- [x] Real migrated-user proof found one missing legacy Telegram group allowlist
      carry-over; manual non-secret config migration restored group replies.

## Remaining Gates

- [ ] Open the narrow legacy Telegram group allowlist migration PR.
- [ ] Decide whether old trusted-tester state starts clean under
      `ai.jarvis.mac` or gets a small manual migration runbook.

## Keep True

- Trusted-tester/debug/RC identities stay on `ai.openclaw.consumer.mac.*`.
- Named worktree/tester runtime lanes stay isolated from public Jarvis defaults.
- The config filename stays `openclaw.json`.
- `openclaw-consumer` and internal `openclaw://` URL handling stay deferred.
- Broad-public proof must not take over the sacred `ai.openclaw.gateway`.

## Done

- [x] Fake-home TS/Swift tests cover Jarvis defaults and old isolated lanes.
- [x] Package proof verified `CFBundleIdentifier=ai.jarvis.mac`, Jarvis state,
      and `ai.jarvis.gateway`.
- [x] Sparkle/appcast guard blocks generic OpenClaw appcast use for Jarvis.
- [x] Local package proof builds `dist/Jarvis.app` without installing,
      launching, migrating state, or touching the shared gateway.
- [x] Public appcast proof reached the old installed app and downloaded the
      `2026.6.19` update; install still needs full-cycle proof.
- [x] Manual install proof replaced `/Applications/Jarvis.app` with
      `ai.jarvis.mac` and kept the shared `ai.openclaw.gateway` on sacred
      `main`.
- [x] Fresh installed app proof verified `ai.jarvis.gateway`, Jarvis state,
      #960 behavior, and no `OPENCLAW_ALLOW_NONCANONICAL_SHARED_RUNTIME`
      LaunchAgent override.

## Deferred

- [ ] Write user-facing migration runbook after real migration proof exists.
- [ ] Clean up old OpenClaw-branded consumer docs after code/package proof lands.
