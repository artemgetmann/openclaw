# Claude Backend Direction Plan

## TL;DR

Claude CLI is now the chosen long-term backend path.

The implementation has passed the practical parity gates: shared session
continuity, memory tools, browser tools, plugin tools, warm-process reuse, and a
single Codex/OpenAI-vs-Claude parity matrix.

Claude Bridge should remain only as legacy fallback/prior art unless a new
product incident proves Claude CLI cannot satisfy a required workflow.

This document is ready to retire as an active plan after the parity-matrix
script lands; keep it as evidence for the decision.

The product goal is not "Claude works differently." The goal is:

- switching from another backend to Claude should keep the same session information
- the important OpenClaw capabilities should remain available
- the prompt can be provider-compatible, but the model should still understand the same job, workspace, memory, and tool expectations

---

## Why This Plan Exists

We had three possible directions:

1. **Use Claude CLI cold per turn**
   - simpler and closer to upstream
   - real Claude Code tool/MCP behavior
   - slower follow-up turns

2. **Keep Claude Bridge**
   - fastest warm follow-up path today
   - already avoids Anthropic prompt blocks
   - custom implementation with weaker tool parity risk

3. **Make Claude Bridge fully tool-capable**
   - keeps warm subprocess speed
   - could use the same native OpenClaw MCP server
   - risks rebuilding a custom Claude CLI backend by hand

The current direction is to try to get the best of both:

- Claude CLI architecture
- Bridge-safe prompt
- loopback OpenClaw MCP tools with native MCP fallback
- warm/session-reused execution through Claude stdio

This is really a model-switching contract:

- `/codex`, Claude, and other backends may use different provider-specific prompt wording
- they should still preserve the same user-visible capabilities
- session history and important tool results should survive backend switches
- tool availability should not silently collapse just because the model changed

---

## Current Evidence

### Claude-side blocking

Plain `claude -p` works.

Full OpenClaw-style system prompt fails with Anthropic's `out of extra usage` error, even with an empty strict MCP config.

Bridge-safe condensed prompt works.

Bridge-safe condensed prompt plus native OpenClaw MCP works.

Conclusion:

- this is not normal quota exhaustion
- this is not caused by OpenClaw MCP alone
- the full OpenClaw prompt shape is the trigger

### Latency

Existing benchmark evidence already showed:

- Claude Bridge has much faster warm follow-up latency
- Claude CLI cold/resume per turn is slower

Do not rerun generic latency benchmarks unless a new implementation changes the latency model.

### Tools

Claude CLI can use upstream-style loopback OpenClaw MCP tools when:

- it uses the Bridge-safe prompt
- it runs with `--permission-mode bypassPermissions`
- the loopback server exposes the shared scoped tool registry

Current product-path proofs passed:

- `runCliAgent`
- provider `claude-cli`
- loopback MCP server connected
- `mcp__openclaw__sessions_list` was called by Claude
- assistant returned `RUNCLI_MCP_OK`
- resumed follow-up remembered the exact prior tool result
- system prompt avoided project-context injection
- direct loopback `tools/list` exposed 20 tools, including `memory_search`, `memory_get`, `web_search`, `web_fetch`, and session tools

Important nuance:

- `exec`, `process`, `read`, `write`, `edit`, and `apply_patch` are intentionally excluded from the loopback server because Claude Code already has native versions of those capabilities.
- This means parity is split: OpenClaw shared tools come from loopback MCP; Claude-native coding tools stay native to Claude CLI.

---

## Decision Bias

Bias toward **Claude CLI**, not Bridge.

Reason:

- Claude CLI is closer to upstream's backend direction.
- It already speaks Claude Code's native tool/MCP language.
- It avoids us hand-maintaining a separate Claude protocol bridge forever.
- Prompt compatibility can be handled with the Bridge-safe prompt profile.
- Tool parity should come from native MCP, not custom per-tool bridge code.

Bridge remains useful only if:

- Claude CLI cannot be warmed
- Claude CLI session continuity is worse than Bridge
- Claude CLI browser/tool behavior fails in ways Bridge can avoid

Claude CLI is not acceptable as the default if it only works for isolated one-off answers. It must behave like another model lane inside the same OpenClaw session.

---

## Architecture Target

### Implemented target in this slice

`claude-cli` should become the real Claude backend:

- Bridge-safe prompt profile by default
- loopback OpenClaw MCP server for the shared scoped tool registry
- native OpenClaw MCP fallback when loopback startup is unavailable
- stream-json parsing into OpenClaw streaming callbacks
- persisted Claude session ids for continuity
- warm execution through a long-lived Claude stdio process

### Fallback target

If Claude CLI cannot be made warm enough:

- keep `claude-bridge`
- remove fake "tools disabled" behavior
- attach the same native OpenClaw MCP server
- prove exec/browser/session continuity

Do not build a second bespoke tool system for Bridge.

---

## Next Implementation Slices

### Slice 1: Claude CLI continuity with tools

Status: passed.

Proof:

- `scripts/smoke-claude-cli-continuity.ts --live`
- turn 1 used `mcp__openclaw__sessions_list`
- turn 2 resumed the same Claude session and recalled the exact tool result and nonce
- `sonnet -> haiku` resume also passed in an earlier live run
- `haiku -> haiku` smoke passed and exited cleanly after the harness cleanup fix

Decision:

- This slice is done.
- The old exec-based smoke was removed because exec is deliberately not part of the loopback MCP surface.

### Slice 1b: Cross-backend session continuity

Status: passed for `codex-cli/gpt-5.5 -> claude-cli/haiku` after Shared Transcript Replay For Claude CLI.

Example path:

1. one backend writes or observes a nonce/tool result
2. switch to `claude-cli`
3. ask Claude to use the prior context
4. switch back to another backend if feasible

Pass condition:

- the new backend sees the relevant prior conversation state
- tool-result history is not malformed
- provider-specific prompt rewriting does not remove essential user/session information

This is the real `/codex`-style expectation: different model, same assistant context and comparable capabilities.

Earlier proof attempt:

- First attempt with `codex-cli/gpt-5.1-codex-mini` failed before the Claude turn because local Codex CLI rejected that model for the current ChatGPT account.
- Retry with `codex-cli/gpt-5.5` successfully completed the Codex setup turn.
- The follow-up `claude-cli/haiku` turn did not see the prior Codex text from the same harness session.

Command:

- `OPENCLAW_CLAUDE_CLI_CONTINUITY_LIVE=1 node --import tsx scripts/smoke-claude-cli-continuity.ts --mode codex-context --model haiku --codex-model gpt-5.5 --timeout-ms 240000`

Result:

- fail: Claude replied that it did not have access to previous backend turns in the OpenClaw session.

Fix:

- `claude-cli` now injects a bounded "Recent shared OpenClaw session history" section when the shared transcript has previous non-Claude assistant history.
- replay keeps recent user/assistant/tool-result turns as labelled text when they fit
- replay strips unsafe tool-call structure, truncates huge tool outputs, and only summarizes older turns when the replay exceeds budget
- resumed Claude-native follow-ups without newer non-Claude turns skip replay so Claude does not receive duplicate native memory

Proof after fix:

- `OPENCLAW_CLAUDE_CLI_CONTINUITY_LIVE=1 node --import tsx scripts/smoke-claude-cli-continuity.ts --mode codex-context --model haiku --codex-model gpt-5.5 --timeout-ms 240000`
  - pass: Codex returned `CODEX_CONTEXT_SET CODEX_CONTEXT_NEEDLE_RUNCLI_d04ed29f7a2a47a1`
  - pass: Claude returned `CODEX_CONTEXT_SWITCH_OK CODEX_CONTEXT_NEEDLE_RUNCLI_d04ed29f7a2a47a1`
  - Codex total: `11365.7ms`
  - Claude first visible text: `5897.4ms`
  - Claude total: `8789.1ms`

Decision:

- This slice is done.
- `/codex -> claude-cli` continuity now has live proof for recent shared transcript replay.

### Slice 2: Claude CLI browser tool

Status: passed for `browser.status` and `browser.tabs`.

Proof:

- Direct owner loopback `tools/list` exposed `browser` plus 19 other tools.
- Live `runCliAgent` smoke used `claude-cli` + loopback MCP with non-owner scoped tools.
- Claude called `mcp__openclaw__browser` with `action="status"`, `profile="openclaw"`, and `timeoutMs=3000`.
- Loopback logs showed `tools/call` with `toolName="browser"` and `isError=false`.
- Claude returned `BROWSER_MCP_OK` with the expected nonce.
- Follow-up live smoke made Claude call `mcp__openclaw__browser` with `action="tabs"` and `profile="openclaw"`.
- Loopback logs again showed `toolName="browser"` and `isError=false`.
- Claude returned `BROWSER_TABS_MCP_OK` with the expected nonce and summarized the open tab list.

