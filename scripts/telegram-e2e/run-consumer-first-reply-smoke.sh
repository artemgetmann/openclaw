#!/usr/bin/env bash

# Consumer Telegram first-reply smoke test.
# This uses the existing MTProto userbot session so we can verify a real
# user-to-bot roundtrip without fighting Bot API long-poll conflicts.
# The success condition is intentionally simple:
# - send one fresh DM to the target bot as the user
# - wait for any non-empty reply from that bot after the sent message id
# This proves the "first real reply" lane works end-to-end on the current
# consumer runtime, even if the exact wording evolves.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/telegram-e2e/userbot-common.sh
source "${SCRIPT_DIR}/userbot-common.sh"

usage() {
  cat <<'USAGE'
Usage:
  run-consumer-first-reply-smoke.sh --chat <bot-username> [--text <message>] [--timeout <seconds>]

Example:
  scripts/telegram-e2e/run-consumer-first-reply-smoke.sh --chat @jarvis_consumer_bot
USAGE
}

chat=""
text=""
timeout="120"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --chat)
      chat="${2:-}"
      shift 2
      ;;
    --text)
      text="${2:-}"
      shift 2
      ;;
    --timeout)
      timeout="${2:-45}"
      shift 2
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

if [[ -z "${chat}" ]]; then
  echo "Missing required arg: --chat" >&2
  usage >&2
  exit 1
fi

# Keep the default prompt human and harmless. The point is not to test a
# specific semantic reply, only that the bot wakes up and answers.
if [[ -z "${text}" ]]; then
  text="codex-consumer-smoke $(date +%s) who are you and what should I call you?"
fi

load_userbot_env_if_present
require_userbot_credentials
python_bin="$(ensure_userbot_python)"
session_path="$(resolve_userbot_session_path)"

# Precheck first so session/chat failures are explicit instead of looking like
# "the bot ignored me" when the userbot lane was never healthy.
run_userbot_precheck "${python_bin}" "${session_path}" "${chat}" >/dev/null

send_json="$(
  run_userbot_send "${python_bin}" "${session_path}" "${chat}" "0" "${text}"
)"
after_id="$(
  SEND_JSON="${send_json}" python3 - <<'PY'
import json, os
print(json.loads(os.environ["SEND_JSON"])["message_id"])
PY
)"

# Ask Telegram who the bot is so the wait step only accepts a real reply from
# that bot, not our own outbound message or another message in the chat.
bot_meta="$(
  TG_BOT_TOKEN="${TG_BOT_TOKEN:-}" python3 - <<'PY'
import json, os, sys, urllib.request
token = os.environ.get("TG_BOT_TOKEN", "").strip()
if not token:
  print("Missing TG_BOT_TOKEN in scripts/telegram-e2e/.env.local", file=sys.stderr)
  raise SystemExit(1)
with urllib.request.urlopen(f"https://api.telegram.org/bot{token}/getMe", timeout=15) as resp:
  data = json.load(resp)
if not data.get("ok"):
  print(json.dumps(data), file=sys.stderr)
  raise SystemExit(1)
result = data["result"]
print(json.dumps({"id": result["id"], "username": result.get("username")}, ensure_ascii=True))
PY
)"
bot_id="$(
  BOT_META="${bot_meta}" python3 - <<'PY'
import json, os
print(json.loads(os.environ["BOT_META"])["id"])
PY
)"

echo "Waiting for a reply from ${chat} after message ${after_id} (timeout ${timeout}s)..." >&2

reply_json="$(
  "${python_bin}" "${SCRIPT_DIR}/userbot_wait.py" \
    --api-id "${TELEGRAM_API_ID:-}" \
    --api-hash "${TELEGRAM_API_HASH:-}" \
    --session "${session_path}" \
    --chat "${chat}" \
    --after-id "${after_id}" \
    --contains "" \
    --sender-id "${bot_id}" \
    --timeout "${timeout}"
)"

SEND_JSON="${send_json}" BOT_META="${bot_meta}" REPLY_JSON="${reply_json}" python3 - <<'PY'
import json, os
send = json.loads(os.environ["SEND_JSON"])
bot = json.loads(os.environ["BOT_META"])
reply = json.loads(os.environ["REPLY_JSON"])
summary = {
  "chat_id": send["chat_id"],
  "sent_message_id": send["message_id"],
  "bot_id": bot["id"],
  "bot_username": bot.get("username"),
  "reply_message_id": reply["message_id"],
  "reply_text": reply["text"],
}
print(json.dumps(summary, ensure_ascii=True, indent=2))
PY
