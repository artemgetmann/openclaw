#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
HELPER_MODULE="${SCRIPT_DIR}/lib/telegram-live-runtime-helpers.mjs"

WORKTREE="$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)"
if [[ -d "$WORKTREE" ]]; then
  WORKTREE="$(cd "$WORKTREE" && pwd -P)"
fi
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"

RUNTIME_PORT=""
RUNTIME_STATE_DIR=""
RUNTIME_CONFIG_PATH=""
RUNTIME_PID=""
RUNTIME_WORKTREE=""
RUNTIME_OWNERSHIP="fail"
RUNTIME_CONFIG_PRESENT="no"
RUNTIME_CONFIG_TOKEN_PRESENT="no"
TOKEN_PRESENT="no"
TOKEN_FINGERPRINT="none"
TOKEN_CLAIM_COUNT=0
ASSIGNED_BOT_ID="unknown"
ASSIGNED_BOT_USERNAME="unknown"
ASSIGNED_BOT_NAME="unknown"
FAIL=0

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

strip_outer_quotes() {
  local value="$1"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    printf '%s' "${value:1:${#value}-2}"
    return
  fi
  if [[ "$value" == \'*\' && "$value" == *\' ]]; then
    printf '%s' "${value:1:${#value}-2}"
    return
  fi
  printf '%s' "$value"
}

parse_env_assignment() {
  local key="$1"
  local line="$2"
  local parsed=""
  if [[ "$line" =~ ^(export[[:space:]]+)?${key}[[:space:]]*=[[:space:]]*(.*)$ ]]; then
    parsed="$(trim "${BASH_REMATCH[2]}")"
    parsed="$(strip_outer_quotes "$parsed")"
  fi
  printf '%s' "$parsed"
}

read_last_env_value() {
  local file_path="$1"
  local key="$2"
  local line=""
  local trimmed=""
  local parsed=""
  local last_value=""

  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="$(trim "$line")"
    if [[ -z "$trimmed" || "$trimmed" == \#* ]]; then
      continue
    fi
    parsed="$(parse_env_assignment "$key" "$trimmed")"
    if [[ -n "$parsed" ]]; then
      last_value="$parsed"
    fi
  done < "$file_path"

  printf '%s' "$last_value"
}

mask_token() {
  local token="$1"
  local len=${#token}
  if (( len <= 4 )); then
    printf '****'
    return
  fi
  if (( len <= 8 )); then
    printf '%s...%s' "${token:0:1}" "${token:len-1:1}"
    return
  fi
  printf '%s...%s' "${token:0:4}" "${token:len-4:4}"
}

resolve_profile() {
  local profile_lines
  profile_lines="$(
    WORKTREE_PATH="$WORKTREE" node --input-type=module - "$HELPER_MODULE" <<'NODE'
import { pathToFileURL } from "node:url";

const [helperPath] = process.argv.slice(2);
const helpers = await import(pathToFileURL(helperPath).href);
const profile = helpers.deriveTelegramLiveRuntimeProfile({
  worktreePath: process.env.WORKTREE_PATH,
});

process.stdout.write(`${String(profile.runtimePort)}\n${profile.runtimeStateDir}\n`);
NODE
  )"

  RUNTIME_PORT="$(printf '%s\n' "$profile_lines" | sed -n '1p')"
  RUNTIME_STATE_DIR="$(printf '%s\n' "$profile_lines" | sed -n '2p')"
  RUNTIME_CONFIG_PATH="${RUNTIME_STATE_DIR}/openclaw.telegram-live.json"
}

resolve_runtime_owner() {
  RUNTIME_PID=""
  RUNTIME_WORKTREE=""
  RUNTIME_OWNERSHIP="fail"

  if [[ -z "$RUNTIME_PORT" ]]; then
    return
  fi

  local pids
  pids="$(lsof -nP -tiTCP:"${RUNTIME_PORT}" -sTCP:LISTEN 2>/dev/null || true)"
  local count
  count="$(printf '%s\n' "$pids" | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')"

  if [[ "$count" != "1" ]]; then
    return
  fi

  RUNTIME_PID="$(printf '%s\n' "$pids" | sed -n '1p' | tr -d '[:space:]')"
  RUNTIME_WORKTREE="$(lsof -a -p "$RUNTIME_PID" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | sed -n '1p')"
  if [[ -n "$RUNTIME_WORKTREE" && "$RUNTIME_WORKTREE" == "$WORKTREE" ]]; then
    RUNTIME_OWNERSHIP="ok"
  fi
}

inspect_runtime_config() {
  if [[ -f "$RUNTIME_CONFIG_PATH" ]]; then
    RUNTIME_CONFIG_PRESENT="yes"
  fi

  local config_token=""
  config_token="$(
    RUNTIME_CONFIG_PATH="$RUNTIME_CONFIG_PATH" node --input-type=module - <<'NODE'
import fs from "node:fs";

const configPath = process.env.RUNTIME_CONFIG_PATH;
if (!configPath || !fs.existsSync(configPath)) {
  process.exit(0);
}

try {
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const token =
    parsed &&
    typeof parsed === "object" &&
    parsed.channels &&
    typeof parsed.channels === "object" &&
    parsed.channels.telegram &&
    typeof parsed.channels.telegram === "object" &&
    typeof parsed.channels.telegram.botToken === "string"
      ? parsed.channels.telegram.botToken.trim()
      : "";
  if (token) {
    process.stdout.write(token);
  }
} catch {
  process.exit(0);
}
NODE
  )"

  if [[ -n "$config_token" ]]; then
    RUNTIME_CONFIG_TOKEN_PRESENT="yes"
  fi
}

resolve_token_claim() {
  local env_local="${REPO_ROOT}/.env.local"
  local token=""

  if [[ -f "$env_local" ]]; then
    token="$(read_last_env_value "$env_local" "TELEGRAM_BOT_TOKEN")"
  fi

  if [[ -z "$token" ]]; then
    return
  fi

  TOKEN_PRESENT="yes"
  TOKEN_FINGERPRINT="$(mask_token "$token")"
  if [[ "$token" == *:* ]]; then
    ASSIGNED_BOT_ID="${token%%:*}"
  fi

  local worktree_path=""
  local env_local_path=""
  local claimed=""
  while IFS= read -r worktree_path || [[ -n "${worktree_path}" ]]; do
    [[ -z "${worktree_path}" ]] && continue
    env_local_path="${worktree_path}/.env.local"
    [[ -f "${env_local_path}" ]] || continue
    claimed="$(read_last_env_value "${env_local_path}" "TELEGRAM_BOT_TOKEN")"
    if [[ -n "$claimed" && "$claimed" == "$token" ]]; then
      TOKEN_CLAIM_COUNT=$((TOKEN_CLAIM_COUNT + 1))
    fi
  done < <(git worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')

  if command -v python3 >/dev/null 2>&1; then
    local identity=""
    identity="$(
      TELEGRAM_BOT_TOKEN="$token" python3 - <<'PY' 2>/dev/null || true
import json
import os
import urllib.request

token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
if not token:
    raise SystemExit(0)

req = urllib.request.Request(
    f"https://api.telegram.org/bot{token}/getMe",
    headers={"User-Agent": "openclaw-telegram-live-preflight"},
)
with urllib.request.urlopen(req, timeout=10) as response:
    data = json.load(response)
result = data.get("result") or {}
print(json.dumps({
    "id": result.get("id"),
    "username": result.get("username"),
    "name": result.get("first_name"),
}))
PY
    )"

    if [[ -n "$identity" ]]; then
      ASSIGNED_BOT_ID="$(python3 -c 'import json,sys; data=json.loads(sys.stdin.read()); print(data.get("id") or "unknown")' <<<"${identity}" 2>/dev/null || printf '%s' "${ASSIGNED_BOT_ID}")"
      ASSIGNED_BOT_USERNAME="$(python3 -c 'import json,sys; data=json.loads(sys.stdin.read()); print(data.get("username") or "unknown")' <<<"${identity}" 2>/dev/null || printf 'unknown')"
      ASSIGNED_BOT_NAME="$(python3 -c 'import json,sys; data=json.loads(sys.stdin.read()); print(data.get("name") or "unknown")' <<<"${identity}" 2>/dev/null || printf 'unknown')"
    fi
  fi
}

resolve_profile
resolve_runtime_owner
inspect_runtime_config
resolve_token_claim

if [[ -z "${BRANCH}" || "${BRANCH}" == "HEAD" ]]; then
  FAIL=1
fi
if [[ "${TOKEN_PRESENT}" != "yes" ]]; then
  FAIL=1
fi
if [[ "${TOKEN_CLAIM_COUNT}" -gt 1 ]]; then
  FAIL=1
fi
if [[ -z "${RUNTIME_PID}" || "${RUNTIME_OWNERSHIP}" != "ok" ]]; then
  FAIL=1
fi

echo "branch=${BRANCH}"
echo "worktree=${WORKTREE}"
echo "runtime_port=${RUNTIME_PORT}"
echo "runtime_pid=${RUNTIME_PID}"
echo "runtime_worktree=${RUNTIME_WORKTREE}"
echo "runtime_ownership=${RUNTIME_OWNERSHIP}"
echo "runtime_config_path=${RUNTIME_CONFIG_PATH}"
echo "runtime_config_present=${RUNTIME_CONFIG_PRESENT}"
echo "runtime_config_token_present=${RUNTIME_CONFIG_TOKEN_PRESENT}"
echo "token_present=${TOKEN_PRESENT}"
echo "token_fingerprint=${TOKEN_FINGERPRINT}"
echo "token_claim_count=${TOKEN_CLAIM_COUNT}"
echo "assigned_bot_id=${ASSIGNED_BOT_ID}"
echo "assigned_bot_username=${ASSIGNED_BOT_USERNAME}"
echo "assigned_bot_name=${ASSIGNED_BOT_NAME}"
echo "next_action=bash scripts/telegram-live-runtime.sh ensure"

if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
