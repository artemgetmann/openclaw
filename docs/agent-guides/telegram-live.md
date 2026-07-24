# Telegram live checks

Use this only when Telegram behavior itself is under test, or after the isolated
browser and agent smoke flow in `docs/agent-guides/browser-agent-e2e.md` has
already passed and you still need Telegram transport proof.

For Telegram UX bugs with visual acceptance criteria, use
`docs/agent-guides/gui-verification.md` for screenshot/video capture. Pair GUI
artifacts with transcript or log proof; screenshots alone do not prove Telegram
delivery semantics.
For progress-preview churn, final-answer stability, or TTS caption snippets,
follow the Telegram progress preview video proof subsection in that guide.

Do not use Telegram as the default first-pass E2E path for non-Telegram bugs.
For most agent/tool/browser issues, local OpenClaw CLI validation is the faster
and more reliable default.

## Choose the proof lane first

- Unmerged or risky Telegram work uses an isolated tester bot and an isolated
  worktree runtime. This includes restart, polling/watchdog, auth/pairing,
  offset/cursor, retry, load, and global-config work.
- Most parallel agents stop at local tests. Only Telegram-sensitive branches
  claim an exclusive tester lane; a tester token must never have two pollers.
- The real daily Jarvis bot is a serialized final acceptance canary only after
  merge and deployment. A disposable Jarvis Lab topic isolates conversation
  routing, not the gateway, token, cursor, config, provider quota, or runtime.
- Never replace tester lanes with the daily bot, and never let multiple agents
  use the daily bot concurrently.

For an approved daily-Jarvis canary, select the deployed source and preview the
zero-mutation plan first. Managed bundle remains the strict default:

```bash
bash scripts/prove-jarvis-telegram-runtime.sh --dry-run \
  --expected-commit <deployed-commit>
```

After `scripts/ship-jarvis-hotfix.sh`, use the explicit protected source instead:

```bash
bash scripts/prove-jarvis-telegram-runtime.sh --dry-run \
  --runtime-source jarvis-break-glass-hotfix \
  --expected-commit <deployed-commit>
```

Never retry a managed-source rejection by warming a tester lane. Packaged
releases use `jarvis-managed-bundle`; protected break-glass deployments use
`jarvis-break-glass-hotfix`; isolated worktree bots use
`telegram-live-runtime.sh ensure`. The canary never auto-falls back between
sources.

Run `--execute` only with fresh approval after the expected commit is deployed.
The harness targets `ai.jarvis.gateway`, acquires the machine-wide canary lock,
creates one uniquely named topic in the configured Jarvis Lab chat, records
runtime/transport/message evidence, and cleans only its exact topic and local
topic session. `sessions.delete` archives the transcript as
`*.deleted.<timestamp>`; that archive is residual evidence, not permanent
erasure.

## Required precheck before any live Telegram validation

- Confirm the current git branch has a real name and is not `HEAD`.
- Confirm the running gateway process belongs to the current worktree path.
- If the runtime path does not match, restart the gateway from this worktree before testing.
- Prefer `bash scripts/telegram-live-runtime.sh ensure` as the canonical fixer/checker for isolated Telegram tester lanes.
- Preferred operator surface now lives under `openclaw telegram ...`:
  - `openclaw telegram doctor`
  - `openclaw telegram runtime ensure`
  - `openclaw telegram runtime release`
  - `openclaw telegram smoke dm-reply`
- `bash scripts/telegram-live-preflight.sh` is read-only now; it inspects the derived isolated runtime profile and tells you when to run `ensure`.
- Confirm the running isolated gateway process belongs to the current worktree path before trusting Telegram replies.
- If `.env.local` is missing, run `bash scripts/assign-bot.sh`.
- Never print raw token values.
- Emit proof lines in logs or output:
  - `branch=<...>`
  - `runtime_worktree=<...>`

## Worktree bot setup

- Preferred worktree entrypoint: `bash scripts/new-worktree.sh <feature-name>`
- The helper creates repo-owned worktrees under `.worktrees/<feature-name>`.
- For each new worktree:
  - Copy `.env.bots` from the main checkout if needed
  - Run `bash scripts/assign-bot.sh`
- Telegram-as-user uses one machine-local canonical session and one shared
  machine lock. Bootstrap may copy non-session compatibility configuration, but
  it must never copy the SQLite session database into a worktree.
- Explicit session and lock overrides remain available for hermetic tests or a
  deliberately separate account. If legacy and canonical implicit sessions
  disagree, stop on the ambiguity diagnostic; do not copy, delete, rotate, or
  reauthenticate either database as an automatic repair.
- `.env.bots` is the tester-bot pool. Each `BOT_TOKEN=...` entry is one
  tester-only bot that can be claimed by one active worktree lane.
- `bash scripts/assign-bot.sh` writes the lane claim into `.env.local` as
  `TELEGRAM_BOT_TOKEN`, skips tokens reserved by the stable/main config, and
  refuses to continue when the pool is exhausted.
- One active Telegram runtime lane equals one exclusive tester bot token. Do
  not share a bot token across two live runtimes; Telegram long-polling is
  single-owner and the loser will produce fake failures.
- Tester tokens also carry a durable scenario reservation above the live PID
  polling lease. For a multi-step scripted flow, pin the scenario explicitly:

  ```bash
  OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID=<stable-run-id> \
    bash scripts/telegram-live-runtime.sh ensure
  ```

  Reusing that ID from the same worktree resumes the same bot across gateway
  or subprocess restarts. A different worktree/scenario cannot take it merely
  because the poller exited. Without an explicit ID, the first assignment
  creates a fresh UUID-backed run ID and persists it in `.env.local`; process
  restarts resume it, while a newly recreated worktree at the same path cannot
  impersonate the old run.