Measured result:

- model: `haiku`
- assistant start: 7387.3ms
- first visible text: 7387.3ms
- total: 9172.1ms
- Claude session id: `462cb54b-3869-495c-b6f9-dfd272ed4b64`

Blockers:

- none for `browser.status` or `browser.tabs`.
- `browser.open + browser.snapshot` is now passed after making the smoke snapshot the `targetId` returned by `browser.open` and allowing a 45s browser-tool timeout.

Additional proof:

- `OPENCLAW_CLAUDE_CLI_CONTINUITY_LIVE=1 OPENCLAW_LIVE_CLI_BACKEND_DEBUG=1 node --import tsx scripts/smoke-claude-cli-continuity.ts --mode browser-open-snapshot --model haiku --timeout-ms 240000`
  - pass: Claude called `browser.open`, then `browser.snapshot`
  - pass: loopback returned `toolName="browser"` and `isError=false` for both calls
  - pass: Claude returned `BROWSER_OPEN_SNAPSHOT_MCP_OK` with nonce `RUNCLI_ec68c8a7a5c24826`
  - total: `19555.9ms`
  - Claude session id: `77448afd-424c-486e-a9d9-1a85ffdce21b`

### Slice 2b: Memory/tool surface parity

Status: passed for `memory_search` and `memory_get`.

Direct loopback `tools/list` currently exposes:

- `browser`
- `memory_search`
- `memory_get`
- session tools
- message/gateway/agent tools
- `web_search`
- `web_fetch`

It intentionally does not expose:

- `exec`
- `process`
- `read`
- `write`
- `edit`
- `apply_patch`

Reason:

- those are Claude-native coding capabilities, not OpenClaw loopback tools
- avoiding duplicate tool names keeps Claude Code's own tool semantics intact

Proof:

- Direct owner loopback `tools/list` exposed 20 tools: `agents_list`, `browser`, `canvas`, `cron`, `gateway`, `memory_get`, `memory_search`, `message`, `monitor`, `nodes`, `session_status`, `sessions_history`, `sessions_list`, `sessions_send`, `sessions_spawn`, `sessions_yield`, `subagents`, `tts`, `web_fetch`, `web_search`.
- Direct `tools/call` for `memory_search` reached the loopback server and returned `isError=false`; the search result set was empty for query `claude backend direction smoke`.
- Live `runCliAgent` smoke made Claude call `mcp__openclaw__memory_search` exactly once.
- Loopback logs showed `tools/call` with `toolName="memory_search"` and `isError=false`.
- Claude returned `MEMORY_MCP_OK` with the expected nonce.
- Live `runCliAgent` smoke created a real temp-workspace `MEMORY.md`, made Claude call `mcp__openclaw__memory_get` with `path="MEMORY.md"`, and required Claude to echo a unique needle from the file.
- Loopback logs showed `tools/call` with `toolName="memory_get"` and `isError=false`.
- Claude returned `MEMORY_GET_MCP_OK` with the expected nonce and needle.

Measured result:

- model: `haiku`
- assistant start: 13570.2ms
- first visible text: 13570.3ms
- total: 16929.0ms
- Claude session id: `0be1e868-1132-42ab-a2db-a58df607bbcd`

Additional proof:

- Live chain smoke made Claude call `mcp__openclaw__memory_search`, then `mcp__openclaw__memory_get` in one turn.
- The search reached loopback with `isError=false`, but did not return the newly created temp-workspace memory entry.
- Claude then used the explicit fallback path `MEMORY.md`; `memory_get` reached loopback with `isError=false` and returned the expected needle.

Remaining check:

- make the Claude CLI memory-chain turn complete reliably after the deterministic temp index preflight passes

Latest focused result:

- Added explicit FTS-only memory support with `agents.*.memorySearch.provider = "none"` so fresh `MEMORY.md` files can be indexed and searched without any embedding provider or real auth profile.
- Added `src/memory/manager.fts-only-index.test.ts`; it proves `MEMORY.md` indexes and searches in FTS-only mode.
- Updated `memory-chain` smoke to:
  - create an isolated temp config/index
  - force-sync the temp memory manager before asking Claude
  - remove the old direct `MEMORY.md` fallback success path
  - point `OPENCLAW_CONFIG_PATH` at the temp config while the loopback MCP server handles the Claude turn
- Result before watchdog fix: preflight passed, but the live Claude CLI memory-chain turn could hang before MCP initialization and exceeded the requested `--timeout-ms 240000`; this exposed a separate runner/watchdog failure.
- Result after watchdog fix: the same strict smoke now fails cleanly with `FailoverError: CLI produced no output for 192s and was terminated.`
- Follow-up bisect result: the no-output failure is not specific to `memory_get`, `haiku`, or the indexed-memory prompt. A new `memory-indexed-search` smoke also no-outputed on both `haiku` and `sonnet`, and a new no-tool `temp-config-echo` smoke also no-outputed.
- Scoped loopback config checkpoint: replaced the smoke's process-wide `OPENCLAW_CONFIG_PATH` swap with a scoped in-memory MCP loopback config override experiment. Unit coverage passed, but the live `temp-config-echo` smoke still failed after MCP `initialize` returned OK and before Claude sent `notifications/initialized`, `tools/list`, or assistant output.
- Fresh continuation finding: the passing `memory` smoke and failing `temp-config-echo`/`memory-chain` paths generate the same Claude MCP overlay shape. The written `openclaw-smoke-config.json` is not read by the product path; `runCliAgent` receives the in-memory config object directly.
- Fresh bug fixed in this spike: warm Claude live sessions now own the generated MCP temp-dir cleanup. The outer `runCliAgent` cleanup was deleting the temp `mcp.json` after the first successful live turn even though the warm Claude process can stay alive and reuse that config path.
- Fresh live probe result after warming this worktree with `pnpm install --frozen-lockfile`: `OPENCLAW_CLAUDE_CLI_CONTINUITY_LIVE=1 OPENCLAW_LIVE_CLI_BACKEND_DEBUG=1 OPENCLAW_CLAUDE_CLI_LOG_OUTPUT=1 node --import tsx scripts/smoke-claude-cli-continuity.ts --mode temp-config-echo --model haiku --timeout-ms 45000` printed the Claude argv, then wedged past the 45s requested timeout and had to be killed manually. No `mcp-loopback` request logs appeared in this run.
- Follow-up fix: live Claude startup is now guarded by the same no-output budget, active turns are rejected during close races, and debug logs show spawn/stdin/stdout/timeout lifecycle checkpoints.
- Follow-up fix: loopback MCP now accepts Claude CLI's authenticated `GET /mcp` `text/event-stream` probe and delays expensive tool resolution until `tools/list` or `tools/call`.
- Follow-up fix: loopback tool resolution skips plugin discovery and keeps built-in memory tools available. This prevents plugin startup from blocking Claude parity smokes that only need OpenClaw's core loopback surface.
- `temp-config-echo` is now green with live Claude CLI: `gtimeout -k 5s 40s env OPENCLAW_CLAUDE_CLI_CONTINUITY_LIVE=1 OPENCLAW_LIVE_CLI_BACKEND_DEBUG=1 OPENCLAW_CLAUDE_CLI_LOG_OUTPUT=1 node --import tsx scripts/smoke-claude-cli-continuity.ts --mode temp-config-echo --model haiku --timeout-ms 20000` passed in 13.4s with `TEMP_CONFIG_ECHO_OK`.
- Strict `memory-chain` first moved from no-output hang to a normal model/tool result failure: one run completed but returned `MEMORY_CHAIN_SEARCH_EMPTY`.
- Strict `memory-chain` rerun is green with live Claude CLI: `gtimeout -k 5s 100s env OPENCLAW_CLAUDE_CLI_CONTINUITY_LIVE=1 OPENCLAW_LIVE_CLI_BACKEND_DEBUG=1 OPENCLAW_CLAUDE_CLI_LOG_OUTPUT=1 node --import tsx scripts/smoke-claude-cli-continuity.ts --mode memory-chain --model haiku --timeout-ms 70000` passed in 10.5s, called `memory_search`, then `memory_get`, and returned the exact nonce plus fresh memory needle without direct-path fallback.
- Strict `memory-chain` repeated green without debug logging: `gtimeout -k 5s 100s env OPENCLAW_CLAUDE_CLI_CONTINUITY_LIVE=1 node --import tsx scripts/smoke-claude-cli-continuity.ts --mode memory-chain --model haiku --timeout-ms 70000` passed in 12.9s with `MEMORY_CHAIN_MCP_OK`.
- `temp-config-echo` repeated green without debug logging: `gtimeout -k 5s 60s env OPENCLAW_CLAUDE_CLI_CONTINUITY_LIVE=1 node --import tsx scripts/smoke-claude-cli-continuity.ts --mode temp-config-echo --model haiku --timeout-ms 30000` passed in 5.8s with `TEMP_CONFIG_ECHO_OK`.
- Focused verification is green: `pnpm exec vitest run src/agents/cli-runner/claude-live-session.test.ts src/gateway/mcp-http.test.ts src/gateway/tool-resolution.test.ts src/gateway/mcp-http.loopback-runtime.test.ts src/agents/cli-runner.test.ts src/agents/claude-cli-runner.test.ts --pool=forks --maxWorkers=1` passed 6 files / 40 tests.
- Repo typecheck is not green: `gtimeout -k 5s 120s pnpm tsgo` failed on existing unrelated errors outside this slice, including stale test fixtures, voice-call import drift, and pre-existing memory provider `"none"` type drift.

