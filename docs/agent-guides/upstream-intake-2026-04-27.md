# Upstream Intake Tracker

Date: 2026-04-27
Status: Active intake ledger

## Purpose

Track upstream OpenClaw changes that may be worth selectively porting into this fork.

This is not an implementation plan for a single PR. It is the running ledger so agents can see:

- what has been identified
- what is next
- what is in progress
- what has landed
- what was intentionally skipped

## Guardrails

- Do not merge `upstream/main`.
- Port selectively from GitHub/upstream diff evidence.
- Treat Twitter/bookmarks/social posts as hints only. Confirm every real candidate against GitHub upstream commits or PRs before adding it to the port plan.
- Keep consumer-product behavior protected:
  - Mac-first local operator
  - Telegram-first user experience
  - curated Codex/OpenAI model defaults
  - isolated consumer runtime, profile, state, config, port, and LaunchAgent behavior
- Do not pull broad upstream platform expansion unless a concrete consumer need justifies it.
- Mark each item complete only after the port lands and validation evidence is recorded.

## Status Legend

- `candidate`: worth tracking, no port work started
- `planned`: selected for a near-term port slice
- `in-progress`: implementation lane is active
- `ported`: landed in this fork
- `validated`: landed and behavior was proved with tests or live checks
- `deferred`: useful, but not now
- `skipped`: intentionally not porting

## Current Recommendation

Start with model truthfulness and Telegram visible-response hygiene.

Why: the consumer product is a Telegram-first personal operator. Broken model availability, ugly leaked tool syntax, and unreliable Telegram replies hurt the core product more than new upstream platform breadth.

## Intake Workflow

1. Use GitHub/upstream commits and PRs as the source of truth.
2. Rank candidates by consumer-product leverage.
3. Port and validate the highest-leverage slices first.
4. Update the completed log as each slice lands.
5. Final audit: review Twitter/bookmarks/social hints for potentially missed upstream changes.
6. If the final audit finds no missed high-value changes, stop using Twitter bookmarks for future intake cycles.
7. If the final audit does find missed high-value changes, keep the bookmark audit as a recurring last-step check.

## Intake Plan

