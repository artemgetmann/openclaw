#!/usr/bin/env bash
set -euo pipefail

# End-to-end smoke runner for Telegram thread model inheritance:
# 1) Send `/model <set-model>` in thread A as user (MTProto).
# 2) Send `/model` in thread B as user.
# 3) Poll bot updates through tg (Bot API) and assert thread B reports expected model.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
USERBOT_ENV_LOCAL="${SCRIPT_DIR}/.env.local"

CHAT=""
SET_MODEL=""
EXPECT_MODEL=""
THREAD_A_REPLY_TO=""
THREAD_B_REPLY_TO=""
THREAD_B_ID=""

usage() {
  cat <<'USAGE'
Usage:
  run-model-inheritance-e2e.sh \
    --chat <chat> \
    --set-model <provider/model> \
    --thread-a-reply-to <msgId> \
    --thread-b-reply-to <msgId> \
    --thread-b-id <threadId> \
    [--expect-model <provider/model>]

Required environment:
  TELEGRAM_API_ID      Telegram API ID for user MTProto session
  TELEGRAM_API_HASH    Telegram API hash for user MTProto session
  TG_BIN               Path to tg binary (from your tg fork build)

Optional environment:
  TG_BOT               tg bot alias, if you configured multiple bots
  TG_BOT_TOKEN         bot token (`tg --token ...` + sender-id derive for fallback)
  TG_POLL_ATTEMPTS     Poll attempts (default: 10)
  TG_POLL_TIMEOUT      Per-poll timeout seconds (default: 20)
  TG_POLL_SLEEP        Sleep between polls seconds (default: 2)
  USERBOT_SESSION      Telethon session path
USAGE
}

load_repo_telegram_env_if_present() {
  if [[ -f "${USERBOT_ENV_LOCAL}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${USERBOT_ENV_LOCAL}"
    set +a
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --chat)
      CHAT="$2"
      shift 2
      ;;
    --set-model)
      SET_MODEL="$2"
      shift 2
      ;;
    --expect-model)
      EXPECT_MODEL="$2"
      shift 2
      ;;
    --thread-a-reply-to)
      THREAD_A_REPLY_TO="$2"
      shift 2
      ;;
    --thread-b-reply-to)
      THREAD_B_REPLY_TO="$2"
      shift 2
      ;;
    --thread-b-id)
      THREAD_B_ID="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "${CHAT}" || -z "${SET_MODEL}" || -z "${THREAD_A_REPLY_TO}" || -z "${THREAD_B_REPLY_TO}" || -z "${THREAD_B_ID}" ]]; then
  usage
  exit 1
fi

load_repo_telegram_env_if_present

if [[ -z "${TG_BIN:-}" ]]; then
  echo "Missing required env var: TG_BIN." >&2
  usage
  exit 1
fi

if [[ ! -x "${TG_BIN}" ]]; then
  echo "TG_BIN is not executable: ${TG_BIN}" >&2
  exit 1
fi

# Hard gate: ensure this worktree owns Telegram runtime before live assertions.
"${REPO_ROOT}/scripts/telegram-live-preflight.sh"

EXPECT_MODEL="${EXPECT_MODEL:-${SET_MODEL}}"

extract_json_payload() {
  RAW_OUTPUT="$1" python3 - <<'PY'
import json
import os
import sys

raw = os.environ["RAW_OUTPUT"]
start = raw.find("{")
if start < 0:
  print(raw, file=sys.stderr)
  raise SystemExit("Could not find JSON payload in command output.")

payload = raw[start:].strip()
data = json.loads(payload)
print(json.dumps(data, ensure_ascii=True))
PY
}

run_telegram_user_cli() {
  (
    cd "${REPO_ROOT}"
    pnpm openclaw:local telegram-user "$@"
  )
}

# Force an upfront health check so later send/wait failures read like Telegram
# problems instead of "nothing happened" when the user session itself is broken.
precheck_output="$(run_telegram_user_cli precheck --chat "${CHAT}" --json)"
precheck_json="$(extract_json_payload "${precheck_output}")"

TG_POLL_ATTEMPTS="${TG_POLL_ATTEMPTS:-10}"
TG_POLL_TIMEOUT="${TG_POLL_TIMEOUT:-20}"
TG_POLL_SLEEP="${TG_POLL_SLEEP:-2}"
TG_BOT_ID=""
if [[ -n "${TG_BOT_TOKEN:-}" ]]; then
  TG_BOT_ID="${TG_BOT_TOKEN%%:*}"
else
  TG_BOT_ID="$(
    PRECHECK_JSON="${precheck_json}" python3 - <<'PY'
import json
import os

chat_id = (json.loads(os.environ["PRECHECK_JSON"]).get("chat") or {}).get("chat_id")
print(int(chat_id or 0))
PY
  )"
fi

