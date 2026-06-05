# Telegram live checks

Use this only when Telegram behavior itself is under test, or after the isolated
browser and agent smoke flow in `docs/agent-guides/browser-agent-e2e.md` has
already passed and you still need Telegram transport proof.

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
  - Release the lane when done: `bash scripts/telegram-live-runtime.sh release`.
- User E2E operator path:
  - Start broad triage with `pnpm openclaw:local telegram-user inbox --json`
  - Use `pnpm openclaw:local telegram-user inbox --unread --json` for unread-only sweeps
  - Narrow with `--dm-only` and `--limit` when you only need a lighter scan
  - Use `pnpm openclaw:local telegram-user read --chat <chat> --limit <n> --json` only after picking the target chat
  - Then continue with `precheck`, `send`, or `wait` on that chosen chat
- Full repo-local details:
  - `scripts/telegram-e2e/README.md`

## Jarvis Consumer RC onboarding

- Keep RC app testing isolated. Do not touch `/Applications/Jarvis.app` or the
  shared `ai.openclaw.gateway` while proving `Jarvis Consumer.app`.
- Hard rule: when the user is actively using the Mac, Telegram Desktop Start,
  BotFather managed bot creation, and one-more-message/follow-up DM steps are
  human handoff steps. Ask the human to do the live Telegram action, then wait
  until they say ready before opening Telegram or collecting proof.
- Do not fight Spaces/frontmost state with coordinate clicks, Computer Use,
  Peekaboo, or `cliclick`. Telegram custom controls are often not exposed as
  accessibility elements, and a window capture does not prove Telegram is
  foreground or actionable. If the visible next step is a purple Telegram
  `Start` button and automation fails, stop and ask the user to click it.
- Do not send the first task before Jarvis reports the managed bot is connected
  and asks for the first DM. Messages sent while the runtime is still in
  pairing mode can produce an approval response instead of a real assistant
  reply, which is not sufficient proof.
- For command-menu proof, prefer this flow: the user opens the bot DM, types
  `/`, says ready, and the agent captures only the command menu area.
- Screenshots can expose private chats. Crop to the relevant command, menu, or
  setup area and avoid sharing full Telegram window captures.
- Exact first DM text: `Wake up my friend`.
- Expected clean product flow: user clicks `Start` -> Jarvis reports bot
  connected -> send `Wake up my friend` -> click `Verify Telegram` -> `Next`
  enabled. If Jarvis asks for another DM after that clean ordering, treat it as
  a launch blocker/product bug, not normal testing friction.
- Proof to collect:
  - Jarvis Consumer reached the managed-bot-created state with the bot username visible.
  - The first DM `Wake up my friend` was sent to that bot.
  - The bot replied in Telegram.
  - Jarvis Consumer advanced to `Telegram verified` or the equivalent enabled
    finish state after `Verify Telegram`.

## Known failure pattern

- A live Telegram test can fail even when code is correct if the wrong runtime process owns the gateway. Prove runtime ownership before debugging behavior.