| Rank | Status    | Upstream change                                                        | What changed                                                                                                                         | Upstream files                                                                                                                                                                                              | Why it matters here                                                                                      | Recommendation | First porting slice                                                                                                                                                             | Validation notes                                                         |
| ---- | --------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1    | deferred  | `#71985` `fix(models): preserve provider index catalog fallback`       | Keeps model listing sane when provider index data exists but catalog rows are incomplete or stale.                                   | `src/commands/models/list.*`, `src/model-catalog/**`                                                                                                                                                        | Fork recently changed GPT-5.5/Codex defaults. Bad model lists break onboarding and picker trust.         | defer          | Upstream provider-index/catalog layout does not exist in this fork. Reassess only if fork adopts that model-catalog path.                                                       | No local port target found on 2026-05-02                                 |
| 2    | deferred  | `#71980` `fix(codex): translate --thinking minimal to low`             | Maps legacy `minimal` thinking setting to modern Codex `low`.                                                                        | `extensions/codex/provider.ts`, `extensions/codex/src/app-server/thread-lifecycle.ts`, test                                                                                                                 | Small compatibility fix for modern Codex models.                                                         | defer          | Upstream `extensions/codex` path does not exist in this fork. Reassess against local reasoning plumbing separately.                                                             | No direct local port target found on 2026-05-02                          |
| 3    | validated | `#71933`, `90801ba400`, `f2fdb9d125` model auth/discovery truthfulness | Model auth writes respect selected agent; OpenAI/Codex transport metadata is normalized; provider IDs are normalized in auth status. | `src/commands/models/auth.ts`, `src/cli/models-cli.ts`, `extensions/openai/*`, `src/agents/pi-model-discovery.ts`, `src/gateway/server-methods/models-auth-status.ts`                                       | Prevents "available but broken" model states during setup and runtime.                                   | ported         | Ported agent-scoped model auth and OpenAI Codex stale metadata/discovery normalization. Gateway `models-auth-status` path does not exist locally.                               | Targeted tests passed 2026-05-02                                         |
| 4    | validated | `#71825`, `#71952` Telegram reply/progress UX                          | Preserves native quote replies and keeps verbose/tool progress fallback working.                                                     | `extensions/telegram/src/bot-message-dispatch.ts`, `extensions/telegram/src/bot-message-context.session.ts`, `extensions/telegram/src/bot/delivery.*`, `extensions/telegram/src/reply-parameters.ts`, tests | Telegram is the primary interface. Broken replies and missing progress make the product feel unreliable. | ported         | Ported native quote metadata propagation, quote fallback retry, and fork-equivalent tool progress fallback coverage.                                                            | Targeted tests passed 2026-05-02                                         |
| 5    | validated | `78df859e15`, `#69288` visible assistant text cleanup                  | Strips raw `<function>` tags and Anthropic/ANTML thinking tags from visible assistant text and streams.                              | `src/shared/text/assistant-visible-text.ts`, `src/agents/pi-embedded-subscribe.ts`, `src/agents/pi-embedded-utils.ts`, tests                                                                                | Tool syntax leaks damage ChatGPT/personality quality in Telegram.                                        | ported         | Ported standalone function-call block stripping and `antml:thinking` support.                                                                                                   | Targeted tests passed 2026-05-02                                         |
| 6    | validated | `ecfaf64526` host tilde path handling                                  | Aligns `~` expansion with actual OS home.                                                                                            | `src/agents/pi-tools.read.ts`, `src/agents/pi-tools.host-edit.ts`, tests                                                                                                                                    | A Mac operator must not stumble on basic local file paths.                                               | ported         | Ported host read/write/edit/recovery `~` expansion against OS home instead of `OPENCLAW_HOME`.                                                                                  | Targeted tests passed 2026-05-02                                         |
| 7    | validated | `4f00b76925`, `4bc46ccfed` context and compaction hardening            | Tightens context limits, bounds tool results, and caps compaction reserve for small models.                                          | `src/agents/agent-scope*`, `src/agents/pi-embedded-runner/**`, `src/agents/session-tool-result-guard*`, memory files                                                                                        | Long personal-agent sessions degrade without good context hygiene.                                       | ported         | Ported the safe local subset: per-agent tool-result caps, persisted tool-result truncation, and small-context compaction reserve caps. Deferred broad memory-core/config churn. | Targeted tests passed 2026-05-03; `tsgo` still has unrelated repo errors |
| 8    | validated | `77719899f3`, `4ee537a04a` gateway/node-host recovery                  | Refreshes stale embedded service tokens and keeps node-host recovering after gateway restarts.                                       | `src/cli/daemon-cli/install.ts`, `src/gateway/client.ts`, `src/node-host/runner.ts`, tests                                                                                                                  | Relevant to macOS runtime reliability, but must respect consumer runtime isolation.                      | ported         | Ported node-host reconnect recovery and gateway install stale-token refresh. Preserved runtime identity and shared-service ownership guards.                                    | Targeted tests passed 2026-05-03: 3 files, 44 tests                      |
| 9    | deferred  | `#71997` runtime dependency install hardening                          | Hardens dependency install surfaces across skills, plugins, watch-node, and runtime paths.                                           | `scripts/watch-node.mjs`, `src/agents/skills-install.ts`, `src/channels/plugins/bundled.ts`, `src/channels/plugins/read-only.ts`, tests                                                                     | Useful reliability/security work, but broad and conflict-prone.                                          | later          | Only take skills-install and bundled plugin install behavior if needed.                                                                                                         | Pending                                                                  |
| 10   | skipped   | Android/iOS/Matrix/Teams/WhatsApp/dashboard-heavy UX/TTS expansion     | Broad platform and channel expansion.                                                                                                | Many upstream platform/channel files                                                                                                                                                                        | Consumer fork is Telegram-first, Mac-first, and intentionally minimal.                                   | skip           | Revisit only if a concrete beta-user need appears.                                                                                                                              | Not applicable                                                           |