send_user_message() {
  local text="$1"
  local reply_to="$2"
  local send_output
  local send_json
  send_output="$(
    run_telegram_user_cli send \
      --chat "${CHAT}" \
      --message "${text}" \
      --reply-to "${reply_to}" \
      --json
  )"
  send_json="$(extract_json_payload "${send_output}")"
  # Return the raw send JSON so callers can inspect the exact Telegram metadata.
  printf '%s\n' "${send_json}"
}

wait_userbot_message() {
  local after_id="$1"
  local thread_anchor="$2"
  local contains="$3"
  local timeout="$4"
  local sender_id="${5:-0}"

  local wait_cmd=(
    run_telegram_user_cli
    wait
    --chat "${CHAT}"
    --after-id "${after_id}"
    --thread-anchor "${thread_anchor}"
    --contains "${contains}"
    --timeout-ms "$(( timeout * 1000 ))"
    --json
  )
  if [[ "${sender_id}" -gt 0 ]]; then
    wait_cmd+=(--sender-id "${sender_id}")
  fi
  "${wait_cmd[@]}" >/dev/null
}

tg_poll_json() {
  if [[ -n "${TG_BOT:-}" ]]; then
    "${TG_BIN}" --bot "${TG_BOT}" poll --json --save-offset --timeout "${TG_POLL_TIMEOUT}"
  elif [[ -n "${TG_BOT_TOKEN:-}" ]]; then
    "${TG_BIN}" --token "${TG_BOT_TOKEN}" poll --json --save-offset --timeout "${TG_POLL_TIMEOUT}"
  else
    "${TG_BIN}" poll --json --save-offset --timeout "${TG_POLL_TIMEOUT}"
  fi
}

find_thread_text() {
  local payload="$1"
  local needle="$2"
  jq -er \
    --argjson tid "${THREAD_B_ID}" \
    --arg needle "${needle}" \
    '
      [
        .. | objects | .message? // empty
        | select(
            (
              (.message_thread_id? // -1) == $tid
            ) or (
              (.direct_messages_topic?.topic_id? // -1) == $tid
            )
          )
        | .text? // empty
      ] | map(select(test($needle))) | length > 0
    ' <<<"${payload}" >/dev/null 2>&1
}

echo "Step 1: set model in thread A (${THREAD_A_REPLY_TO}) -> ${SET_MODEL}"
set_payload="$(send_user_message "/model ${SET_MODEL}" "${THREAD_A_REPLY_TO}")"
set_msg_id="$(jq -er '.message.message_id // 0' <<<"${set_payload}" 2>/dev/null || echo 0)"

echo "Step 2: query model in thread B (${THREAD_B_REPLY_TO})"
query_payload="$(send_user_message "/model" "${THREAD_B_REPLY_TO}")"
query_msg_id="$(jq -er '.message.message_id // 0' <<<"${query_payload}" 2>/dev/null || echo 0)"

echo "Step 3: poll bot updates and assert thread B reports ${EXPECT_MODEL}"
attempt=1
tg_conflict=0
while [[ "${attempt}" -le "${TG_POLL_ATTEMPTS}" ]]; do
  echo "Polling attempt ${attempt}/${TG_POLL_ATTEMPTS}..."
  payload="$(tg_poll_json 2>&1 || true)"
  if [[ "${payload}" == *"409 Conflict"* ]]; then
    echo "tg poll conflict detected (gateway owns getUpdates). Switching to userbot assertion fallback..."
    tg_conflict=1
    break
  fi
  if ! jq -e . >/dev/null 2>&1 <<<"${payload}"; then
    echo "tg poll returned non-JSON output. Switching to userbot assertion fallback..."
    tg_conflict=1
    break
  fi
  if [[ -n "${payload}" ]] && find_thread_text "${payload}" "Current:[[:space:]]+${EXPECT_MODEL}"; then
    echo "PASS: thread B reports expected model (${EXPECT_MODEL})"
    exit 0
  fi
  sleep "${TG_POLL_SLEEP}"
  attempt=$((attempt + 1))
done

if [[ "${tg_conflict}" -eq 1 ]]; then
  fallback_timeout=$((TG_POLL_ATTEMPTS * (TG_POLL_TIMEOUT + TG_POLL_SLEEP)))
  if wait_userbot_message "${query_msg_id}" "${THREAD_B_REPLY_TO}" "Current: ${EXPECT_MODEL}" "${fallback_timeout}" "${TG_BOT_ID:-0}" >/dev/null; then
    echo "PASS: thread B reports expected model (${EXPECT_MODEL}) [userbot fallback]"
    exit 0
  fi
fi

echo "FAIL: did not observe \"Current: ${EXPECT_MODEL}\" in thread B updates (set_msg_id=${set_msg_id}, query_msg_id=${query_msg_id})." >&2
exit 1
