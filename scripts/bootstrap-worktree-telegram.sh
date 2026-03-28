#!/usr/bin/env bash
set -euo pipefail

MAIN_REPO_DEFAULT="/Users/user/Programming_Projects/openclaw"
MAIN_REPO="${OPENCLAW_MAIN_REPO:-$MAIN_REPO_DEFAULT}"
OPTIONAL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --optional)
      OPTIONAL=1
      shift
      ;;
    --strict)
      OPTIONAL=0
      shift
      ;;
    --help|-h)
      cat <<'EOF'
Usage: scripts/bootstrap-worktree-telegram.sh [--optional|--strict]
EOF
      exit 0
      ;;
    *)
      echo "Error: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

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
    if [[ ! -f "$dst" ]] || ! cmp -s "$src" "$dst"; then
      cp "$src" "$dst"
    fi
  fi
}

# Bot token pool for worktree assignment.
copy_if_exists "$MAIN_REPO/.env.bots" "./.env.bots"

if [[ -f "./.env.bots" ]]; then
  assign_output="$({ bash scripts/assign-bot.sh; } 2>&1)" || {
    if [[ "$OPTIONAL" -eq 1 ]] && [[ "$assign_output" == *"no eligible tester bot tokens available"* ]]; then
      echo "warning: telegram bot pool exhausted; skipping optional claim"
    else
      printf '%s\n' "$assign_output" >&2
      exit 1
    fi
  }
else
  echo "skip: .env.bots missing in main repo"
fi

# Optional userbot E2E files for true inbound Telegram verification.
copy_if_exists "$MAIN_REPO/scripts/telegram-e2e/.env" "./scripts/telegram-e2e/.env"
copy_if_exists "$MAIN_REPO/scripts/telegram-e2e/.env.local" "./scripts/telegram-e2e/.env.local"
if [[ -f "$MAIN_REPO/scripts/telegram-e2e/tmp/userbot.session" ]]; then
  copy_if_exists \
    "$MAIN_REPO/scripts/telegram-e2e/tmp/userbot.session" \
    "./scripts/telegram-e2e/tmp/userbot.session"
elif [[ -f "$MAIN_REPO/scripts/telegram-e2e/userbot.session" ]]; then
  copy_if_exists \
    "$MAIN_REPO/scripts/telegram-e2e/userbot.session" \
    "./scripts/telegram-e2e/tmp/userbot.session"
fi

echo "telegram bootstrap complete"
