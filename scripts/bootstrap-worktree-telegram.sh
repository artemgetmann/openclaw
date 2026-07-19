#!/usr/bin/env bash
set -euo pipefail

MAIN_REPO_DEFAULT="/Users/user/Programming_Projects/openclaw"
MAIN_REPO="${OPENCLAW_MAIN_REPO:-$MAIN_REPO_DEFAULT}"
OPTIONAL=0
COPY_ONLY=0

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
    --copy-only)
      COPY_ONLY=1
      shift
      ;;
    --help|-h)
      cat <<'EOF'
Usage: scripts/bootstrap-worktree-telegram.sh [--optional|--strict|--copy-only]
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

# Copy canonical local Telegram assets before any best-effort tester claim. A
# full token pool must not block credential continuity into a fresh worktree.
copy_if_exists "$MAIN_REPO/scripts/telegram-e2e/.env" "./scripts/telegram-e2e/.env"
copy_if_exists "$MAIN_REPO/scripts/telegram-e2e/.env.local" "./scripts/telegram-e2e/.env.local"

# A Telethon session is a mutable SQLite database, not a credential blob that
# can be safely snapshotted into parallel worktrees. Resolve one machine-local
# owner and copy only its non-secret absolute path into the lane. Existing
# legacy locations remain usable, but multiple implicit owners fail closed
# instead of silently selecting whichever checkout happened to run first.
SESSION_SELECTOR="./scripts/telegram-e2e/tmp/userbot.session.path"
DEFAULT_MACHINE_SESSION="$HOME/.openclaw/telegram-user/userbot.session"
JARVIS_SESSION="$HOME/Library/Application Support/Jarvis/.jarvis/telegram-user/userbot.session"
ENV_FILE_SESSION=""
if [[ -f "./scripts/telegram-e2e/.env.local" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?USERBOT_SESSION[[:space:]]*=[[:space:]]*(.*)$ ]]; then
      ENV_FILE_SESSION="${BASH_REMATCH[2]}"
      ENV_FILE_SESSION="${ENV_FILE_SESSION%$'\r'}"
      ENV_FILE_SESSION="${ENV_FILE_SESSION#\"}"
      ENV_FILE_SESSION="${ENV_FILE_SESSION%\"}"
      ENV_FILE_SESSION="${ENV_FILE_SESSION#\'}"
      ENV_FILE_SESSION="${ENV_FILE_SESSION%\'}"
    fi
  done < "./scripts/telegram-e2e/.env.local"
fi
if [[ "$ENV_FILE_SESSION" == "$DEFAULT_MACHINE_SESSION" || \
  "$ENV_FILE_SESSION" == "$JARVIS_SESSION" || \
  "$ENV_FILE_SESSION" == "$MAIN_REPO/scripts/telegram-e2e/tmp/userbot.session" || \
  "$ENV_FILE_SESSION" == "$MAIN_REPO/scripts/telegram-e2e/userbot.session" ]]; then
  # Known historical defaults participate in implicit-owner ambiguity checks;
  # they are not separate-account overrides merely because an older env file
  # persisted them as absolute paths.
  ENV_FILE_SESSION=""
elif [[ -n "$ENV_FILE_SESSION" && "$ENV_FILE_SESSION" != /* ]]; then
  # Relative values keep flowing to the backend, which recognizes only the two
  # historical repo-local spellings. They must not redefine machine ownership
  # during bootstrap.
  ENV_FILE_SESSION=""
fi
EXPLICIT_MACHINE_SESSION="${OPENCLAW_TELEGRAM_USER_CANONICAL_SESSION:-$ENV_FILE_SESSION}"
MACHINE_SESSION="${EXPLICIT_MACHINE_SESSION:-$DEFAULT_MACHINE_SESSION}"
declare -a session_candidates=()
declare -a session_candidate_labels=()

add_session_candidate() {
  local label="$1"
  local candidate="$2"
  local existing=""
  [[ -f "$candidate" ]] || return 0
  candidate="$(cd "$(dirname "$candidate")" && pwd -P)/$(basename "$candidate")"
  for existing in "${session_candidates[@]:-}"; do
    [[ "$existing" == "$candidate" ]] && return 0
  done
  session_candidates+=("$candidate")
  session_candidate_labels+=("$label")
}

if [[ -z "$EXPLICIT_MACHINE_SESSION" ]]; then
  add_session_candidate "machine" "$MACHINE_SESSION"
  add_session_candidate "jarvis-state-legacy" "$JARVIS_SESSION"
  add_session_candidate "main-canonical-legacy" "$MAIN_REPO/scripts/telegram-e2e/tmp/userbot.session"
  add_session_candidate "main-legacy" "$MAIN_REPO/scripts/telegram-e2e/userbot.session"
  add_session_candidate "lane-legacy" "./scripts/telegram-e2e/tmp/userbot.session"
fi

if [[ "${#session_candidates[@]}" -gt 1 ]]; then
  printf 'E_AMBIGUOUS_SESSION: divergent implicit Telegram session owners exist (%s). Set an absolute USERBOT_SESSION or OPENCLAW_TELEGRAM_USER_CANONICAL_SESSION.\n' \
    "$(IFS=,; printf '%s' "${session_candidate_labels[*]}")" >&2
  exit 1
fi

canonical_session="$MACHINE_SESSION"
canonical_session_source="machine-default"
if [[ -n "$EXPLICIT_MACHINE_SESSION" ]]; then
  canonical_session_source="explicit-canonical"
fi
if [[ "${#session_candidates[@]}" -eq 1 ]]; then
  canonical_session="${session_candidates[0]}"
  canonical_session_source="${session_candidate_labels[0]}"
fi
if [[ "$canonical_session" != /* ]]; then
  echo "Error: canonical Telegram session path must be absolute." >&2
  exit 1
fi

mkdir -p "$(dirname "$SESSION_SELECTOR")"
selector_tmp="${SESSION_SELECTOR}.$$"
printf '%s\n' "$canonical_session" > "$selector_tmp"
chmod 600 "$selector_tmp"
mv "$selector_tmp" "$SESSION_SELECTOR"
echo "telegram_session_source=$canonical_session_source"
echo "telegram_lock_scope=machine"

# Bot token pool for worktree assignment.
copy_if_exists "$MAIN_REPO/.env.bots" "./.env.bots"

if [[ "$COPY_ONLY" -eq 1 ]]; then
  # Warm lanes still need the canonical userbot/env files, but they must not
  # auto-claim a tester token before the operator explicitly runs ensure.
  echo "telegram bootstrap complete"
  exit 0
fi

if [[ -f "./.env.bots" ]]; then
  assign_output="$({ bash scripts/assign-bot.sh; } 2>&1)" || {
    if [[ "$OPTIONAL" -eq 1 ]] && [[ "$assign_output" == *"no eligible tester bot tokens available"* ]]; then
      echo "warning: telegram tester claim deferred; pool exhausted after copying .env.bots" >&2
      echo "warning: run 'bash scripts/telegram-live-runtime.sh ensure' after releasing an unused tester lane" >&2
    else
      printf '%s\n' "$assign_output" >&2
      exit 1
    fi
  }
else
  echo "skip: .env.bots missing in main repo"
fi

echo "telegram bootstrap complete"