Decision:

- Mark the transport/no-output blocker fixed for this spike.
- Mark strict memory-chain green: after one completed model-variance failure, two consecutive live runs passed, including one without debug logging.
- PR #586 merged this core Claude CLI parity slice into `main` as `df4eb194b38d69d50df10a2be5667fc56db54646`.
- Remaining risk is no longer a stuck backend. It is model compliance variance on the strict two-tool prompt plus the narrower rule for plugin tools: Claude CLI loopback can expose plugin tools only from the already-initialized plugin registry.
- Plugin-tool parity follow-up is now implemented as a bounded registry-only path. Loopback MCP `tools/list` must never start plugin discovery/loading; if the registry is absent, it returns core tools plus memory fallback.

### Slice 2b: Claude CLI plugin-tool parity

Status: merged and validated for the bounded loopback path.

What changed:

- `resolvePluginTools` gained a registry-only mode for call paths that must not discover or load plugins.
- `createOpenClawTools` can request plugin tools from only the already-initialized global plugin registry.
- Gateway loopback tool resolution now uses that registry-only path instead of disabling plugin tools entirely.
- `memory_search` and `memory_get` remain available as loopback fallback tools when plugin registry tools do not provide them.

Proof:

- PR #607 merged this slice into `main` as `8c4dde95d02e4ec6efc92e911de6e2edf8fef70f`.
- Focused tests passed: `pnpm exec vitest run --config vitest.unit.config.ts src/plugins/tools.optional.test.ts src/gateway/tool-resolution.test.ts` passed 1 file / 9 tests under the unit config.
- Gateway-focused tests passed: `pnpm exec vitest run --config vitest.gateway.config.ts src/gateway/tool-resolution.test.ts` passed 1 file / 2 tests.
- Format and whitespace checks passed: `pnpm exec oxfmt --check src/plugins/tools.ts src/agents/openclaw-tools.ts src/gateway/tool-resolution.ts src/plugins/tools.optional.test.ts src/gateway/tool-resolution.test.ts` and `git diff --check`.
- Direct HTTP MCP loopback smoke passed in-process with a pre-initialized plugin registry: `tools/list` returned `sessions_list`, `memory_search`, and a harmless preloaded plugin tool; `tools/call` returned `LOOPBACK_PLUGIN_TOOL_OK`; the stage log contained plugin-tool registry stages and no `plugin-loader-*` stages.
- Independent worker smoke with a trap plugin passed: plugin tool present, native `exec` excluded, and the discovery marker file stayed absent.
- Post-merge focused rerun on `main` passed: `pnpm exec vitest run --config vitest.unit.config.ts src/plugins/tools.optional.test.ts src/gateway/tool-resolution.test.ts --pool=forks --maxWorkers=1` passed 1 file / 9 tests.
- Post-merge live Claude CLI smoke passed: `gtimeout -k 5s 70s env OPENCLAW_CLAUDE_CLI_CONTINUITY_LIVE=1 node --import tsx scripts/smoke-claude-cli-continuity.ts --mode temp-config-echo --model haiku --timeout-ms 30000` returned `TEMP_CONFIG_ECHO_OK` in 9.8s.
- Post-merge live Telegram proof passed against `@Jarvis_cl4w_bot` after temporarily allowlisting `claude-cli/haiku`: `/model claude-cli/haiku` was accepted, the prompt forced `sessions_list`, the gateway logged `[agent/claude-cli] cli exec: provider=claude-cli model=haiku`, and the bot replied `CLAUDE_CLI_LOOPBACK_OK provider=claude-cli tool=sessions_list`.
- Post-merge live Telegram plugin-tool proof passed against `@Jarvis_cl4w_bot` after temporarily enabling `plugins.entries.diffs.enabled` and allowlisting `claude-cli/haiku`: the prompt forced the harmless `diffs` tool with `mode="view"`, the gateway logged `[agent/claude-cli] cli exec: provider=claude-cli model=haiku`, and the bot replied `DIFFS_PLUGIN_TOOL_OK tool=diffs mode=view viewerUrl=http://127.0.0.1:18789/plugins/diffs/view/12a47ff63044c794dfb1/be08ccdf327406dfdf4270e28af2ae111f2e171d61421835`.
- CLI-only diffs plugin proof passed: `OPENCLAW_CLAUDE_CLI_CONTINUITY_LIVE=1 node --import tsx scripts/smoke-claude-cli-continuity.ts --mode plugin-diffs --model haiku --timeout-ms 240000` enabled only the `diffs` plugin in the temp smoke config, blocked prompt injection for that plugin entry, forced `mcp__openclaw__diffs` with `mode=view`, and returned `DIFFS_PLUGIN_TOOL_OK`, the nonce, `tool=diffs`, `mode=view`, and a `/plugins/diffs/view/` viewer URL in `11168.4ms`.
- Cleanup after live proof completed: Telegram session was reset to default `openai-codex/gpt-5.4`, `plugins.entries.diffs.enabled` was restored to `false`, and the temporary `agents.defaults.models[claude-cli/haiku]` config key was removed from both the user CLI config and the app-owned gateway config.

Scope boundary:

- This slice prevents plugin discovery/import/register from blocking MCP `initialize`, `tools/list`, `tools/call`, or Claude startup.
- It does not add an async timeout around already-registered plugin tool factories. If an already-loaded plugin factory hangs, that is a later plugin runtime hardening slice.
- The real plugin-tool Telegram proof used `diffs` as a deliberately enabled harmless tool-bearing plugin. It did not prove Brave because the current app-owned config loads Brave as a web-search provider, not as a harmless registered agent tool.
- Local runtime caveat: the machine currently has split CLI/service config paths (`~/.openclaw/openclaw.json` for some CLI commands, app-owned `~/Library/Application Support/OpenClaw/.openclaw/openclaw.json` for the LaunchAgent). The proof worked only after applying the temporary smoke config to the relevant runtime config paths; this is an ops/config hygiene issue, not a Claude plugin-tool parity blocker.

### Slice 2c: Tester Telegram visibility and feel probe

Status: live tester-bot rerun passed for Claude CLI model selection, source isolation, slow progress/no-spam behavior, and named per-account Telegram reminder delivery.

What was required in the isolated tester lane:

- `agents.defaults.models` had to explicitly include `claude-cli/haiku`, `claude-cli/sonnet`, and `claude-cli/opus`
- `agents.defaults.cliBackends.claude-cli.command` had to be pinned to `/Users/user/.local/bin/claude`
- the tester runtime had to be restarted from that patched isolated config; hot `ensure` alone was not enough once the runtime was already up

Live Telegram proof on `@Artem_jarvis_email_bot`:

- runtime ownership and tester-bot claim passed on branch `codex/claude-cli-plugin-proof-doc`
- baseline DM smoke passed after approving Telegram pairing for user id `1336356696`
- `/model claude-cli/haiku` initially failed with `Model "claude-cli/haiku" is not allowed`
- after patching the isolated tester runtime config and restarting the runtime from that config, `/model claude-cli/haiku` succeeded with `Model set to claude-cli/haiku.`
- `/status` then reported `Model: claude-cli/haiku`
- Claude CLI answered a forced tool probe with a real observed path: `/Users/user/Library/Application Support/OpenClaw/instances/openclaw/.openclaw/workspace-consumer-openclaw`

Prompt-behavior comparison:

- Claude CLI parity probe reply:
  - current model: `claude-haiku-4-5-20251001 (Haiku 4.5)`
  - claimed tools: `Yes, full permissions for bash and MCP tools`
  - coding-fix style: `Test first, fix in smallest steps, verify it works before moving on.`
