# Jarvis Identity Migration Checklist

Status: active closeout checklist
Owner: Artem
Last updated: 2026-06-21

Purpose: move broad-public Jarvis runtime identity away from OpenClaw-branded
defaults without breaking trusted-tester/debug lanes or the shared main runtime.

## Current Truth

- [x] PR #953 is merged: broad-public defaults use `ai.jarvis.mac`, Jarvis
      state, and `ai.jarvis.gateway`.
- [x] PR #960 is merged: packaged `ai.jarvis.gateway` can own Jarvis config
      without the noncanonical shared-runtime override, and Jarvis repair
      disables stale OpenClaw gateway LaunchAgents.
- [x] Local manual migration/install proof exists.
- [ ] A new package from current `main` still needs build/install proof. Do not
      claim the installed/public app contains #960 before that.

## Remaining Gates

- [ ] Build/install a fresh Jarvis package from current `main`; prove #960 in
      the installed app.
- [ ] Complete full Sparkle update install proof through the public appcast and
      About -> Check for Updates.
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

## Deferred

- [ ] Write user-facing migration runbook after real migration proof exists.
- [ ] Clean up old OpenClaw-branded consumer docs after code/package proof lands.
