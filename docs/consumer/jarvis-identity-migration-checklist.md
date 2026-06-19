# Jarvis Identity Migration Checklist

Status: active migration checklist
Owner: Artem
Last updated: 2026-06-19

Purpose: move broad-public Jarvis runtime identity away from OpenClaw-branded
defaults without breaking trusted-tester/debug lanes or the shared main runtime.

## Now

- [x] Broad-public bundle ID defaults to `ai.jarvis.mac`.
- [x] Default public state path resolves to `~/Library/Application Support/Jarvis/.jarvis`.
- [x] Default public gateway LaunchAgent resolves to `ai.jarvis.gateway`.

## Gates

- [x] Keep trusted-tester/debug/RC identities on `ai.openclaw.consumer.mac.*`.
- [x] Keep named worktree/tester runtime lanes isolated from public Jarvis defaults.
- [x] Keep the config filename `openclaw.json`.
- [x] Keep `openclaw-consumer` / internal `openclaw://` URL handling deferred.
- [x] Do not build a general automatic migration tool for v1; inactive testers
      can clean install, and serious users get a manual runbook after Artem's
      migration is proven.
- [ ] Do not touch Artem's real app, state, or shared gateway until fake-home and
      package proof pass.

## Proof

- [x] Fake-home TS tests cover Jarvis default state path and old isolated lanes.
- [x] Fake-home Swift tests cover Jarvis default state path and old isolated lanes.
- [x] Fake-home tests cover Jarvis default LaunchAgent label.
- [x] Package proof verifies `CFBundleIdentifier=ai.jarvis.mac`.
- [x] Package proof verifies app env points at Jarvis state and `ai.jarvis.gateway`.
- [x] Sparkle/appcast guard proof blocks generic OpenClaw appcast for Jarvis.
- [x] Local package proof builds only `dist/Jarvis.app`; it does not install,
      launch, migrate state, or touch the shared gateway.
- [x] Local Sparkle freshness guard passes with `2026.6.19` build `2026061990`
      against installed build `2026061317`.
- [ ] Full Sparkle update proof passes through the public appcast and
      About -> Check for Updates.

## Deferred

- [ ] Write Artem's manual migration runbook after his migration is proven.
- [ ] Write user-facing migration runbook after real migration proof exists.
- [ ] Clean up old OpenClaw-branded consumer docs after code/package proof lands.
