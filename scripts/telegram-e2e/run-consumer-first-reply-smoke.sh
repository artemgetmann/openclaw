#!/usr/bin/env bash

# Consumer Telegram first-reply smoke test.
# This intentionally uses the repo-local `telegram-user` CLI so the smoke lane
# exercises the same operator surface humans and scripts should rely on.
# The success condition stays intentionally simple:
# - send one fresh DM to the target bot as the user account
# - wait for any non-empty reply from that bot after the sent message id
# That proves the current runtime is answering real Telegram traffic end-to-end.

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
data = json.loads(payload)
print(json.dumps(data, ensure_ascii=True))
PY
}

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

# Precheck first so session/chat failures are explicit instead of looking like
# "the bot ignored me" when the Telegram user lane was never healthy.
precheck_output="$(
  cd "${REPO_ROOT}"
  pnpm openclaw:local telegram-user precheck --chat "${chat}" --json
)"
precheck_json="$(extract_json_payload "${precheck_output}")"

send_output="$(
  cd "${REPO_ROOT}" &&
    pnpm openclaw:local telegram-user send \
      --chat "${chat}" \
      --message "${text}" \
      --json
)"
send_json="$(extract_json_payload "${send_output}")"
after_id="$(
  SEND_JSON="${send_json}" python3 - <<'PY'
import json, os
print(json.loads(os.environ["SEND_JSON"])["message"]["message_id"])
PY
)"

bot_id="$(
  PRECHECK_JSON="${precheck_json}" python3 - <<'PY'
import json, os
print(json.loads(os.environ["PRECHECK_JSON"])["chat"]["chat_id"])
PY
)"

echo "Waiting for a reply from ${chat} after message ${after_id} (timeout ${timeout}s)..." >&2

reply_output="$(
  cd "${REPO_ROOT}" &&
    pnpm openclaw:local telegram-user wait \
      --chat "${chat}" \
      --after-id "${after_id}" \
      --contains "" \
      --sender-id "${bot_id}" \
      --timeout-ms "$(( timeout * 1000 ))" \
      --json
)"
reply_json="$(extract_json_payload "${reply_output}")"

SEND_JSON="${send_json}" PRECHECK_JSON="${precheck_json}" REPLY_JSON="${reply_json}" python3 - <<'PY'
import json, os
send = json.loads(os.environ["SEND_JSON"])
precheck = json.loads(os.environ["PRECHECK_JSON"])
reply = json.loads(os.environ["REPLY_JSON"])
summary = {
  "chat_id": send["message"]["chat_id"],
  "sent_message_id": send["message"]["message_id"],
  "bot_id": precheck["chat"]["chat_id"],
  "bot_username": precheck["chat"].get("username"),
  "reply_message_id": reply["matched"]["message_id"],
  "reply_text": reply["matched"]["text"],
  "reply_sender_id": reply["matched"]["sender_id"],
  "reply_to_msg_id": reply["matched"]["reply_to_msg_id"],
  "reply_to_top_id": reply["matched"]["reply_to_top_id"],
  "direct_messages_topic.topic_id": (
    reply["matched"].get("direct_messages_topic", {}) or {}
  ).get("topic_id"),
  "matched_by": reply["matched_by"],
}
print(json.dumps(summary, ensure_ascii=True, indent=2))
PY