- Codex parity probe reply:
  - current model: `openai-codex/gpt-5.4`
  - claimed tools: `Yes, this chat currently has usable tools.`
  - coding-fix style: `Reproduce it, inspect the relevant code, make the smallest solid fix, then verify it.`

Blocker found during manual tester pass:

- A Claude CLI Telegram reply described memory as `/Users/user/.claude/projects/.../memory/` and described global instructions as `/Users/user/.claude/CLAUDE.md`.
- That is the Claude Code user's native context, not the OpenClaw workspace bootstrap context.
- Expected source of truth for this tester runtime is the OpenClaw workspace bootstrap at `/Users/user/Library/Application Support/OpenClaw/instances/openclaw/.openclaw/workspace-consumer-openclaw/AGENTS.md`, with workspace memory under the same OpenClaw workspace.
- Code evidence: `src/agents/cli-runner.ts` currently uses the Bridge-safe prompt for `claude-cli` and skips `resolveBootstrapContextForRun`, so `AGENTS.md` / `MEMORY.md` are not injected on the Claude CLI path.
- Code evidence: `src/agents/cli-backends.ts` currently passes `--setting-sources user` to Claude CLI, so Claude Code can still read user-level Claude context.
- Readiness impact: do not expose `claude-cli/*` on the main bot until we either isolate Claude Code user context or prove the user-level context cannot override/confuse OpenClaw workspace identity.

Follow-up fix:

- `src/agents/cli-backends.ts` now defaults Claude CLI to `--setting-sources project,local` instead of `user`.
- `src/agents/cli-runner.ts` still uses the Bridge-safe Claude prompt, but appends bounded OpenClaw workspace bootstrap files and explicitly says not to treat `~/.claude/CLAUDE.md` or `~/.claude/projects` as authoritative for this OpenClaw run.
- Focused proof passed: `pnpm exec vitest run src/agents/cli-backends.test.ts src/agents/cli-runner.test.ts src/agents/claude-cli-runner.test.ts src/agents/tools/cron-tool.test.ts src/commands/models/consumer-auth.test.ts --pool=forks --maxWorkers=1` passed 5 files / 76 tests.

Manual tester pass after source-path discovery:

- Cross-backend short-term session continuity passed: Codex remembered the last messages after resetting to default, and Claude CLI still saw recent session history after switching back from Codex.
- Workspace directory reporting was correct in a later Claude CLI reply: `/Users/user/Library/Application Support/OpenClaw/instances/openclaw/.openclaw/workspace-consumer-openclaw`.
- OpenClaw workspace files were visible but empty in the tester lane: `USER.md` and `TOOLS.md` were identified as scaffolding/templates. This may be tester-runtime state rather than a product-path failure; retest against the main bot/workspace after the prompt-source fix or controlled rollout.
- Web fetch/browser path passed manually: `web_fetch` fetched `marketmirror.com` and `mindmirror.com`; Brave search was available as a tool path but reported missing `BRAVE_API_KEY` in this config.
- Authenticated browser control passed manually: Claude CLI opened/read a Gmail message and used browser tooling to inspect a logged-in X profile.
- WhatsApp send path passed manually with confirmation: Claude CLI found the target, asked before sending, and reported local verification after sending via the direct TypeScript path.
- Reminder/wakeup path failed manually: Claude CLI said it scheduled a one-minute reminder via `ScheduleWakeup`, but no reminder arrived by 18:05. Treat reminder/cron/wakeup firing as a separate blocker to investigate before claiming full operational parity.
- Progress/status UX gap: Claude CLI streams helpful in-progress text, but interim browser/tool status appears to disappear once the final answer lands; Codex-style progress may preserve visibility but sends separate messages and creates notification spam. Product direction to evaluate: buffer progress updates, then include a compact progress transcript with the final answer in one bundled delivery.
- Upstream progress UX reference: upstream `extensions/telegram/src/bot-message-dispatch.ts` already has a better seam that batches/dedupes tool-start progress lines into the editable answer draft lane and suppresses default tool-progress messages when preview streaming can handle them. Port that path instead of inventing a new Telegram progress system.

Follow-up fixes:

- Reminder targeting: `src/agents/tools/cron-tool.ts` now preserves inferred Telegram `accountId` from per-account session keys such as `agent:main:telegram:tester-bot:direct:<peer>:thread:<id>`. Focused cron coverage passed in the combined suite above, and the live named-account proof below verified persisted `delivery.accountId`, cron run success, exact reminder text, and Telegram arrival from the tester bot.
- Progress/status UX: `extensions/telegram/src/bot-message-dispatch.ts` now batches text-only tool progress into the editable answer draft lane when preview streaming is available, dedupes adjacent repeats, and still sends media-bearing tool payloads normally. Focused proof passed: `pnpm vitest run extensions/telegram/src/bot-message-dispatch.test.ts --pool=forks --maxWorkers=1` passed 1 file / 72 tests.
- Progress/status UX follow-up: `codex/claude-cli-progress-ux-20260516` fixed the isolated tester harness so `scripts/telegram-live-runtime.sh ensure` carries the lane-local profile into the detached runtime instead of tripping default shared-runtime ownership policy. It also normalizes Claude CLI progress boundaries before Telegram preview/final send, so adjacent `Step` fragments do not get smashed together.
- Live tester proof: isolated bot `@Artem_jarvis_exec_bot`, runtime PID `17380`, port `28583`, state dir `/Users/user/.openclaw/telegram-live-worktrees/tg-live-bbafc4d743`, branch `codex/claude-cli-progress-ux-20260516`, model `claude-cli/sonnet`. The corrected no-progress-request prompt produced visible intermediate progress, then final message `49418` retained the progress transcript above the final answer and ended with `CLAUDE_PROGRESS_UX_TESTER_CHECK_20260516`.
- Progress UX v2: the same lane now keeps model-authored progress narration as a retained progress bubble and sends the final answer as a separate bubble, instead of pasting progress into the final answer. Focused proof passed: `pnpm exec vitest run extensions/telegram/src/bot-message-dispatch.test.ts extensions/telegram/src/lane-delivery.test.ts src/infra/telegram-live-runtime-helpers.test.ts --pool=forks --maxWorkers=1` passed 3 files / 123 tests.
- Remaining live proof blocker: v2 live Telegram proof is blocked by provider auth/limit state, not runtime ownership. `claude-cli/sonnet` failed with `You've hit your limit · resets 4:10pm (Asia/Kuala_Lumpur)`, `openai/gpt-5.4` lacked `OPENAI_API_KEY`, and `openai-codex/gpt-5.5` hit OAuth refresh failure. The isolated tester runtime itself was healthy at PID `77982`, port `28583`, branch `codex/claude-cli-progress-ux-20260516`.
- Remaining UX caveat: the long-chat checkpoint warning can still appear as a separate tester message when the Telegram DM has accumulated many proof turns. That is context-pressure UX, not the progress projection path.
- Claude setup UX: `src/commands/models/consumer-auth.ts` now hides `anthropic-claude-cli` until the configured local `claude` command is executable and readable Claude auth exists. Direct apply fails with install/sign-in instructions when missing. This keeps Claude hidden/default-off without bundling Claude Code.

Live tester rerun after PR #683:

- Date: 2026-05-13.
- Worktree: `/Users/user/.codex/worktrees/claude-cli-next/claude-cli-next-20260512`.
- Branch/commit: `codex/claude-cli-next-20260512` at `98957d02c9356a59bc2dd90d4bcd1ee4427188c1`.
- Tester bot: `@Artem_jarvis_exec_bot`.
- Runtime ownership passed: doctor reported runtime PID `47473`, port `20510`, and `runtime_worktree=/Users/user/.codex/worktrees/claude-cli-next/claude-cli-next-20260512`.
- Baseline wiring passed after approving tester-only Telegram pairing for user id `1336356696`.
- The helper-managed Telegram tester runtime was not enough for this rerun because `telegram runtime ensure` can regenerate the isolated config and strip the temporary `claude-cli/*` model entries; the final proof used a manual isolated runtime pointed at the patched tester config.
- Claude model switching passed: `/model claude-cli/haiku` returned `Model set to claude-cli/haiku.`
- Source isolation passed: Claude returned `SOURCE_ISOLATION_OK` and explicitly said `~/.claude/CLAUDE.md` and `~/.claude/projects` are not authoritative for the OpenClaw Telegram session.
- Source-reporting nuance: Claude reported `/Users/user/.openclaw/workspace` as the OpenClaw bootstrap workspace, not the repo worktree path. That is acceptable for the bounded bootstrap shape, but keep this distinction visible in future main-bot rollout review.
- Follow-up prompt/files visibility audit returned `PROMPT_FILES_VISIBLE_OK`, but with an important caveat: Claude said `~/.claude/CLAUDE.md` and `~/.claude/projects/.../MEMORY.md` were present in context while not authoritative, and that style from `~/.claude/CLAUDE.md` may still bleed through. Treat the fix as authority isolation, not complete user-context invisibility.
- The same audit said `/Users/user/.openclaw/CLAUDE.md` was loaded and `/Users/user/.openclaw/workspace/AGENTS.md` was canonical but not directly loaded in the current context window. If the product requirement is "Claude cannot see any native Claude user context," this PR is not sufficient; if the requirement is "Claude must not treat native Claude user context as OpenClaw authority," the live proof is green.
- Progress/no-spam proof passed at the basic level: the Claude CLI fetch-style probe returned one final Telegram message with `PROGRESS_BATCHING_OK`, and `telegram-user read --after-id` showed no extra visible progress spam for that turn.
- Progress batching remains only partially proven because the prompt completed quickly and did not produce a long multi-tool progress stream.
- Reminder creation reached the cron tool path and returned job id `1a791dc3-19c3-444e-b098-a292b7c9c4f2`.
- Reminder firing passed at the delivery layer: cron state recorded `lastRunStatus=ok`, `lastDelivered=true`, and `lastDeliveryStatus=delivered`; Telegram received `Reminder delivered.`
- Reminder proof caveat: the stored job used `delivery.mode=announce` and `sessionKey=agent:main:main`, not a per-account Telegram session key; it therefore did not prove the `delivery.accountId` preservation fix. It also did not deliver the requested nonce text, only the generic delivery summary.
- Tester-runtime caveat: the standard helper starts isolated Telegram runtime with `OPENCLAW_SKIP_CRON=1`, so reminder firing proof requires a manual cron-enabled isolated runtime or a helper option that keeps cron enabled for this exact test.

Live named-account reminder proof after PR #683 merge:

- Date: 2026-05-14.
- Branch/commit: `codex/telegram-reminder-accountid-proof` at merged PR #683 commit `9be14f2d0533e9ceb537b28c73c999ecb4cb0f65`.
- Runtime ownership passed: doctor reported runtime PID `49571`, port `20510`, and `runtime_worktree=/Users/user/.codex/worktrees/claude-cli-next/claude-cli-next-20260512`.
- The isolated tester config was reshaped so the same tester bot token runs as named account `tester-bot` instead of the default unnamed Telegram account; gateway logs confirmed `[tester-bot] starting provider (@Artem_jarvis_exec_bot)`.
- Claude CLI model switch passed again: `/model claude-cli/haiku` returned `Model set to claude-cli/haiku.`
- Natural-language Claude-created reminder job `7f0a2b05-47fc-4f80-a220-b7216fc2d099` persisted the target correctly: `sessionKey=agent:main:telegram:tester-bot:direct:1336356696` and `delivery={mode:"announce", channel:"telegram", to:"1336356696", accountId:"tester-bot"}`.
- That Claude-created job proved `delivery.accountId` inference from the current named-account Telegram session, but Claude chose a calendar cron expression that rolled to the next year, so it was manually triggered for delivery proof.
- Manual trigger of the same job delivered exact text `REMINDER_ACCOUNTID_OK_1778730629`; cron run log recorded `status=ok`, `deliveryStatus=delivered`, `summary=REMINDER_ACCOUNTID_OK_1778730629`, provider `claude-cli`, model `haiku`, and session key `agent:main:telegram:tester-bot:direct:1336356696`.
- Timer firing was then proved separately with direct `kind:"at"` job `719b0669-0aa4-4ec1-a03e-07fb94a59cac`, using the same named-account session and explicit `delivery.accountId=tester-bot`.
- The timer job fired naturally at `2026-05-14T03:54:15.482Z`, Telegram received exact text `REMINDER_TIMER_ACCOUNTID_OK_1778730795`, and cron state recorded `lastRunStatus=ok`, `lastDelivered=true`, and `lastDeliveryStatus=delivered`.
- Remaining caveat: the standard tester runtime helper still starts with `OPENCLAW_SKIP_CRON=1`, so this proof required a manual cron-enabled isolated runtime. The product code path is green; the helper ergonomics are still rough.

Live slow progress batching proof after PR #689 merge:

- Date: 2026-05-14.
- Branch/commit: `codex/claude-progress-proof` at `72ca1437b770761215a6dd36dd7a315125dd56fd`.
- Runtime ownership passed before the run: doctor reported runtime PID `81292`, port `20510`, bot `@Artem_jarvis_exec_bot`, userbot id `1336356696`, and `runtime_worktree=/Users/user/.codex/worktrees/claude-cli-next/claude-cli-next-20260512`.
- Claude CLI model switch passed again: `/model claude-cli/haiku` sent as Telegram message `49125`; bot message `49126` returned `Model set to claude-cli/haiku.`
- Fast multi-tool proof passed first: user message `49127` returned bot message `49128` with nonce `PROGRESS_MULTI_TOOL_OK_1778732302`, using `sessions_list`, `WebFetch` for `example.com`, `web_fetch` for the IANA example-domains page, and `session_status`. This proved multi-tool Claude CLI execution but was too fast at about 4.8s to stress Telegram progress batching.
- A naive slow prompt that asked Claude to run a local sleep command was rejected as a proof: user message `49129` produced a context-pressure notice and an interim-looking standalone reply (`Awaiting monitor completion...`) without the required final nonce. Treat that as a bad probe shape, not a green product proof.
- Clean slow proof used a controlled delayed local HTTP endpoint plus harmless tools after resetting the tester session and switching back to `claude-cli/haiku`.
- Clean slow proof prompt was Telegram message `49136` with nonce `PROGRESS_LOCAL_SLOW_OK_1778732876`. The runtime logged `[agent/claude-cli] cli exec: provider=claude-cli model=haiku`.
- The MCP URL fetch correctly blocked `http://127.0.0.1:8765/slow` as private/internal; Claude recovered by using Bash `curl`, waited 22 seconds, then completed the remaining harmless tools.
- Telegram visible result stayed on one bot message id, `49137`: an early progress preview appeared as `Loading tool schemas...`, then the same message was edited into the final answer containing `PROGRESS_LOCAL_SLOW_OK_1778732876`, the delayed `SLOW_LOCAL_FETCH_OK` body, `sessions_list`, `example.com`, and the IANA example-domains fetch.
- Pass condition met: real slow tool pressure, multiple tools, no multiple standalone Telegram progress spam messages, and one draft-lane message edited into the final result.
- Caveat: the final answer contained the nonce after a short introductory sentence instead of as the first token. That is prompt obedience noise, not a Telegram progress batching blocker.

Current read:

- Claude CLI is operational in the isolated tester Telegram lane after config/auth setup, including direct `/model` switching.
- Prompt/source isolation is green enough for review and merge under the authority-isolation definition: the old `~/.claude` authority leak did not reproduce, but native Claude user context can still be visible as non-authoritative context.
- Progress batching is green in the isolated tester lane: a 22-second delayed tool turn stayed on one Telegram message id and edited the draft lane into the final result instead of spamming separate progress messages.
- Reminder delivery is green for the original account-routing blocker: named-account route, persisted `delivery.accountId`, exact reminder text, cron success, and Telegram arrival all passed in the isolated tester lane.
- Main-bot manual acceptance started after deploying the merged code onto Artem's real product bot, and it did not pass. Treat the tester-lane proofs as still valid but insufficient for broad/default exposure.

Remaining validation gates:

