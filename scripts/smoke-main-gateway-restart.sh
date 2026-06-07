#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
MAIN_REPO="${OPENCLAW_MAIN_REPO:-/Users/user/Programming_Projects/openclaw}"
CHAT_TARGET="${OPENCLAW_MAIN_GATEWAY_SMOKE_CHAT:-}"
THREAD_ANCHOR="${OPENCLAW_MAIN_GATEWAY_SMOKE_THREAD_ANCHOR:-}"
MODE="confirm"
DRY_RUN=0
WAIT_TIMEOUT_SECONDS="${OPENCLAW_MAIN_GATEWAY_SMOKE_TIMEOUT_SECONDS:-180}"
POLL_SECONDS="${OPENCLAW_MAIN_GATEWAY_SMOKE_POLL_SECONDS:-2}"
RESTART_REQUEST_MESSAGE="${OPENCLAW_MAIN_GATEWAY_RESTART_REQUEST_MESSAGE:-Please restart the gateway. Ask me for confirmation before doing it.}"
RESTART_CONFIRM_MESSAGE="${OPENCLAW_MAIN_GATEWAY_RESTART_CONFIRM_MESSAGE:-Yes, restart the gateway now.}"
DIRECT_RESTART_MESSAGE="${OPENCLAW_MAIN_GATEWAY_DIRECT_RESTART_MESSAGE:-/restart}"
PROMPT_MATCH="${OPENCLAW_MAIN_GATEWAY_RESTART_PROMPT_MATCH:-restart}"
CONFIRM_MATCH="${OPENCLAW_MAIN_GATEWAY_RESTART_CONFIRM_MATCH:-restart}"
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"

log() {
  printf '[smoke-main-gateway-restart] %s\n' "$*"
}

usage() {
  cat <<'EOF'
Usage: scripts/smoke-main-gateway-restart.sh [--chat <target>] [--thread-anchor <id>] [--direct-restart] [--dry-run]

Live shared-main Telegram restart smoke. The default mode sends a restart
request, waits for a restart-related prompt, sends confirmation, then proves the
gateway returned healthy from the sacred main runtime. Use --direct-restart to
send /restart directly.

Required for live mode:
  OPENCLAW_MAIN_GATEWAY_SMOKE_CHAT or --chat
  a working `pnpm openclaw:local telegram-user ...` session
EOF
}

parse_args() {
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --chat)
        CHAT_TARGET="${2:-}"
        shift 2
        ;;
      --thread-anchor|--topic-id)
        THREAD_ANCHOR="${2:-}"
        shift 2
        ;;
      --direct-restart)
        MODE="direct"
        shift
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        log "unknown argument: $1" >&2
        usage >&2
        exit 1
        ;;
    esac
  done
}

json_escape() {
  node -e 'process.stdout.write(JSON.stringify(process.argv[1] ?? ""))' "$1"
}

run_in_main() {
  (cd "${MAIN_REPO}" && "$@")
}

git_value() {
  local repo="$1"
  shift
  git -C "${repo}" "$@" 2>/dev/null || true
}

status_json() {
  run_in_main pnpm openclaw:local gateway status --deep --require-rpc --json 2>/dev/null
}

status_ok() {
  local json="$1"
  printf '%s\n' "${json}" | jq -e '
    (.ok == true or .service.runtime.status == "running")
    and ((.rpc.ok == true) or ([.targets[]? | select(.connect.rpcOk == true)] | length > 0))
  ' >/dev/null
}

