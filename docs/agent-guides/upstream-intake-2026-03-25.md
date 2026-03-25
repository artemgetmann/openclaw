# Upstream Intake Report

Date: 2026-03-25

## Snapshot

- `origin/main...upstream/main`: ahead `267`, behind `2508`
- `origin/codex/consumer-openclaw-project...origin/main`: ahead `67`, behind `25`
- `origin/codex/consumer-openclaw-project...upstream/main`: ahead `309`, behind `2508`
- `origin/consumer` does not exist; docs that still refer to it are stale

This report is intentionally filtered. It screens recent upstream changes for fork relevance; it is not a full audit of all `2508` missing upstream commits.

## Port next

| Upstream commit                                                                                          | Date       | Why it matters                                                                                                                             | Target              | Method                                                        |
| -------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- | ------------------------------------------------------------- |
| `247f82119c` `fix: improve Telegram 403 membership delivery errors`                                      | 2026-03-25 | Telegram is the primary product surface. Better 403 handling improves diagnosis and recovery when the bot loses membership or send rights. | both                | cherry-pick to `main`, then cherry-pick to consumer if clean  |
| `149c4683a3` `fix: scope Telegram pairing code blocks`                                                   | 2026-03-25 | Pairing and onboarding copy should render cleanly in Telegram. This is small, user-facing, and directly relevant to setup flow.            | both                | cherry-pick                                                   |
| `30e80fb947` `fix: isolate channel startup failures`                                                     | 2026-03-24 | One broken channel should not brick gateway startup. That is high leverage for both fork stability and consumer onboarding.                | both                | cherry-pick to `main`, then forward                           |
| `1d7cb6fc03` `fix: close sandbox media root bypass for mediaUrl/fileUrl aliases`                         | 2026-03-24 | Hardens outbound media handling on a path the fork actively uses. This is worth taking even without a visible symptom.                     | main, then consumer | cherry-pick to `main`; forward after consumer-path validation |
| `6c44b2ea50` `fix(cli): guard channel-auth against prototype-chain pollution and control-char injection` | 2026-03-23 | Hardens auth/onboarding CLI input handling without dragging in unrelated work.                                                             | main                | cherry-pick                                                   |

## Manual-port candidates

| Upstream commit                                                                                                                   | Date       | Why it matters                                                                                                                                          | Target               | Method                                                        |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------- |
| `3a4c860798` `fix(gateway): pin channel registry at startup to survive registry swaps`                                            | 2026-03-24 | Relevant to minimal startup and plugin/runtime stability.                                                                                               | main, maybe consumer | manual port as part of a cluster                              |
| `ef5e554def` `fix(gateway): invalidate channel caches on re-pin`                                                                  | 2026-03-25 | Same failure family as registry pinning. Small alone, but safer as part of the same cluster.                                                            | main, maybe consumer | manual port as part of a cluster                              |
| `03dc287a29` `fix: keep minimal gateway channel registry live`                                                                    | 2026-03-25 | This overlaps fork-specific minimal-startup/browser work already landed on `origin/main` in `7087f93a2a`. Worth taking, but not as a blind cherry-pick. | main, maybe consumer | manual port with overlap review                               |
| `1c9f62fad3` `fix(gateway): restart sentinel wakes session after restart and preserves thread routing`                            | 2026-03-25 | Valuable for long-lived Telegram sessions and restart recovery, but it is a large multi-file runtime change.                                            | main first           | manual port after reproducing or confirming the failure class |
| `cb58e45130` `fix(security): resolve Aisle findings — skill installer validation, terminal sanitization, URL scheme allowlisting` | 2026-03-24 | Good hardening for skills and UI surfaces, but it touches fork-changed UI paths and should be reviewed carefully here.                                  | main                 | manual port                                                   |

## Ignore for now

| Upstream commit                                                                               | Date                     | Why not now                                                                                     | Target         | Method |
| --------------------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------- | -------------- | ------ |
| `e5d0d810e1` `fixes for cli-containerized`                                                    | 2026-03-25               | Useful for container deployments, but this fork is currently Mac-first and local-runtime-first. | ignore         | skip   |
| `762fed1f90` `fix(daemon): add headless server hints to systemd unavailable error`            | 2026-03-24               | Linux ergonomics only. No current consumer payoff.                                              | ignore         | skip   |
| `793b36c5d2` / `09a4453026` LanceDB embeddings bootstrap fixes                                | 2026-03-24 to 2026-03-25 | Relevant only if this fork is actively blocked on the LanceDB path. Not enough signal yet.      | ignore for now | skip   |
| Discord, WhatsApp, pricing, doc-copy, and test-collapse commits from 2026-03-24 to 2026-03-25 | 2026-03-24 to 2026-03-25 | Not on the current product critical path.                                                       | ignore         | skip   |

## Notes

- The gateway channel-registry fixes should be reviewed against `7087f93a2a` on `origin/main` before any port. That fork commit already addresses related minimal-startup behavior.
- The next intake cycle should stay small: pick 2-3 of the `Port next` items, validate, land, then reassess.
