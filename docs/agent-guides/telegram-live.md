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
- `.env.bots` is the tester-bot pool. Each `BOT_TOKEN=...` entry is one
  tester-only bot that can be claimed by one active worktree lane.
- `bash scripts/assign-bot.sh` writes the lane claim into `.env.local` as
  `TELEGRAM_BOT_TOKEN`, skips tokens reserved by the stable/main config, and
  refuses to continue when the pool is exhausted.
- One active Telegram runtime lane equals one exclusive tester bot token. Do
  not share a bot token across two live runtimes; Telegram long-polling is
  single-owner and the loser will produce fake failures.
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
- Reusable live E2E harness:
  - `pnpm openclaw:local telegram smoke baseline --json`
    - Wiring proof only: runtime ownership, bot claim, userbot session, send/read/wait.
    - A baseline pass is not merge proof for a feature change.
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
  - Do not pipe Telegram JSON to `grep` for chat/message discovery when these CLI filters fit
  - Then continue with `precheck`, `send`, or `wait` on that chosen chat
- Full repo-local details:
  - `scripts/telegram-e2e/README.md`

## Known failure pattern

- A live Telegram test can fail even when code is correct if the wrong runtime process owns the gateway. Prove runtime ownership before debugging behavior.
