# Claude Backend Latency Benchmark

Use `scripts/bench-agent-latency.mjs` for a small, live-only-on-purpose latency check across:

- `claude-bridge`: one long-lived Claude stream-json child with multiple stdin turns.
- `claude-cli`: direct Claude CLI stream-json. Historical runs measured the cold/resume path; current product code can also use the new warm `claude-stdio` path through `runCliAgent`.
- `codex`: direct Codex CLI JSONL through `codex exec`; follow-up uses text output because Codex resume is not JSONL today.

The harness does not start or modify the OpenClaw gateway. It creates a temp workspace by default and only calls providers when explicitly enabled.

```bash
node scripts/bench-agent-latency.mjs --help
node scripts/bench-agent-latency.mjs
OPENCLAW_BACKEND_BENCH_LIVE=1 node scripts/bench-agent-latency.mjs --backend all --follow-up --runs 1
```

Measured fields:

- `assistantStartMs`: `t0` to an assistant message-start event, or first text when the backend does not expose a separate start event.
- `firstVisibleTextMs`: `t0` to first non-empty assistant text.
- `totalMs`: `t0` to turn completion.

Safety defaults:

- Dry-run unless `--live` or `OPENCLAW_BACKEND_BENCH_LIVE=1` is set.
- One run by default.
- `--runs` above `3` requires `--allow-many`.
- Codex runs with `--sandbox read-only`.
- Prompts are short and ask for one sentence.

Current status:

- Warm Claude CLI is now implemented in the product runner.
- The old generic benchmark is still useful for cold CLI vs Bridge, but it does not measure the product `runCliAgent` warm path.
- Do not use old cold CLI numbers to reject the upstream-style backend.

Latest product-path measurement:

```bash
OPENCLAW_CLAUDE_CLI_CONTINUITY_LIVE=1 node --import tsx \
  scripts/smoke-claude-cli-continuity.ts \
  --mode latency \
  --model haiku \
  --timeout-ms 180000
```

Initial result before the live-session fingerprint fix:

- first turn total: 6283.6ms
- follow-up total: 5095.5ms
- first assistant start: 4773.2ms
- follow-up assistant start: 4738.0ms
- Claude session id reused: yes
- live process reused: no; first PID `12585`, follow-up PID `12863`

Interpretation:

- This validates product-path Claude session continuity.
- It did not validate true warm stdio process reuse for resumed turns.

Current result after the fingerprint fix:

- command: `OPENCLAW_CLAUDE_CLI_CONTINUITY_LIVE=1 node --import tsx scripts/smoke-claude-cli-continuity.ts --mode latency --model haiku --timeout-ms 240000`
- first turn total: 7604.5ms
- follow-up total: 2104.8ms
- first assistant start: 5495.3ms
- follow-up assistant start: 1859.1ms
- Claude session id reused: yes
- live process reused: yes; PID `27135` for both turns
- live fingerprint reused: yes

Interpretation:

- This validates the product `runCliAgent` warm Claude CLI path for same-model follow-up.
- Cross-model switches can still preserve Claude conversation continuity while starting a new live process for the new model.

Useful override:

```bash
OPENCLAW_BACKEND_BENCH_LIVE=1 node scripts/bench-agent-latency.mjs \
  --backend claude-bridge,claude-cli \
  --claude-model sonnet \
  --follow-up "Reply with one short sentence: warm follow-up ok." \
  --timeout-ms 180000
```