status_runtime_is_sacred_main() {
  local json="$1"
  local expected="${MAIN_REPO}"
  printf '%s\n' "${json}" | jq -e --arg expected "${expected}" '
    def fp: .runtimeFingerprint // .service.runtimeFingerprint // {};
    ((fp.branch // "") == "main")
    and ((fp.worktree // "") == $expected)
  ' >/dev/null
}

status_pid() {
  local json="$1"
  printf '%s\n' "${json}" | jq -r '.service.runtime.pid // .service.pid // .pid // ""'
}

print_preflight() {
  local status="$1"
  local branch=""
  local commit=""
  local worktree=""
  local pid=""
  local listener=""

  branch="$(git_value "${MAIN_REPO}" rev-parse --abbrev-ref HEAD)"
  commit="$(git_value "${MAIN_REPO}" rev-parse --short=12 HEAD)"
  worktree="$(cd "${MAIN_REPO}" && pwd -P)"
  pid="$(status_pid "${status}")"
  listener="$(lsof -nP -iTCP:18789 -sTCP:LISTEN 2>/dev/null | tail -n +2 | awk '{print $2 ":" $1}' | paste -sd ',' - || true)"

  log "preflight branch=${branch:-unknown} worktree=${worktree} commit=${commit:-unknown}"
  log "preflight pid=${pid:-unknown} listener=${listener:-missing}"
  log "preflight rpc=$(status_ok "${status}" && printf ok || printf fail)"
}

require_live_inputs() {
  command -v jq >/dev/null 2>&1 || {
    log "jq is required" >&2
    exit 1
  }
  command -v pnpm >/dev/null 2>&1 || {
    log "pnpm is required" >&2
    exit 1
  }
  if [[ -z "${CHAT_TARGET}" ]]; then
    log "--chat or OPENCLAW_MAIN_GATEWAY_SMOKE_CHAT is required for live mode" >&2
    exit 1
  fi
}

send_user_message() {
  local message="$1"
  local args=(openclaw:local telegram-user send --chat "${CHAT_TARGET}" --message "${message}" --json)
  if [[ -n "${THREAD_ANCHOR}" ]]; then
    # Telegram user send only has reply anchoring today. In Jarvis Lab topic
    # smokes this keeps the smoke turn attached to the topic starter when the
    # operator provides one.
    args+=(--reply-to "${THREAD_ANCHOR}")
  fi
  run_in_main pnpm "${args[@]}"
}

wait_for_reply() {
  local after_id="$1"
  local contains="$2"
  local args=(
    openclaw:local telegram-user wait
    --chat "${CHAT_TARGET}"
    --after-id "${after_id}"
    --contains "${contains}"
    --timeout-ms "$((WAIT_TIMEOUT_SECONDS * 1000))"
    --json
  )
  if [[ -n "${THREAD_ANCHOR}" ]]; then
    args+=(--thread-anchor "${THREAD_ANCHOR}")
  fi
  run_in_main pnpm "${args[@]}"
}

message_id_from_json() {
  node -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(0, "utf8"));
const id = data.messageId ?? data.message_id ?? data.id ?? data.result?.message_id ?? data.message?.id ?? 0;
process.stdout.write(String(id || 0));
'
}

chat_id_from_json() {
  node -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(0, "utf8"));
const id = data.chatId ?? data.chat_id ?? data.chat?.id ?? data.result?.chat?.id ?? "";
process.stdout.write(String(id || ""));
'
}

delete_bot_message_best_effort() {
  local chat_id="$1"
  local message_id="$2"
  if [[ -z "${TELEGRAM_BOT_TOKEN}" || -z "${chat_id}" || -z "${message_id}" || "${message_id}" == "0" ]]; then
    return 0
  fi
  curl -fsS \
    -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteMessage" \
    -d "chat_id=${chat_id}" \
    -d "message_id=${message_id}" >/dev/null 2>&1 || true
}

wait_for_restart_health() {
  local before_pid="$1"
  local deadline=$((SECONDS + WAIT_TIMEOUT_SECONDS))
  local observed_unhealthy=0
  local healthy_json=""
  local current_pid=""

  while (( SECONDS < deadline )); do
    if healthy_json="$(status_json 2>/dev/null)" && status_ok "${healthy_json}"; then
      current_pid="$(status_pid "${healthy_json}")"
      if status_runtime_is_sacred_main "${healthy_json}" &&
        { [[ "${observed_unhealthy}" == "1" ]] || [[ -z "${before_pid}" ]] || [[ -z "${current_pid}" ]] || [[ "${before_pid}" != "${current_pid}" ]]; }; then
        printf '%s\n' "${healthy_json}"
        return 0
      fi
    else
      observed_unhealthy=1
    fi
    sleep "${POLL_SECONDS}"
  done

  log "gateway did not prove restart transition plus healthy sacred-main RPC within ${WAIT_TIMEOUT_SECONDS}s" >&2
  return 1
}

main() {
  parse_args "$@"

  local pre_status=""
  pre_status="$(status_json)"
  print_preflight "${pre_status}"

  if ! status_ok "${pre_status}" || ! status_runtime_is_sacred_main "${pre_status}"; then
    log "preflight failed: shared gateway must be healthy and owned by sacred main before restart smoke" >&2
    exit 1
  fi

  if (( DRY_RUN == 1 )); then
    printf '{"ok":true,"dry_run":true,"mode":%s,"chat":%s,"main_repo":%s}\n' \
      "$(json_escape "${MODE}")" "$(json_escape "${CHAT_TARGET}")" "$(json_escape "${MAIN_REPO}")"
    return 0
  fi

  require_live_inputs

  local before_pid=""
  before_pid="$(status_pid "${pre_status}")"
  local request_json=""
  local confirm_json=""
  local prompt_json=""
  local healthy_json=""
  local request_id=0
  local confirm_id=0
  local prompt_id=0
  local chat_id=""

  if [[ "${MODE}" == "direct" ]]; then
    confirm_json="$(send_user_message "${DIRECT_RESTART_MESSAGE}")"
    confirm_id="$(printf '%s\n' "${confirm_json}" | message_id_from_json)"
    chat_id="$(printf '%s\n' "${confirm_json}" | chat_id_from_json)"
  else
    request_json="$(send_user_message "${RESTART_REQUEST_MESSAGE}")"
    request_id="$(printf '%s\n' "${request_json}" | message_id_from_json)"
    chat_id="$(printf '%s\n' "${request_json}" | chat_id_from_json)"
    prompt_json="$(wait_for_reply "${request_id}" "${PROMPT_MATCH}")"
    prompt_id="$(printf '%s\n' "${prompt_json}" | message_id_from_json)"
    confirm_json="$(send_user_message "${RESTART_CONFIRM_MESSAGE}")"
    confirm_id="$(printf '%s\n' "${confirm_json}" | message_id_from_json)"
    wait_for_reply "${confirm_id}" "${CONFIRM_MATCH}" >/dev/null || true
  fi

  healthy_json="$(wait_for_restart_health "${before_pid}")"

  delete_bot_message_best_effort "${chat_id}" "${request_id}"
  delete_bot_message_best_effort "${chat_id}" "${prompt_id}"
  delete_bot_message_best_effort "${chat_id}" "${confirm_id}"

  jq -nc \
    --arg mode "${MODE}" \
    --arg mainRepo "${MAIN_REPO}" \
    --arg beforePid "${before_pid}" \
    --arg afterPid "$(status_pid "${healthy_json}")" \
    --arg commit "$(git_value "${MAIN_REPO}" rev-parse --short=12 HEAD)" \
    --arg requestId "${request_id}" \
    --arg promptId "${prompt_id}" \
    --arg confirmId "${confirm_id}" \
    '{
      ok: true,
      proof_level: "L3",
      mode: $mode,
      main_repo: $mainRepo,
      commit: $commit,
      before_pid: $beforePid,
      after_pid: $afterPid,
      smoke_messages: {
        request_id: ($requestId | tonumber? // 0),
        prompt_id: ($promptId | tonumber? // 0),
        confirm_id: ($confirmId | tonumber? // 0)
      }
    }'
}

main "$@"
