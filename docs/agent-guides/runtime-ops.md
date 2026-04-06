# Runtime operations

## exe.dev VMs

- Access path: `ssh exe.dev`, then `ssh vm-name`.
- If SSH is flaky, use the exe.dev web terminal or Shelley and keep a tmux session for long work.
- Update OpenClaw with:
  - `sudo npm i -g openclaw@latest`
- Ensure `gateway.mode=local` is set.

## Gateway restart and checks

- Main bot rule: validate fixes from a short-lived feature branch first when possible, using a tester bot or other isolated runtime. The long-lived LaunchAgent gateway for the primary bot must still be rebuilt and restarted from the `main` home clone with `main` checked out.
- Runtime surgery may happen from `~/Programming_Projects/openclaw` because that home clone owns the shared LaunchAgent. That does not mean you should restart the shared runtime from a feature branch. If runtime debugging reveals a code fix, patch it on the feature branch, validate it there, then switch the home clone back to `main`, fast-forward, rebuild, and restart.
- Canonical shared-runtime rule:
  - Do not run raw `pnpm build`, raw `node dist/index.js ...`, or any shell-default Node command from `/Users/user/Programming_Projects/openclaw`.
  - The shell may be on Node 25 while the shared runtime is pinned to Node `22.22.1`.
  - Use the guarded entrypoints instead:
    - `bash scripts/build-shared-runtime.sh`
    - `openclaw gateway restart`
    - `bash scripts/gateway-recover-main.sh`
    - `bash scripts/restart-mac.sh`
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
- Use the narrowest restart that matches the job:
  - Gateway service only: `openclaw gateway restart`
  - Worktree mac app lane: `bash scripts/dev-launch-mac.sh`
  - Consumer mac app lane: `bash scripts/open-consumer-mac-app.sh --instance <id>`
  - Shared/main full app rebuild + restart: `bash scripts/restart-mac.sh`
- Shared `main` restart behavior:
  - `openclaw gateway restart` keeps the fast `launchctl kickstart` path when the shared LaunchAgent is already healthy and pinned to the canonical `main` runtime.
  - If the shared LaunchAgent is unhealthy or the fast path fails with a loaded-but-bad service, restart escalates to `scripts/gateway-recover-main.sh`, which now rebuilds via `scripts/build-shared-runtime.sh` so the canonical runtime always uses validated Node `22.22.1`.
- `scripts/restart-mac.sh` still has an explicit broad kill path via `--app-scope all`; do not use it as the default from linked worktrees.
- Use `scripts/clawlog.sh` for macOS unified logs.
- Temporary worktrees are valid for development and pre-merge validation when 2 or more agents need isolated parallel editing in the same clone. The primary bot still must run from `main`, not from a worktree build. The `main` home clone can host short-lived feature branches during development, but shared-runtime restarts still happen only after that clone is back on `main`.
