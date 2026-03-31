#!/usr/bin/env bash

# Telegram model-picker callback smoke.
# This keeps humans on the repo-local operator path instead of dropping into a
# one-off Telethon snippet every time callback-heavy /model flows need proof.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

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
print(json.dumps(json.loads(payload), ensure_ascii=True))
PY
}

json_field() {
  local json_payload="$1"
  local python_expr="$2"
  JSON_PAYLOAD="${json_payload}" PYTHON_EXPR="${python_expr}" python3 - <<'PY'
import json
import os

data = json.loads(os.environ["JSON_PAYLOAD"])
print(eval(os.environ["PYTHON_EXPR"], {"__builtins__": {}}, {"data": data}))
PY
}

resolve_model_callback_data() {
  local provider="$1"
  local model="$2"

  (
    cd "${REPO_ROOT}"
    PROVIDER="${provider}" MODEL="${model}" node --import tsx --input-type=module <<'NODE'
import { buildModelSelectionCallbackData } from "./extensions/telegram/src/model-buttons.ts";

const provider = (process.env.PROVIDER || "").trim();
const model = (process.env.MODEL || "").trim();
const callbackData = buildModelSelectionCallbackData({ provider, model });
if (!callbackData) {
  throw new Error(`Could not encode callback_data for ${provider}/${model}`);
}
process.stdout.write(`${callbackData}\n`);
NODE
  )
}

run_telegram_user_json() {
  (
    cd "${REPO_ROOT}"
    pnpm openclaw:local telegram-user "$@" --json
  )
}

usage() {
  cat <<'USAGE'
Usage:
  run-model-callback-smoke.sh \
    --chat <bot-username> \
    --provider <provider> \
    --model <model> \
    [--timeout <seconds>] \
    [--restart-runtime] \
    [--skip-runtime-ensure]

Example:
  scripts/telegram-e2e/run-model-callback-smoke.sh \
    --chat @jarvis_tester_1_bot \
    --provider anthropic \
    --model claude-sonnet-4-6 \
    --restart-runtime
USAGE
}

chat=""
provider=""
model=""
timeout="120"
restart_runtime="0"
skip_runtime_ensure="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --chat)
      chat="${2:-}"
      shift 2
      ;;
    --provider)
      provider="${2:-}"
      shift 2
      ;;
    --model)
      model="${2:-}"
      shift 2
      ;;
    --timeout)
      timeout="${2:-120}"
      shift 2
      ;;
    --restart-runtime)
      restart_runtime="1"
      shift
      ;;
    --skip-runtime-ensure)
      skip_runtime_ensure="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "${chat}" || -z "${provider}" || -z "${model}" ]]; then
  echo "Missing required args: --chat, --provider, --model" >&2
  usage >&2
  exit 1
fi

expected_model="${provider}/${model}"
provider_callback="mdl_list_${provider}_1"
model_callback="$(resolve_model_callback_data "${provider}" "${model}")"

if [[ "${skip_runtime_ensure}" != "1" ]]; then
  echo "Ensuring isolated Telegram runtime ownership..." >&2
  (
    cd "${REPO_ROOT}"
    scripts/telegram-live-runtime.sh ensure
  ) >&2
fi

precheck_output="$(run_telegram_user_json precheck --chat "${chat}")"
precheck_json="$(extract_json_payload "${precheck_output}")"
bot_id="$(json_field "${precheck_json}" 'data["chat"]["chat_id"]')"
bot_username="$(json_field "${precheck_json}" 'data["chat"].get("username") or ""')"

run_status_check() {
  local label="$1"
  local send_output send_json status_after_id wait_output wait_json

  send_output="$(run_telegram_user_json send --chat "${chat}" --message "/model status")"
  send_json="$(extract_json_payload "${send_output}")"
  status_after_id="$(json_field "${send_json}" 'data["message"]["message_id"]')"

  wait_output="$(
    run_telegram_user_json \
      wait \
      --chat "${chat}" \
      --after-id "${status_after_id}" \
      --sender-id "${bot_id}" \
      --contains "${expected_model}" \
      --timeout-ms "$(( timeout * 1000 ))"
  )"
  wait_json="$(extract_json_payload "${wait_output}")"

  STATUS_LABEL="${label}" STATUS_JSON="${wait_json}" python3 - <<'PY'
