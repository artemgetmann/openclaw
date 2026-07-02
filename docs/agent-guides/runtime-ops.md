# Runtime operations

## exe.dev VMs

- Access path: `ssh exe.dev`, then `ssh vm-name`.
- If SSH is flaky, use the exe.dev web terminal or Shelley and keep a tmux session for long work.
- Update OpenClaw with:
  - `sudo npm i -g openclaw@latest`
- Ensure `gateway.mode=local` is set.

## Gateway restart and checks

- Main bot rule: validate fixes from a temp worktree first when possible, using a tester bot or other isolated runtime. The long-lived LaunchAgent gateway for the primary bot must still be rebuilt and restarted from the sacred `main` home clone with `main` checked out.
- Runtime surgery may happen from `~/Programming_Projects/openclaw` because that sacred home clone owns the shared LaunchAgent. That does not make it a coding surface. If runtime debugging reveals a code fix, patch it in a temp worktree, validate it there, then switch the sacred home clone back to `main`, fast-forward, rebuild, and restart.
- Shared-runtime ownership rule:
  - the default shared main bot runtime must boot from `~/Programming_Projects/openclaw` on `main`
  - feature worktrees must not own the default shared runtime
  - the safe test paths are:
    - isolated tester bot/runtime with explicit profile or config isolation
    - merge to `main`, then restart the shared runtime from the sacred home clone
  - verify current ownership before live testing with `pnpm openclaw gateway status`
  - on the `Runtime ID:` line, confirm `branch=main` and `worktree=~/Programming_Projects/openclaw` before using the sacred main bot
- Canonical shared-runtime rule:
  - Do not run raw `pnpm build`, raw `node dist/index.js ...`, or any shell-default Node command from `/Users/user/Programming_Projects/openclaw`.
  - The shell may be on Node 25 while the shared runtime is pinned to Node `22.22.1`.
  - Use the guarded entrypoints instead:
    - `bash scripts/deploy-shared-main-runtime.sh` after merged runtime code needs to be deployed from clean sacred `main`
    - `bash scripts/build-shared-runtime.sh`
    - `openclaw gateway restart`
    - `bash scripts/gateway-recover-main.sh`
    - `bash scripts/restart-mac.sh`
- Main runtime deploy/proof:
  - Use `bash scripts/deploy-shared-main-runtime.sh` from `/Users/user/Programming_Projects/openclaw` on clean `main` after PRs merge. It fast-forwards, stops only `ai.openclaw.gateway`, rebuilds via `scripts/build-shared-runtime.sh`, reinstalls/kickstarts the canonical LaunchAgent, and prints compact commit/PID/Node/RPC/listener proof.
  - Use `bash scripts/gateway-recover-main.sh` for unhealthy runtime recovery. It can no-op when the gateway is already healthy; do not use it as the deploy-after-merge command.
  - Use `bash scripts/prove-main-telegram-runtime.sh` for live Telegram proof. It resolves the active `[default]` Telegram bot from current gateway logs/config, not old `.artifacts/telegram-smoke/*` files, sends a nonce, waits for the exact nonce reply, then checks the watchdog window for polling stalls.
- Restart:
  - `pkill -9 -f openclaw-gateway || true`
  - `nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &`
- Verify with:
  - `openclaw channels status --probe`
  - `ss -ltnp | rg 18789`
  - `tail -n 120 /tmp/openclaw-gateway.log`

## Timeout triage gate

- Before debugging a timeout, first prove the expected fix exists on the current branch and build.
- Required 2-minute checks:
  - `git rev-parse --abbrev-ref HEAD`
  - `git log --oneline -1`
  - `rg` for the expected patch signature in the touched files
- If the signature is missing, stop debugging and sync the missing code first.

## macOS gateway behavior

- The gateway is managed by the mac app.
- Default CLI commands use `~/.openclaw`, but packaged Jarvis does not. The
  Jarvis-managed packaged service uses:
  - home: `~/Library/Application Support/Jarvis`
  - state: `~/Library/Application Support/Jarvis/.jarvis`
  - config: `~/Library/Application Support/Jarvis/.jarvis/openclaw.json`
  - main-agent auth store:
    `~/Library/Application Support/Jarvis/.jarvis/agents/main/agent/auth-profiles.json`
- If `models status --probe` prints `Auth store: ~/.openclaw/...`, it is
  probing the default CLI store, not packaged Jarvis. For the live packaged
  service, use:

```bash
OPENCLAW_HOME="$HOME/Library/Application Support/Jarvis" \
OPENCLAW_STATE_DIR="$HOME/Library/Application Support/Jarvis/.jarvis" \
OPENCLAW_CONFIG_PATH="$HOME/Library/Application Support/Jarvis/.jarvis/openclaw.json" \
  pnpm openclaw models status --probe \
    --probe-provider openai-codex \
    --probe-profile openai-codex:default \
    --probe-timeout 60000 \
    --probe-concurrency 1 \
    --probe-max-tokens 8
```