- Main-bot model enablement: the main app-owned config must include `claude-cli/haiku`, `claude-cli/sonnet`, and `claude-cli/opus`, with `agents.defaults.cliBackends.claude-cli.command` pinned to `/Users/user/.local/bin/claude`. Artem's first main-bot `/model claude-cli/haiku` failed until this config was patched and the shared gateway was restarted.
- Main-bot source/prompt audit: the first main-bot Claude audit reported `/Users/user/.claude/CLAUDE.md` plus `/Users/user/Library/Application Support/OpenClaw/.openclaw/CLAUDE.md` as system-level sources, and reported `SOUL.md`, `USER.md`, `MEMORY.md`, `TOOLS.md`, and daily memory files as session-startup sources. It also correctly said the daily memory files for `2026-05-14` and `2026-05-13` did not exist. Keep reviewing this path for authority confusion and accidental sensitive-context exposure.
- Main-bot skills acceptance: Claude did not proactively use Artem's tone-of-voice skill for a Twitter draft until the user explicitly called out the missing skill. Investigate whether `claude-cli` is reading native Claude skills, OpenClaw workspace skills, or only bounded bootstrap text. The 80/20 product goal is that user-created OpenClaw workspace skills are discoverable by Claude CLI the same way they are discoverable by the default OpenClaw/Codex path.
- Main-bot progress acceptance: slow/multi-tool progress stayed mostly in one editable message, but interim progress text was hard to read because adjacent updates were concatenated without spacing/newlines, and the progress preview was replaced/cleared when the final answer landed. Decide whether the desired behavior is "clean ephemeral preview only" or "final answer includes a compact progress transcript"; current UX is not acceptable for user-facing slow turns.
- Main-bot context-window/status acceptance: a fresh-looking Claude Telegram conversation emitted the context-pressure notice ("This conversation is getting heavy..."), which does not match the user's expectation for a new Claude turn. Also verify `/status` context-window reporting for `claude-cli/sonnet` and `claude-cli/opus`; the user expects the largest available Claude CLI context, but the bot appeared to report a smaller window.
- Main-bot reminder acceptance: main-bot natural-language one-minute reminders acknowledged as set but did not visibly wake up and deliver. Re-check persisted cron job state, `delivery.accountId`, session key, cron firing, and Telegram arrival on the main runtime before calling reminders green outside the tester lane.
- Final main-bot smoke: rerun only after the above blockers are understood/fixed. Minimum manual path remains `/model claude-cli/haiku` or `/model claude-cli/sonnet`, source/prompt sanity question, one real browser/fetch/tool task, one skill-triggered tone-of-voice task, one reminder, and one slow multi-tool progress task. Pass only if the main bot feels correct in the actual product chat, not just in the isolated tester lane.
- Rollout rule: if main-bot manual proof fails, keep `claude-cli/*` tester-only and fix the specific failing path before exposing it broadly.

Main-bot acceptance follow-up fixes merged on `main`:

- Reminder truthfulness: exact `remind me in <duration> to <task>` intents now short-circuit into a real `cron.add` before the model can produce a fake acknowledgment. Focused proof passed: `pnpm exec vitest run src/auto-reply/reply/get-reply-inline-actions.skip-when-config-empty.test.ts src/auto-reply/reply/agent-runner.misc.runreplyagent.test.ts -t "reminder|Reminder" --pool=forks --maxWorkers=1` passed 2 files / 8 selected tests.
- Claude CLI skills: the bridge-safe Claude CLI prompt now includes the compact OpenClaw `<available_skills>` block while preserving the `~/.claude` non-authority warning. Focused proof passed in the selected CLI runner test pack.
- Claude Code 1M context: Claude Code exposes explicit long-context model variants such as `sonnet[1m]` and `opus[1m]`, selected via `/model` or `--model`. OpenClaw now passes those variants through and reports 1,048,576 context tokens only for explicit `[1m]` Claude CLI models; plain `sonnet`/`opus` remain conservative. Focused proof passed in `src/agents/cli-backends.test.ts` and `src/agents/context.lookup.test.ts`.
- Context-pressure nuance: the main-bot "conversation is getting heavy" notice is not fully explained by the 200k fallback alone. The session store for topic `10980` showed `contextTokens=200000`, tiny persisted input/output counts, no persisted total tokens, and a set `contextPressureNoticeAt`; follow-up fix subtracts static system/bootstrap/tool-schema overhead before warning on a fresh, uncompacted session. Focused proof passed in `src/auto-reply/reply/context-pressure-notice.test.ts` and `src/auto-reply/reply/agent-runner.misc.runreplyagent.test.ts`. Tester Telegram proof passed on `@Artem_jarvis_exec_bot`: short Claude CLI reply returned exactly `CLAUDE_SHORT_NO_NOTICE_OK_180000` with no heavy-chat notice.
- Claude CLI Telegram 1M selection: follow-up fix now resolves `/model` and `/status` context windows with provider-aware lookup, preserving explicit `claude-cli/sonnet[1m]` and `claude-cli/opus[1m]` variants while keeping plain `sonnet`/`opus` at 200k. The isolated Telegram tester config builder now also keeps explicitly pinned Claude CLI tester models in the allowlist and includes the matching `[1m]` advanced variant. Focused proof passed in model override, reply selection, status, model-list, exact parser, and Telegram runtime-helper tests. Tester Telegram proof passed on `@Artem_jarvis_exec_bot`: `/model claude-cli/sonnet[1m]` returned `Model set to claude-cli/sonnet[1m].`, and `/status` showed `Context: 62/1.0m`.
- Telegram progress UX: progress transcript lines now use blank-line separators and are retained into the final answer instead of being cleared by preview cleanup. Focused proof passed: `pnpm exec vitest run extensions/telegram/src/bot-message-dispatch.test.ts extensions/telegram/src/lane-delivery.test.ts --pool=forks --maxWorkers=1` passed 2 files / 96 tests.
- PR #706 merged the context-pressure and explicit `[1m]` selection fixes.
- PR #708 merged delayed free-form agent-turn reminder scheduling. Live production proof is still pending.
- PR #709 merged user/workspace skill priority in the Claude CLI prompt budget. Live production proof is still pending.
- PR #710 merged ACP progress title preservation. Live production proof is still pending.

Production readiness checkpoint after PR #711:

- Runtime ownership: passed. Shared gateway is `branch=main`, `worktree=~/Programming_Projects/openclaw`, `OPENCLAW_STATE_DIR=~/Library/Application Support/OpenClaw/.openclaw`, port `18789`, RPC probe ok. Latest observed runtime PID after `/restart`: `56299`.
- Standard Claude backend: passed. Production `/model claude-cli/sonnet` returned `Model set to claude-cli/sonnet.`, `/status` showed `Model: claude-cli/sonnet` and `Context: 23/200k`, and a real turn returned exactly `CLAUDE_STANDARD_READY_20260514` with no fallback or context-pressure warning.
- Delayed agent-turn reminder parity: passed for the main product bot. `in 1 min reply exactly CLAUDE_DELAYED_AGENTTURN_READY_20260514` first returned `Reminder scheduled: reply exactly CLAUDE_DELAYED_AGENTTURN_READY_20260514`, then later delivered exactly `CLAUDE_DELAYED_AGENTTURN_READY_20260514` without a follow-up prompt.
- Basic web/tool smoke: usable but not a strong tool-choice proof. The prompt `Use a web/search tool if available. Answer with exactly one sentence: what is OpenAI?` returned the correct one-sentence OpenAI summary. It did not prove a specific named tool path.
- Progress/final behavior: basic pass. A slow progress smoke eventually left the final visible message as exactly `CLAUDE_PROGRESS_READY_20260514`; a transient intermediate draft was observed during polling, but it was not present in the final recent-message read.
- Skills acceptance: still failed. The live app workspace has `workspace/skills -> ~/.agents/skills`, and local prompt construction includes the `reddit` skill, but production Claude replied `REDDIT_SKILL_MISSING_AFTER_RESTART_20260514` even after `/restart`. Treat this as the current blocker for Codex-level parity, not a ranking-only issue.
- Product readiness verdict: usable enough for normal Claude chat, model switching, simple tool/web work, delayed reminders, and basic progress. Not ready to call full Codex parity until the Claude CLI skill-discovery/invocation path is fixed and re-proven.

Claude CLI 1M status after the #706/#708/#709/#710 stack:

- Tester Telegram proof passed for selecting `claude-cli/sonnet[1m]` and reporting `1.0m` context.
- Production proof passed for selecting `claude-cli/sonnet[1m]` and reporting `1.0m` context, but execution fell back because direct Claude CLI rejects Sonnet 1M on this account with `Extra usage is required for 1M context`.
- Direct Claude CLI `opus[1m]` succeeds with `contextWindow: 1000000`; direct `claude-opus-4-7[1m]` succeeds too.
- Production OpenClaw proof passed for `claude-cli/opus[1m]`: `/model claude-cli/opus[1m]` returned `Model set to claude-cli/opus[1m].`, `/status` showed `Context: 47/1.0m`, and a real turn returned exactly `PROD_CLAUDE_OPUS_1M_OK_20260514` with no fallback warning.
- Prefer `claude-cli/opus[1m]` for true no-extra-usage 1M on this account. Do not treat `sonnet[1m]` as the reliable 1M path unless Anthropic changes this account's Sonnet 1M entitlement.

Main-bot manual acceptance checkpoint after PR 701:

- Runtime deployment: passed. `main` was fast-forwarded to `40043ae48f fix(telegram): harden claude acceptance paths`, and the main LaunchAgent was recovered to `~/Programming_Projects/openclaw` with app-owned config/state under `~/Library/Application Support/OpenClaw/.openclaw`, Node 22, listener on `127.0.0.1:18789`, and RPC probe ok.
- Prompt/source audit: mixed. Claude correctly understood a precedence stack, but it still reported `~/.openclaw/CLAUDE.md` / OpenClaw dev-runtime rules as authoritative context. This may be excessive context bloat for product Telegram sessions and should be re-audited; the desired surface is bounded OpenClaw workspace/app context, not broad local developer rules unless explicitly needed.
- Tone-of-voice skill: mostly passed in the main bot. The tweet draft used Artem's tone better after the workspace-skills prompt injection.
- Reddit/tool selection: failed. Claude fetched Reddit through generic web/MCP behavior instead of proactively using the repo/user Reddit skill. Next lane should verify whether the Claude CLI skills prompt exposes skill names/descriptions strongly enough and whether skill invocation rules survive the bridge-safe prompt.
- Reminder basic delivery: passed for the simple reminder path. `remind me in 1 min to test claude cli reminders` produced a truthful scheduled ack and later sent `Reminder fired: test Claude CLI reminders.`
- Delayed automation reminder/monitor parity: failed. `in 1 min check my twitter feed lmk whats on it` acknowledged with a temporary "Back in ~60s" style reply, but the eventual Twitter-feed result did not arrive automatically in Telegram; the user had to ask `done?`, after which Claude claimed the summary was above and only then repeated it. This is not parity with the Codex backend, where delayed agent-turn automation should wake, run, and deliver the result without a follow-up prompt.
- Progress UX: still failed. Interim progress text now has some newlines, but the preview still gets replaced/cleared after the final answer. The user-visible product requirement is that slow-task progress remains readable and the final result does not make useful progress/context vanish.
- Context-pressure notice: failed in main-bot acceptance, tester-bot repair proof passed. The main bot emitted "This chat is getting long..." in a short/fresh acceptance run; the repair now ignores static bootstrap-heavy prompt tokens for fresh, uncompacted sessions.
- Claude CLI 1M model selection: failed in main-bot acceptance, tester-bot repair proof passed. `/model claude-cli/sonnet[1m]` responded as if it selected `claude-cli/sonnet`, and `/model status` still reported 200k context; the repair now preserves explicit `[1m]` variants through Telegram directive parsing, reply-side context resolution, and status.
- Manual QA process: failed as a workflow. Too much of the acceptance burden landed on Artem. The next checkpoint should use a tester Telegram bot/runtime first, with coordinator + parallel workers, and only hand Artem the main bot once the agent has proved the fixed paths itself.

Next orchestrated repair lanes:

- Progress lifecycle lane: reproduce in an isolated Telegram tester bot with a slow multi-tool task, then fix preview/final retention so readable progress does not disappear after the final answer.
- Delayed agent-turn parity lane: reproduce `in 1 min check <thing> and report back` with Claude CLI in tester Telegram, inspect the cron/agentTurn result-delivery path, and make it deliver the actual result to Telegram without a user follow-up.
- Skills/tool-selection lane: verify why Claude CLI sees workspace skills but does not choose the Reddit skill; tighten the bridge-safe skills prompt or invocation surface without restoring full prompt bloat.
- Prompt/source-bloat lane: audit exactly why `~/.openclaw/CLAUDE.md` and dev/runtime rules appear as authoritative in Claude CLI Telegram sessions; decide the 80/20 product boundary for product sessions versus local developer sessions.
- Model-selection lane: production proof complete for `claude-cli/opus[1m]` selection, status, and one real turn. Remaining 1M work is product policy: expose Opus 1M as the advanced 1M path and avoid steering users to Sonnet 1M while it requires extra usage on this account.
- Context-pressure lane: tester proof complete for a short Claude CLI Telegram turn without the heavy-chat notice; next gate is main-bot acceptance after merge.

Future model-picker/default-exposure rule:

- Keep the current visible/default Claude choice unchanged until Claude CLI passes main-bot acceptance.
- After acceptance, make Claude CLI 200k models the preferred default Claude path.
- Keep explicit Claude CLI 1M variants in More/advanced options instead of making them defaults. Prefer `claude-cli/opus[1m]` for the 1M advanced path because direct Claude CLI and production Telegram proof both confirm no-extra-usage 1M behavior for Opus on this account.
- Hide Claude API model rows unless the user has configured a Claude API key or enabled advanced provider settings. Dead provider rows create noisy UX and make the picker feel broken.

### Slice 3: Warm Claude CLI spike

Status: implemented and validated for same-process reuse on same-model follow-up.

What changed:

- `src/agents/cli-runner/claude-live-session.ts` keeps a live `claude` process for `claude-cli` when the backend is `jsonl` + `stdin` + `liveSession: "claude-stdio"`.
- The runner sends follow-up turns as Claude `stream-json` user messages over stdin.
- Live session selection restarts when command/env/prompt/MCP fingerprints change.
- First-turn Bridge-safe prompt behavior is preserved; this slice does not restore the full OpenClaw prompt that triggered Anthropic extra-usage blocks.
- Streaming callbacks still receive Claude `content_block_delta` text before final result parsing.

Live proof:

- `claude-cli` defaults to `liveSession: "claude-stdio"`.
- `runCliAgent` now routes eligible `claude-cli` runs through the live stdio process.
- Live smoke passed with loopback MCP tool use and same-session follow-up continuity.
- A separate live run proved resume across `sonnet -> haiku`.
- New latency smoke measured the product `runCliAgent` path, not the old direct cold CLI benchmark.

Initial latency result before the fingerprint fix:

- command: `OPENCLAW_CLAUDE_CLI_CONTINUITY_LIVE=1 node --import tsx scripts/smoke-claude-cli-continuity.ts --mode latency --model haiku --timeout-ms 180000`
- first turn total: 6283.6ms
- follow-up total: 5095.5ms
- first assistant start: 4773.2ms
- follow-up assistant start: 4738.0ms
- Claude session id reused: yes, `7cc4ccc7-5289-463f-b7ba-4264601a7425`
- live process reused: no, first PID `12585`, follow-up PID `12863`

Root cause:

- the live-session fingerprint was too sensitive
- first-turn args included `--model` while resumed args did not
- the fingerprint also included the whole parent `process.env`, which changed after config/plugin loading

Fix:

- omit resume/model/prompt/session path args from the live-process identity when the same normalized model is already tracked explicitly
- fingerprint only Claude/OpenClaw-MCP-relevant environment keys instead of every ambient provider key

Validated latency result after the fix:

- command: `OPENCLAW_CLAUDE_CLI_CONTINUITY_LIVE=1 node --import tsx scripts/smoke-claude-cli-continuity.ts --mode latency --model haiku --timeout-ms 240000`
- first turn total: 7604.5ms
- follow-up total: 2104.8ms
- first assistant start: 5495.3ms
- follow-up assistant start: 1859.1ms
- Claude session id reused: yes, `ea5d1493-52af-43cf-9940-878c6f80d11b`
- live process reused: yes, PID `27135`
- live fingerprint reused: yes

Remaining risk:

- Long-lived process behavior around rare abort/drain edges is intentionally conservative; failed turns close the live process instead of trying to salvage partial state.
- Cross-model warm process reuse is not expected; model switches can preserve Claude conversation continuity while starting a new live process for the new model.

Only after tool continuity and browser pass, test whether Claude CLI can stay warm in product traffic.

Options to explore:

- long-lived `claude -p --input-format stream-json`
- upstream-style stdio runner if present
- minimal warm runner that preserves Claude CLI semantics

Pass condition:

- follow-up latency is materially closer to Bridge
- session continuity remains correct
- native MCP tools still work
- implementation does not become Bridge with a new name

Current pass/fail:

- session continuity: pass
- loopback MCP memory/browser tools: pass for `memory_search`, `memory_get`, `memory_search -> memory_get` with direct path fallback, `browser.status`, `browser.tabs`, and `browser.open -> browser.snapshot`
- loopback MCP core tool through actual Telegram: pass for Claude CLI calling `sessions_list` via `@Jarvis_cl4w_bot`
- real enabled plugin tool through actual Telegram: pass for Claude CLI calling the deliberately enabled `diffs` plugin tool via `@Jarvis_cl4w_bot`
- CLI-only plugin tool proof: pass for `plugin-diffs` in `scripts/smoke-claude-cli-continuity.ts`; unified parity matrix includes the scenario
- browser open+snapshot: pass
- cross-backend `/codex -> Claude` context: pass after Shared Transcript Replay
- same live process reuse on same-model follow-up: pass
- warm latency: pass for the current `haiku` smoke; follow-up was materially faster after PID reuse
- strict `memory_search -> memory_get` without direct fallback: pass; two consecutive live runs passed with both tool calls, exact nonce, exact fresh needle, and no direct-path fallback, after one prior completed run returned `MEMORY_CHAIN_SEARCH_EMPTY`
- temp-config/no-tool echo: pass; latest live run returned `TEMP_CONFIG_ECHO_OK` instead of wedging
- unified parity matrix: pass; `OPENCLAW_CLI_BACKEND_PARITY_LIVE=1 node --import tsx scripts/smoke-cli-backend-parity.ts --model haiku --codex-model gpt-5.5 --timeout-ms 240000` passed all rows:
  - `codex-context`: Codex returned `CODEX_CONTEXT_SET ...`, then Claude returned `CODEX_CONTEXT_SWITCH_OK ...`
  - `memory-chain`: Claude used `memory_search`, then `memory_get`, and returned the indexed temp `MEMORY.md` needle
  - `browser-open-snapshot`: Claude opened a temp page, snapshotted it, and returned the page marker
  - `latency`: Claude reused the same session id and live process PID; follow-up total was `1854.2ms`

### Slice 4: Product decision

Decision:

- **Claude CLI wins** for the current backend direction.
- **Bridge survives** only as legacy fallback/prior art unless a new workflow
  fails under Claude CLI.

---

## What Not To Do

- Do not keep rerunning generic benchmarks before changing the latency model.
- Do not port the full OpenClaw prompt into Claude CLI.
- Do not manually reimplement every OpenClaw tool inside Bridge.
- Do not delete Bridge until Claude CLI passes continuity, exec, browser, and warm/cold decision gates.
- Do not treat direct `claude -p` success as product-path success; prove via `runCliAgent`.
- Do not accept a backend that loses memory/tool capabilities when the user switches models.

---

## Current Status

Implemented so far:

- Claude CLI stream-json defaults
- Bridge-safe prompt profile for `claude-cli`
- loopback OpenClaw MCP injection for `claude-cli`
- native OpenClaw MCP fallback for `claude-cli` when loopback is unavailable
- fast native MCP tool discovery
- live `runCliAgent` exec smoke passing
- warm Claude stdio session helper wired into `runCliAgent`
- loopback MCP HTTP server files ported/adapted:
  - `src/gateway/mcp-http.ts`
  - `src/gateway/mcp-http.handlers.ts`
  - `src/gateway/mcp-http.loopback-runtime.ts`
  - `src/gateway/mcp-http.protocol.ts`
  - `src/gateway/mcp-http.request.ts`
  - `src/gateway/mcp-http.runtime.ts`
  - `src/gateway/mcp-http.schema.ts`
  - `src/gateway/tool-resolution.ts`

Tests run in this slice:

- `OPENCLAW_CLAUDE_CLI_CONTINUITY_LIVE=1 node --import tsx scripts/smoke-claude-cli-continuity.ts --mode inspect --timeout-ms 180000`
  - pass: direct loopback exposed 20 tools and direct `memory_search` returned `isError=false`
- `OPENCLAW_CLAUDE_CLI_CONTINUITY_LIVE=1 OPENCLAW_LIVE_CLI_BACKEND_DEBUG=1 node --import tsx scripts/smoke-claude-cli-continuity.ts --mode memory --model haiku --timeout-ms 180000`
  - pass: Claude called `mcp__openclaw__memory_search`
- `OPENCLAW_CLAUDE_CLI_CONTINUITY_LIVE=1 OPENCLAW_LIVE_CLI_BACKEND_DEBUG=1 node --import tsx scripts/smoke-claude-cli-continuity.ts --mode browser --model haiku --timeout-ms 180000`
  - pass: Claude called `mcp__openclaw__browser` with `action="status"`
- `OPENCLAW_CLAUDE_CLI_CONTINUITY_LIVE=1 OPENCLAW_LIVE_CLI_BACKEND_DEBUG=1 node --import tsx scripts/smoke-claude-cli-continuity.ts --mode memory-get --model haiku --timeout-ms 240000`
  - pass: Claude called `mcp__openclaw__memory_get` and returned the nonce plus a unique needle from temp-workspace `MEMORY.md`
- `OPENCLAW_CLAUDE_CLI_CONTINUITY_LIVE=1 OPENCLAW_LIVE_CLI_BACKEND_DEBUG=1 node --import tsx scripts/smoke-claude-cli-continuity.ts --mode browser-tabs --model haiku --timeout-ms 240000`
  - pass: Claude called `mcp__openclaw__browser` with `action="tabs"` and returned the nonce
- `OPENCLAW_CLAUDE_CLI_CONTINUITY_LIVE=1 OPENCLAW_LIVE_CLI_BACKEND_DEBUG=1 node --import tsx scripts/smoke-claude-cli-continuity.ts --mode memory-chain --model haiku --timeout-ms 240000`
  - pass with caveat: Claude called `memory_search`, then `memory_get`; search did not return the new temp entry, so Claude used the explicit `MEMORY.md` fallback path
- `OPENCLAW_CLAUDE_CLI_CONTINUITY_LIVE=1 OPENCLAW_LIVE_CLI_BACKEND_DEBUG=1 node --import tsx scripts/smoke-claude-cli-continuity.ts --mode browser-open-snapshot --model haiku --timeout-ms 240000`
  - pass after targetId/timeout smoke fix: Claude called `browser.open`, then `browser.snapshot`, and returned `BROWSER_OPEN_SNAPSHOT_MCP_OK`
- `pnpm exec vitest run src/memory/manager.fts-only-index.test.ts`
  - pass: 1 file, 1 test
- `OPENCLAW_CLAUDE_CLI_CONTINUITY_LIVE=1 OPENCLAW_LIVE_CLI_BACKEND_DEBUG=1 node --import tsx scripts/smoke-claude-cli-continuity.ts --mode memory-chain --model haiku --timeout-ms 240000`
  - fail before watchdog fix: deterministic temp-memory preflight passed, but the live Claude CLI turn hung before MCP initialization and exceeded `--timeout-ms 240000`
- `OPENCLAW_CLAUDE_CLI_CONTINUITY_LIVE=1 OPENCLAW_LIVE_CLI_BACKEND_DEBUG=1 node --import tsx scripts/smoke-claude-cli-continuity.ts --mode memory-chain --model haiku --timeout-ms 240000`
  - fail after watchdog fix: deterministic temp-memory preflight passed, then the live Claude CLI turn failed cleanly with `FailoverError: CLI produced no output for 192s and was terminated.`
- `OPENCLAW_CLAUDE_CLI_CONTINUITY_LIVE=1 node --import tsx scripts/smoke-claude-cli-continuity.ts --mode codex-context --model haiku --codex-model gpt-5.5 --timeout-ms 240000`
  - pass after Shared Transcript Replay For Claude CLI: Codex setup turn completed, and Claude returned the prior Codex context needle from the same OpenClaw session
- `OPENCLAW_CLAUDE_CLI_CONTINUITY_LIVE=1 node --import tsx scripts/smoke-claude-cli-continuity.ts --mode latency --model haiku --timeout-ms 180000`
  - partial: same Claude session id, different live process PID
- `OPENCLAW_CLAUDE_CLI_CONTINUITY_LIVE=1 node --import tsx scripts/smoke-claude-cli-continuity.ts --mode latency --model haiku --timeout-ms 240000`
  - pass after fingerprint fix: same Claude session id, same live process PID `27135`, follow-up total `2104.8ms`
- `pnpm exec vitest run src/agents/cli-runner/claude-live-session.test.ts src/agents/cli-runner/bundle-mcp.test.ts src/agents/cli-backends.test.ts src/agents/cli-runner.test.ts src/agents/claude-cli-runner.test.ts`
  - pass: 5 files, 42 tests
- `pnpm exec tsc --noEmit --pretty false`
  - fail: repo has unrelated existing typecheck failures
  - filtered check after fixes found no errors in the new/changed slice files
- `pnpm exec vitest run src/agents/cli-runner.bundle-mcp.e2e.test.ts`
  - not run: repo Vitest config excludes `**/*.e2e.test.ts`

Next:

1. Land `scripts/smoke-cli-backend-parity.ts` as the reusable parity report.
2. Retire this document from active planning to historical evidence.
3. Decide product exposure separately: whether `claude-cli/*` should remain
   hidden by default or become a selectable Telegram model lane.
4. Defer already-loaded plugin factory timeout hardening unless a real plugin
   factory hang appears in live traffic.