import json
import os

label = os.environ["STATUS_LABEL"]
data = json.loads(os.environ["STATUS_JSON"])
summary = {
    "label": label,
    "reply_message_id": data["matched"]["message_id"],
    "reply_text": data["matched"]["text"],
    "matched_by": data["matched_by"],
}
print(json.dumps(summary, ensure_ascii=True))
PY
}

run_callback_flow() {
  local label="$1"
  local send_output send_json picker_message_id
  local browse_output browse_json provider_output provider_json model_output model_json
  local status_json

  send_output="$(run_telegram_user_json send --chat "${chat}" --message "/model")"
  send_json="$(extract_json_payload "${send_output}")"
  picker_message_id="$(json_field "${send_json}" 'data["message"]["message_id"]')"

  browse_output="$(
    run_telegram_user_json \
      click \
      --chat "${chat}" \
      --message-id "${picker_message_id}" \
      --button-text "Browse providers"
  )"
  browse_json="$(extract_json_payload "${browse_output}")"

  provider_output="$(
    run_telegram_user_json \
      click \
      --chat "${chat}" \
      --message-id "${picker_message_id}" \
      --callback-data "${provider_callback}"
  )"
  provider_json="$(extract_json_payload "${provider_output}")"

  model_output="$(
    run_telegram_user_json \
      click \
      --chat "${chat}" \
      --message-id "${picker_message_id}" \
      --callback-data "${model_callback}"
  )"
  model_json="$(extract_json_payload "${model_output}")"

  status_json="$(run_status_check "${label}")"

  CALLBACK_LABEL="${label}" \
  PICKER_MESSAGE_ID="${picker_message_id}" \
  BROWSE_JSON="${browse_json}" \
  PROVIDER_JSON="${provider_json}" \
  MODEL_JSON="${model_json}" \
  STATUS_JSON="${status_json}" \
  python3 - <<'PY'
import json
import os

summary = {
    "label": os.environ["CALLBACK_LABEL"],
    "picker_message_id": int(os.environ["PICKER_MESSAGE_ID"]),
    "browse_text": json.loads(os.environ["BROWSE_JSON"])["message"]["text"],
    "provider_text": json.loads(os.environ["PROVIDER_JSON"])["message"]["text"],
    "model_text": json.loads(os.environ["MODEL_JSON"])["message"]["text"],
    "status": json.loads(os.environ["STATUS_JSON"]),
}
print(json.dumps(summary, ensure_ascii=True))
PY
}

first_pass_json="$(run_callback_flow "before_restart")"

if [[ "${restart_runtime}" == "1" ]]; then
  echo "Restarting isolated Telegram runtime for restart-proof verification..." >&2
  (
    cd "${REPO_ROOT}"
    scripts/telegram-live-runtime.sh release
    scripts/telegram-live-runtime.sh ensure
  ) >&2
  second_status_json="$(run_status_check "after_restart")"
else
  second_status_json=""
fi

FIRST_PASS_JSON="${first_pass_json}" \
SECOND_STATUS_JSON="${second_status_json}" \
CHAT="${chat}" \
BOT_ID="${bot_id}" \
BOT_USERNAME="${bot_username}" \
EXPECTED_MODEL="${expected_model}" \
RESTART_RUNTIME="${restart_runtime}" \
python3 - <<'PY'
import json
import os

summary = {
    "chat": os.environ["CHAT"],
    "bot_id": int(os.environ["BOT_ID"]),
    "bot_username": os.environ["BOT_USERNAME"] or None,
    "expected_model": os.environ["EXPECTED_MODEL"],
    "restart_runtime": os.environ["RESTART_RUNTIME"] == "1",
    "before_restart": json.loads(os.environ["FIRST_PASS_JSON"]),
}

if os.environ["SECOND_STATUS_JSON"]:
    summary["after_restart"] = json.loads(os.environ["SECOND_STATUS_JSON"])

print(json.dumps(summary, ensure_ascii=True, indent=2))
PY
