# Runtime operations

## exe.dev VMs

- Access path: `ssh exe.dev`, then `ssh vm-name`.
- If SSH is flaky, use the exe.dev web terminal or Shelley and keep a tmux session for long work.
- Update OpenClaw with:
  - `sudo npm i -g openclaw@latest`
- Ensure `gateway.mode=local` is set.

## Gateway restart and checks

- Daily Jarvis rule: Artem's normal founder bot is `ai.jarvis.gateway`, running
  from the packaged app's seeded runtime under
  `~/Library/Application Support/Jarvis/.jarvis`. A source checkout is not the
  daily steady state, even when its commit is newer.
- Shared developer rule: `ai.openclaw.gateway` is the source-checkout developer
  lane and must run from the sacred `main` home clone when used. Runtime surgery
  may happen there because that clone owns this shared LaunchAgent, but the clone
  is not a coding surface and the service is not packaged Jarvis proof.
- Validate fixes from a temp worktree first when possible, using a tester bot or
  other isolated runtime. If debugging reveals a code fix, patch and validate it
  in a temp worktree before choosing the managed-package ship lane or an explicit
  break-glass source hotfix.
- Shared-runtime ownership rule:
  - the shared `ai.openclaw.gateway` developer runtime must boot from `~/Programming_Projects/openclaw` on `main`
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
- Temporary worktrees are the required implementation surface for development
  and pre-merge validation. Daily Jarvis stays on the managed package/app-support
  runtime. The shared `ai.openclaw.gateway` developer service may run from sacred
  `main`, never a feature worktree; the sacred clone stays clean and
  fast-forwarded.

## Jarvis Runtime Shipping Lanes

Keep these lanes separate. They answer different questions, mutate different
state, and produce different proof:

### Canonical main-Jarvis hotfix wrapper

When Artem asks to “Ship this PR to my main Jarvis” or equivalent, use the
repo-native break-glass wrapper. Do not reconstruct these stages by hand:

```bash
cd /Users/user/Programming_Projects/openclaw
bash scripts/ship-jarvis-hotfix.sh --pr <number> --dry-run
bash scripts/ship-jarvis-hotfix.sh --pr <number>
```

For an OPEN PR, `--dry-run` cannot know the future merged `main` commit. Its
commit-dependent package, seed, protection, and proof plan therefore uses the
explicit `<post-merge-main>` placeholder and resolves the real commit only in
the live run after merge plus `git pull --ff-only`. Exact installed-app commit
comparison remains enabled for already-MERGED PR dry-runs.

The wrapper is intentionally narrower than a public release and stronger than
read-only Jarvis proof. It:

- refuses unless the sacred clone is clean, on `main`, and is the current
  working directory
- verifies the PR targets `main`, waits through `scripts/pr-required-status.sh`
  even when GitHub already reports it merged, merges when needed, then
  fast-forwards with `git pull --ff-only`
- rejects before packaging or runtime mutation when `/Applications/Jarvis.app`
  already bundles the merged commit; that is a managed-runtime proof case, not
  a break-glass hotfix
- preserves `/Applications/Jarvis.app`'s installed
  `CFBundleShortVersionString` as `APP_VERSION`, uses that same version for the
  normal canonical Sparkle build calculation, then selects
  `APP_BUILD=max(installed bundleVersion + 1, normal package-derived build)`
  before packaging. This prevents newer hotfix code from reporting the older
  source-tree package version.
- builds a host-architecture `dist/Jarvis.app` through the fast consumer
  package helper with explicit local single-architecture smoke flags and a
  fresh dependency install plus fresh JS/UI build. Canonical shipping never
  inherits `SKIP_PNPM_INSTALL=1` from the fast helper's iteration defaults.
- launches only `dist/Jarvis.app` so it seeds the default Jarvis app-support
  runtime; it does not replace `/Applications/Jarvis.app`
- verifies the built app version and bundled runtime `package.json` both match
  the preserved installed version before launch, then requires the live runtime
  to report that version during readiness and final proof
- immediately after observing the expected seed, installs and verifies the
  compatibility marker that protects it from the older installed app. If any
  later readiness or proof stage fails, the exit guard re-verifies that state
  (or completes and verifies an interrupted protection write) before returning
  the original nonzero result.
- kickstarts `ai.jarvis.gateway`, then waits for a replacement PID, that PID's
  port `18789` listener, the expected runtime commit, and deep RPC success
  before the live protection helper repeats its full daemon-bound proof
- runs `protect-jarvis-runtime-from-app-reseed.sh` first in its no-flag dry-run
  mode and then with `--apply`
- prints only selected proof: live runtime commit, PID, credential-free command,
  port, RPC, `runtime_source=jarvis-break-glass-hotfix`, current `[default]`
  Telegram bot when found in logs, and a one-way token fingerprint when a
  default config token is available. It never prints the token.

Every stage fails closed. A successful run means one Mac is running an explicit
app-support hotfix from merged `main`. It does not mean a public Jarvis update
was published, `/Applications/Jarvis.app` changed, or managed-bundle steady
state was restored. Replace the protected hotfix with a package-seeded runtime
through the managed release/update lane under the follow-up timing policy
below.

### Hotfix follow-up and release timing

A break-glass runtime hotfix and a signed/notarized Jarvis release solve
different timing problems. The hotfix restores one protected app-support
runtime quickly; a normal release makes packaged steady state available to
installed copies and public distribution. Do not assume that every merged
runtime PR or protected hotfix requires an immediate app release.

