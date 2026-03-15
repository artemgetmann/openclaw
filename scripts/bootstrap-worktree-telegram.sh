#!/usr/bin/env bash
set -euo pipefail

MAIN_REPO_DEFAULT="/Users/user/Programming_Projects/openclaw"
MAIN_REPO="${OPENCLAW_MAIN_REPO:-$MAIN_REPO_DEFAULT}"

if [[ ! -d "$MAIN_REPO" ]]; then
  echo "Main repo not found: $MAIN_REPO" >&2
  echo "Set OPENCLAW_MAIN_REPO to your main checkout path." >&2
  exit 1
fi

copy_if_exists() {
  local src="$1"
  local dst="$2"
  if [[ -f "$src" ]]; then
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
    echo "synced: ${dst}"
  fi
}

# Bot token pool for worktree assignment.
copy_if_exists "$MAIN_REPO/.env.bots" "./.env.bots"

if [[ -f "./.env.bots" ]]; then
  bash scripts/assign-bot.sh
else
  echo "skip: .env.bots missing in main repo"
fi

# Optional userbot E2E files for true inbound Telegram verification.
copy_if_exists "$MAIN_REPO/scripts/telegram-e2e/.env" "./scripts/telegram-e2e/.env"
copy_if_exists "$MAIN_REPO/scripts/telegram-e2e/.env.local" "./scripts/telegram-e2e/.env.local"
copy_if_exists \
  "$MAIN_REPO/scripts/telegram-e2e/tmp/userbot.session" \
  "./scripts/telegram-e2e/tmp/userbot.session"
copy_if_exists \
  "$MAIN_REPO/scripts/telegram-e2e/userbot.session" \
  "./scripts/telegram-e2e/userbot.session"

echo "telegram bootstrap complete"