- Use the narrowest restart that matches the job:
  - Gateway service only: `openclaw gateway restart`
  - Worktree mac app lane: `bash scripts/dev-launch-mac.sh`
  - Consumer mac app lane: `bash scripts/open-consumer-mac-app.sh --instance <id>`
  - Shared/main full app rebuild + restart: `bash scripts/restart-mac.sh`
- Shared `main` restart behavior:
  - `openclaw gateway restart` keeps the fast `launchctl kickstart` path when the shared LaunchAgent is already healthy and pinned to the canonical `main` runtime.
  - If the shared LaunchAgent is unhealthy or the fast path fails with a loaded-but-bad service, restart escalates to `scripts/gateway-recover-main.sh`, which now rebuilds via `scripts/build-shared-runtime.sh` so the canonical runtime always uses validated Node `22.22.1`.
- Startup guardrail:
  - the gateway now refuses to boot the default shared runtime from a non-canonical checkout
  - if you see that refusal, do not work around it by continuing in a feature worktree
  - either move the runtime back to the sacred home clone on `main`, or use an isolated tester runtime
  - the only break-glass bypass is `OPENCLAW_ALLOW_NONCANONICAL_SHARED_RUNTIME=1`, and that should stay emergency-only
- `scripts/restart-mac.sh` still has an explicit broad kill path via `--app-scope all`; do not use it as the default from linked worktrees.
- Use `scripts/clawlog.sh` for macOS unified logs.
- Temporary worktrees are the required implementation surface for development and pre-merge validation. The primary bot still must run from `main`, not from a worktree build. The `main` sacred home clone stays on `main`; shared-runtime restarts happen only after that clone is back on clean, fast-forwarded `main`.

## Shared-Main Ship Lane

For a PR that explicitly needs shared-main deploy proof after merge, use:

```bash
bash scripts/ship-main-gateway-fix.sh --pr <number> --live-telegram-restart
```

The wrapper refuses non-`main` PR targets, waits on the quiet `pr-required`
helper, merges only after required checks pass, fast-forwards the sacred
`~/Programming_Projects/openclaw` clone, rebuilds with
`scripts/build-shared-runtime.sh`, recovers with
`scripts/gateway-recover-main.sh`, and prints the standard closeout block.

That default scope is `ai.openclaw.gateway` only. It is not Jarvis-managed
runtime proof. For founder Jarvis/Telegram proof, use the explicit Jarvis scope:

```bash
bash scripts/ship-main-gateway-fix.sh --pr <number> --runtime-scope jarvis
```

Jarvis scope fast-forwards the sacred main clone after merge, then runs
`scripts/prove-jarvis-runtime.sh --expected-commit <main sha>`. It is read-only:
it must prove `ai.jarvis.gateway`, Jarvis app-support state, and
`runtimeSource=jarvis-managed-bundle`; it does not rebuild, restart, bootout,
install, mutate `ai.openclaw.gateway`, or touch `/Applications/Jarvis.app`.
If the Jarvis bundle is stale, that is the result: request explicit approval for
the bundle refresh/relaunch step before claiming Telegram UX proof.

For managed `web_search` / `web_fetch` backend proof, use
`/agent-guides/managed-web`. That runbook keeps config presence, backend
provider smoke, runtime commit proof, local provider env scrub, and
`/Applications/Jarvis.app` mutation state separate.

When a newer Jarvis app-support runtime has been seeded from a local build but
`/Applications/Jarvis.app` still contains an older bundled runtime, protect the
live state before handing the machine back:

```bash
bash scripts/protect-jarvis-runtime-from-app-reseed.sh \
  --expected-live-commit <live-runtime-commit> \
  --apply
```

This does not touch `/Applications/Jarvis.app`. It writes a compatibility
manifest plus an audit marker under
`~/Library/Application Support/Jarvis/.jarvis` so reopening the old app does not
silently reseed over the fixed app-support runtime. Treat
`scripts/prove-jarvis-runtime.sh` as the runtime truth after this protection;
the compatibility manifest exists only to keep older app binaries from
downgrading the live bundle while Jarvis app releases are batched.

Use `--dry-run` before the first live rollout or whenever the PR/runtime state
is not obvious. Use `--skip-live` only when the proof level is intentionally
`L2`; shared runtime, LaunchAgent, bot restart, and Telegram transport changes
should normally go to `L3`.

The live restart smoke is:

```bash
OPENCLAW_MAIN_GATEWAY_SMOKE_CHAT=<chat-or-username> \
  bash scripts/smoke-main-gateway-restart.sh
```

It proves branch, worktree, commit, PID/listener/RPC preflight, sends the
Telegram restart request, confirms it, waits for a restart transition, verifies
the recovered runtime is sacred `main`, and emits compact JSON proof. If the
model-mediated confirmation path is too noisy for an incident, use
`--direct-restart` to send `/restart` directly.