## Completed Intake Log

| Date       | Status    | Item                                     | Fork commit / PR     | Validation                                                                      | Notes                                                                                                                                                    |
| ---------- | --------- | ---------------------------------------- | -------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-02 | validated | Model auth/discovery truthfulness subset | `#591`, `6f6a59ace4` | `pnpm exec vitest run ...` aggregate targeted suite: 13 files, 253 tests passed | Ported agent-scoped auth commands and OpenAI Codex metadata/discovery normalization. `#71985` and gateway auth-status pieces had no direct local target. |
| 2026-05-02 | validated | Telegram reply/progress UX               | `#591`, `6f6a59ace4` | Aggregate targeted suite: 13 files, 253 tests passed                            | Ported native quote reply propagation, quote rejection fallback, and fork-equivalent progress fallback coverage.                                         |
| 2026-05-02 | validated | Visible assistant text cleanup           | `#591`, `6f6a59ace4` | Aggregate targeted suite: 13 files, 253 tests passed                            | Ported standalone function tool-call stripping and namespaced `antml:thinking` stripping/promoting.                                                      |
| 2026-05-02 | validated | Host tilde path handling                 | `#591`, `6f6a59ace4` | Aggregate targeted suite: 13 files, 253 tests passed                            | Ported OS-home tilde expansion for host read/write/edit and edit recovery.                                                                               |
| 2026-05-03 | validated | Context/compaction hardening             | `#593`, `bca9fabd3e` | Targeted suite: 5 files, 85 tests passed; `git diff --check` passed             | Ported per-agent tool-result caps, persisted tool-result truncation, and small-context compaction reserve caps.                                          |
| 2026-05-03 | validated | Gateway/node-host recovery               | `#595`, `6f289f9adc` | Targeted suite: 3 files, 44 tests passed; `git diff --check` passed             | Ported managed gateway reconnect timers, node-host auth-pause supervisor exits, and stale embedded gateway-token install refresh.                        |

## Active Work Log

Use this section for short handoff notes while a port is in progress.

| Date       | Item                               | Owner / lane    | State     | Notes                                                                                                                                                                    |
| ---------- | ---------------------------------- | --------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-04-27 | Intake tracker created             | Codex           | active    | Seeded from Apr 26 upstream research. No porting work started.                                                                                                           |
| 2026-05-02 | First intake implementation wave   | Codex + workers | validated | Ported model/auth subset, Telegram replies/progress, visible-text cleanup, and host tilde paths. Deferred upstream paths that do not exist in this fork.                 |
| 2026-05-03 | Context/compaction hardening slice | Codex + worker  | validated | Ported the smallest safe subset from `4f00b76925` and `4bc46ccfed`; targeted tests passed locally. Skipped memory-core excerpt bounds and generated config/schema churn. |
| 2026-05-03 | Gateway/node-host recovery mapping | Codex + worker  | mapped    | Read-only mapping found both upstream fixes are worth porting manually. Direct cherry-pick rejected because fork runtime identity and browser-proxy behavior diverge.    |
| 2026-05-03 | Gateway/node-host recovery port    | Codex + workers | validated | Ported node-host reconnect recovery and gateway install stale-token refresh; targeted tests passed locally.                                                              |

## Source Snapshot

- Upstream source of truth checked against `openclaw/openclaw`.
- Upstream `main`: `9089e6b595` on 2026-04-26.
- Fork `origin/main`: `e17271c75a` on 2026-04-26.
- Research focus:
  - ChatGPT/personality/prompt behavior
  - model support/model picker changes
  - tool/runtime reliability improvements
  - UX/app packaging changes