By default, leave a successful protected hotfix in place temporarily and batch
several merged, verified fixes into the next planned normal Jarvis release.
Keep its deployed commit and `runtime_source=jarvis-break-glass-hotfix`
provenance visible, and track the package-seeded replacement against a bounded
follow-up such as a named release or owner checkpoint. Batching saves operator
time, agent tokens, and repeated build/sign/notarization cycles without
pretending the temporary state is risk-free.

Package immediately instead when any of these triggers applies:

- protection is absent, failed, or no longer verifies
- the older installed app can overwrite the fixed runtime
- public or other installed users need the fix now
- security, compatibility, migration, or release-critical risk makes waiting
  unsafe
- the owner explicitly requests an immediate package or release

Protection reduces the normal downgrade risk; it does not eliminate every
path. Manual protection removal, app-support state reset, and unusual or older
reinstall paths can still restore stale packaged code. Re-evaluate release
urgency if one of those conditions appears. Until a trigger changes, describe
package work as deferred or batched into the next planned release, not as a
repeatedly urgent incident action.

1. Managed-package daily Jarvis
   - This is the steady state: `/Applications/Jarvis.app` seeds the
     `ai.jarvis.gateway` payload under Jarvis Application Support.
   - Use `scripts/prove-jarvis-runtime.sh --expected-commit <package-sha>` for
     read-only proof. It succeeds only when the running commit matches the
     installed package receipt and reports `runtime_source=jarvis-managed-bundle`.
   - A merged source commit is not live Jarvis proof. Refresh/release the managed
     package lane when the daily bot must adopt it.
   - `scripts/package-openclaw-mac-dist.sh --local-proof` validates a package but
     does not install or relaunch it, so it cannot restore steady-state ownership.
     Use the public release or Sparkle update lane to replace
     `/Applications/Jarvis.app`; otherwise the older installed app can reseed
     over a one-off `dist/Jarvis.app` launch later.

2. Explicit break-glass source hotfix
   - Use this only when a tested fix must reach `ai.jarvis.gateway` before the
     replacement package is ready and the user approved the app-support mutation.
   - Merge first and fast-forward sacred `main`; never copy unmerged worktree
     output into the daily runtime.
   - A source-refreshed or protected payload must report
     `runtime_source=jarvis-break-glass-hotfix`. It is intentionally rejected by
     `scripts/prove-jarvis-runtime.sh`, because that script proves package-seeded
     provenance, not merely a healthy process at a managed-looking path.
   - If the installed app is older, run
     `scripts/protect-jarvis-runtime-from-app-reseed.sh --expected-live-commit <sha>`
     in dry-run mode first, then use `--apply` only after verifying the exact
     runtime being protected. Replace this temporary state with a package-seeded
     runtime after the incident.
   - `scripts/open-consumer-mac-app.sh --refresh-gateway` is for isolated
     source-checkout debug lanes. On the default Jarvis instance it would make
     `ai.jarvis.gateway` run from the current checkout, so it is break-glass,
     not `jarvis-managed-bundle` proof.

3. Public macOS app release
   - Use this only for a sendable Jarvis DMG/app update or Sparkle release.
   - Start from `bash scripts/jarvis-release-worktree.sh`, then follow
     `apps/macos/README.md` and `scripts/jarvis-public-release.sh`.
   - This lane owns package artifacts, notarization, appcast generation, and
     release asset publishing. It is not the default post-merge runtime ship
     path.

Optional Telegram proof belongs after the runtime proof it depends on. For
shared-main Telegram proof, use `scripts/prove-main-telegram-runtime.sh` or the
`--live-telegram-restart` option on `scripts/ship-main-gateway-fix.sh`. For
worktree tester-bot proof, start with `bash scripts/telegram-live-runtime.sh
ensure`, then run the smallest feature-specific `pnpm openclaw:local telegram
smoke ...` or `pnpm openclaw:local telegram scenario ...` command. Capture the
unique prompt token, bot username, token fingerprint, message IDs, and the
relevant send path lines, including `sendRichMessage ok` when rich Telegram
rendering is under test.

For the daily managed Jarvis bot, use the separate serialized canary lane only
after merge, deployment, and fresh approval:

```bash
bash scripts/prove-jarvis-telegram-runtime.sh --dry-run \
  --expected-commit <deployed-commit>
bash scripts/prove-jarvis-telegram-runtime.sh --execute \
  --expected-commit <deployed-commit>
```

That harness proves `ai.jarvis.gateway` and Jarvis Application Support,
acquires the machine-wide canary lock, uses one disposable Jarvis Lab topic,
and performs exact topic plus active-session cleanup. It does not make
`prove-main-telegram-runtime.sh` a managed-Jarvis proof.

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

Jarvis scope fast-forwards the sacred main clone only to establish expected
source truth after merge, then runs
`scripts/prove-jarvis-runtime.sh --expected-commit <main sha>`. It is read-only:
it must prove `ai.jarvis.gateway`, Jarvis app-support state, and
`runtimeSource=jarvis-managed-bundle`; it does not rebuild, restart, bootout,
install, mutate `ai.openclaw.gateway`, or touch `/Applications/Jarvis.app`.
If the Jarvis bundle is stale or protected by a source hotfix, that is the
result: request explicit approval for the managed bundle refresh/relaunch step
before claiming packaged Telegram UX proof.

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
silently reseed over the fixed app-support runtime. After protection, runtime
status must report `jarvis-break-glass-hotfix`, and
`scripts/prove-jarvis-runtime.sh` must reject the temporary state as packaged
proof. The compatibility manifest exists only to prevent downgrade while the
replacement Jarvis package is prepared.

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
