# Claude Backend Direction Plan

## TL;DR

Prefer **Claude CLI as the long-term backend**, using the Bridge-safe prompt profile, upstream-style warm stdio sessions, and loopback OpenClaw MCP tools.

Do not delete Claude Bridge yet.

Use Bridge as the fallback and as prior art while we prove:

1. Claude CLI has real tool parity
2. Claude CLI has reliable memory/session continuity
3. Claude CLI can be made warm enough that latency is acceptable

If warm Claude CLI works, Bridge should become legacy or be removed.

If warm Claude CLI cannot work, then harden Bridge with the same native MCP tool path.

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
- Remaining risk is no longer a stuck backend. It is model compliance variance on the strict two-tool prompt plus a known tool-surface gap: Claude CLI loopback currently exposes core OpenClaw tools without plugin-tool discovery.
- Plugin-tool parity is an explicit follow-up, not a merge blocker for PR #586. The next slice should make enabled plugin tools available to Claude CLI only after plugin discovery is bounded so it can never block MCP `initialize`, `tools/list`, or Claude startup.

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
- browser open+snapshot: pass
- cross-backend `/codex -> Claude` context: pass after Shared Transcript Replay
- same live process reuse on same-model follow-up: pass
- warm latency: pass for the current `haiku` smoke; follow-up was materially faster after PID reuse
- strict `memory_search -> memory_get` without direct fallback: pass; two consecutive live runs passed with both tool calls, exact nonce, exact fresh needle, and no direct-path fallback, after one prior completed run returned `MEMORY_CHAIN_SEARCH_EMPTY`
- temp-config/no-tool echo: pass; latest live run returned `TEMP_CONFIG_ECHO_OK` instead of wedging

### Slice 4: Product decision

Choose:

- **Claude CLI wins** if warm CLI works or cold CLI is acceptable after parity proof.
- **Bridge survives** only if Claude CLI cannot meet continuity/tool/browser/latency requirements.

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

1. Start a fresh worktree from `main` for Claude CLI plugin-tool parity.
2. Map exact plugin-tool semantics first: normal Codex/OpenAI PI runner can include plugin tools through `createOpenClawTools` and `resolvePluginTools`; Claude CLI loopback now intentionally skips that path for core parity.
3. Implement bounded plugin discovery/cache/fallback so Claude CLI can expose enabled plugin tools without plugin discovery ever blocking MCP `initialize`, `tools/list`, or live Claude startup.
4. Add a proof that plugin discovery timeout/failure still returns core tools and logs plugin-tool unavailability instead of hanging.