- End the ownership lifecycle only through
  `bash scripts/telegram-live-runtime.sh release`. Release validates the exact
  token, scenario, canonical worktree, and reservation generation; clears the
  local claim while holding the reservation lock; then makes the bot
  claimable. Do not hand-edit `.env.local` or reservation files.
- A pre-reservation lane whose `.env.local` has a token but no scenario
  generation must perform a one-time canonical `release`, then `ensure`.
  Likewise, the exact owner of an expired generation must `release`, then
  `ensure`; it cannot replace its generation in place. Ensure, release, and
  handoff-main share one worktree-profile lifecycle lock across normal and ACP
  modes, so the reset cannot race a restart. Release preserves unrelated local
  env settings.
- Reservations renew on `ensure` and expire after seven days by default.
  An unassigned scenario/worktree may reclaim an expired reservation only when
  the process-level polling lease is known absent; the exact prior owner uses
  the explicit release boundary above. Malformed reservation/lock state fails
  closed. A crash-persistent lock is never auto-deleted because a read/remove
  recovery race can erase a newer owner's lock. Stop and inspect its
  `owner.json`; recovery is an explicit operator action after proving no owner
  or polling lease is active.
- The first runtime for a new reservation generation performs a transport-only
  negative-offset `getUpdates` fence before starting the runner or any model
  dispatch. Its receipt is scoped to token hash, account, and reservation
  generation, so old pending updates cannot reach another full-parity tester
  runtime while same-scenario restarts do not repeatedly discard new messages.
  Safe-reuse generations fail closed in webhook mode until an equivalent
  pre-dispatch webhook fence exists.
- Worktree tester baselines strip inherited Telegram secrets on purpose. If the
  source config had named Telegram accounts, the bootstrap writes non-secret
  strip metadata to the baseline `auth-sync.json`, and
  `bash scripts/telegram-live-preflight.sh` prints the affected account ids.
  Refresh those named accounts with their own `tokenFile`/`botToken`, or disable
  them, before testing named-account bots.

## Common tools

- High-level workflow/operator path:
  - `pnpm openclaw:local telegram doctor --chat @jarvis_tester_1_bot`
  - `pnpm openclaw:local telegram runtime ensure`
  - `pnpm openclaw:local telegram smoke dm-reply --chat @jarvis_tester_1_bot --json`
  - `pnpm openclaw:local telegram smoke reply-contract --chat @jarvis_tester_1_bot --json`
- Reusable live E2E harness:
  - `pnpm openclaw:local telegram smoke baseline --json`
    - Wiring proof only: runtime ownership, bot claim, userbot session, send/read/wait.
    - A baseline pass is not merge proof for a feature change.
  - `pnpm openclaw:local telegram smoke reply-contract --json`
    - Tester-bot proof only: requires `STARTING <proof-id>`, then structured
      `FINISHED <proof-id>` fields or `BLOCKED <proof-id> reason=... last_step=...`.
    - Blank tester replies are failures, even when Telegram delivered a message.
  - `pnpm openclaw:local telegram scenario tts-final-caption --json`
    - Feature-specific proof for final caption behavior after TTS output.
  - `pnpm openclaw:local telegram scenario progress-long-task --json`
    - Feature-specific proof for progress updates during a long task.
  - `pnpm openclaw:local telegram scenario progress-plus-tts --json`
    - Feature-specific proof for progress updates plus TTS final output.
  - Run baseline first to prove the lane is wired, then run the smallest
    feature-specific scenario that matches the code change.
  - For progress/status/final/TTS behavior, use
    `/agent-guides/telegram-progress-proof` after baseline. It defines the
    message-ID and GUI proof bar for transient progress, durable media, final
    text, and additive TTS.
  - Release the lane when done: `bash scripts/telegram-live-runtime.sh release`.
- Goal/monitor persistence proof:
  - The isolated Telegram runtime disables cron by default to prevent stale jobs
    from producing fake chat activity during ordinary smoke checks.
  - For features that must prove scheduled monitor wakes or goal continuation,
    restart the isolated lane with
    `OPENCLAW_TELEGRAM_LIVE_ENABLE_CRON=1 pnpm openclaw:local telegram runtime ensure`.
  - Capture both the user-visible Telegram transcript and scheduler evidence
    (`cron.list`, `cron.runs`, or logs showing `cron: timer armed` and a
    delivered run). A manually forced `cron run` proves delivery semantics, not
    unattended persistence.
- User E2E operator path:
  - Start broad triage with `openclaw telegram-user inbox --json`
  - Use `openclaw telegram-user inbox --unread --json` for unread-only sweeps
  - Use `openclaw telegram-user inbox --contains <text> --json` for known chat labels or preview text
  - Narrow with `--dm-only` and `--limit` when you only need a lighter scan
  - Use `openclaw telegram-user read --chat <chat> --contains <text> --limit <n> --format compact` for known message text
  - Use `openclaw telegram-user read --chat <chat> --limit <n> --format compact` only after picking the target chat
  - If you need raw Telegram metadata for debugging, add `--json`; otherwise prefer compact reads to avoid clipped model/tool output
  - If a proof creates a temporary forum topic, delete that exact topic with `openclaw telegram-user topic-delete --chat <chat> --topic-anchor <topic_anchor> --json`
  - Do not pipe Telegram JSON to `grep` for chat/message discovery when these CLI filters fit
  - Then continue with `precheck`, `send`, or `wait` on that chosen chat
- Full repo-local details:
  - `scripts/telegram-e2e/README.md`

## Known failure pattern

- A live Telegram test can fail even when code is correct if the wrong runtime process owns the gateway. Prove runtime ownership before debugging behavior.
