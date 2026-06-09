#!/usr/bin/env bash
set -euo pipefail

MAIN_REPO="${OPENCLAW_MAIN_REPO:-/Users/user/Programming_Projects/openclaw}"
EXPECTED_MAIN_REPO="/Users/user/Programming_Projects/openclaw"
if [[ "${OPENCLAW_SHARED_MAIN_TEST_MODE:-0}" == "1" ]]; then
  EXPECTED_MAIN_REPO="${OPENCLAW_EXPECTED_MAIN_REPO:-${EXPECTED_MAIN_REPO}}"
fi
STATE_DIR="${OPENCLAW_STATE_DIR:-${HOME}/Library/Application Support/OpenClaw/.openclaw}"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-${STATE_DIR}/openclaw.json}"
LOG_DIR="${OPENCLAW_LOG_DIR:-${STATE_DIR}/logs}"
GATEWAY_ERR_LOG="${OPENCLAW_GATEWAY_ERR_LOG:-${LOG_DIR}/gateway.err.log}"
GATEWAY_LOG="${OPENCLAW_GATEWAY_LOG:-${LOG_DIR}/gateway.log}"
WATCHDOG_SECONDS="${OPENCLAW_TELEGRAM_WATCHDOG_SECONDS:-140}"
WAIT_TIMEOUT_MS="${OPENCLAW_TELEGRAM_WAIT_TIMEOUT_MS:-120000}"
DRY_RUN=0
NONCE=""
DEPLOY_SINCE=""

log() {
  printf '[prove-main-telegram-runtime] %s\n' "$*"
}

usage() {
  cat <<EOF
usage: bash scripts/prove-main-telegram-runtime.sh [--dry-run] [--nonce TEXT] [--since ISO_TIME]

Send a nonce to the active main Telegram bot, verify the exact nonce appears in
the bot reply, then scan the watchdog window for polling-stall regressions.
EOF
}

parse_args() {
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --dry-run)
        DRY_RUN=1
        ;;
      --nonce)
        NONCE="${2:-}"
        shift
        ;;
      --since)
        DEPLOY_SINCE="${2:-}"
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        printf '[prove-main-telegram-runtime] unknown argument: %s\n' "$1" >&2
        usage >&2
        exit 2
        ;;
    esac
    shift
  done
}

require_sacred_main_checkout() {
  local root=""
  root="$(git -C "${MAIN_REPO}" rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ "${root}" != "${EXPECTED_MAIN_REPO}" ]]; then
    printf '[prove-main-telegram-runtime] refusing non-canonical checkout: %s\n' "${root:-<none>}" >&2
    exit 1
  fi
  if [[ "$(pwd -P)" != "${EXPECTED_MAIN_REPO}" ]]; then
    printf '[prove-main-telegram-runtime] run from the sacred main clone: cd %s\n' "${EXPECTED_MAIN_REPO}" >&2
    exit 1
  fi
  if [[ "$(git -C "${MAIN_REPO}" branch --show-current)" != "main" ]]; then
    printf '[prove-main-telegram-runtime] refusing non-main branch\n' >&2
    exit 1
  fi
}

tail_recent_logs() {
  {
    [[ -f "${GATEWAY_LOG}" ]] && tail -n 400 "${GATEWAY_LOG}"
    [[ -f "${GATEWAY_ERR_LOG}" ]] && tail -n 400 "${GATEWAY_ERR_LOG}"
  } 2>/dev/null || true
}

extract_default_provider_from_logs() {
  tail_recent_logs | perl -ne '
    $value = "\@$1" if /\[default\][^\@]*\@([A-Za-z0-9_]+)/;
    $value = "\@$1" if /telegram[^\[]*\[default\].*\@([A-Za-z0-9_]+)/;
    END { print "$value\n" if defined $value && length $value }
  '
}

default_bot_token_from_config() {
  node --input-type=module - "${CONFIG_PATH}" <<'JS'
import fs from "node:fs";
const path = process.argv[2];
const config = JSON.parse(fs.readFileSync(path, "utf8"));
const telegram = config.channels?.telegram ?? {};
const account = telegram.accounts?.default ?? {};
const token = account.botToken ?? telegram.botToken ?? "";
if (typeof token === "string" && token.trim()) {
  console.log(token.trim());
}
JS
}

resolve_bot_from_token() {
  local token="$1"
  node --input-type=module - "${token}" <<'JS'
const token = process.argv[2];
const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
const payload = await response.json();
if (!payload.ok) {
  throw new Error(`getMe failed: ${JSON.stringify(payload)}`);
}
const user = payload.result;
console.log(JSON.stringify({
  id: user.id,
  username: user.username ? `@${user.username}` : "",
}));
JS
}

resolve_active_bot() {
  local username=""
  username="$(extract_default_provider_from_logs | tail -n 1)"
  if [[ -n "${username}" ]]; then
    printf '{"username":"%s","id":""}\n' "${username}"
    return 0
  fi

  local token=""
  token="$(default_bot_token_from_config)"
  if [[ -z "${token}" ]]; then
    printf '[prove-main-telegram-runtime] no active [default] provider in logs and no default bot token in config\n' >&2
    return 1
  fi
  resolve_bot_from_token "${token}"
}

json_field() {
  node --input-type=module - "$1" "$2" <<'JS'
const payload = JSON.parse(process.argv[2]);
const field = process.argv[3];
const value = payload?.[field] ?? "";
process.stdout.write(String(value));
JS
}

run_json() {
  # pnpm prints its script banner on stdout unless --silent is set. JSON proof
  # commands need clean stdout because the next step parses the payload.
  pnpm --silent openclaw:local "$@" --json
}

message_id_from_json() {
  node --input-type=module - "$1" <<'JS'
const payload = JSON.parse(process.argv[2]);
const message = payload.message ?? payload.matched ?? payload;
console.log(message.message_id ?? "");
JS
}

sender_id_from_json() {
  node --input-type=module - "$1" <<'JS'
const payload = JSON.parse(process.argv[2]);
const message = payload.message ?? payload.matched ?? payload;
console.log(message.sender_id ?? "");
JS
}

assert_wait_contains_nonce() {
  local wait_json="$1"
  node --input-type=module - "$wait_json" "$NONCE" <<'JS'
const payload = JSON.parse(process.argv[2]);
const nonce = process.argv[3];
const text = payload.matched?.text ?? "";
if (!text.includes(nonce)) {
  throw new Error(`matched reply did not contain nonce ${nonce}: ${text}`);
}
JS
}

gateway_pid() {
  launchctl print "gui/$(id -u)/ai.openclaw.gateway" 2>/dev/null | awk '/pid =/ { print $3; exit }'
}

scan_logs_after_since() {
  local since="$1"
  node --input-type=module - "${since}" "${GATEWAY_ERR_LOG}" "${GATEWAY_LOG}" <<'JS'
import fs from "node:fs";
const [since, ...paths] = process.argv.slice(2);
const banned = [
  "Polling stall detected",
  "Polling runner stop timed out",
  "Telegram polling unhealthy",
];
const offenders = [];
for (const path of paths) {
  if (!fs.existsSync(path)) continue;
  for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line || line.slice(0, since.length) < since) continue;
    if (banned.some((needle) => line.includes(needle))) {
      offenders.push(`${path}: ${line}`);
    }
  }
}
if (offenders.length) {
  console.error(offenders.join("\n"));
  process.exit(1);
}
JS
}

main() {
  parse_args "$@"

  if [[ "${DRY_RUN}" == "1" && "$(pwd -P)" != "${EXPECTED_MAIN_REPO}" ]]; then
    log "dry-run preview only; live proof must run from ${EXPECTED_MAIN_REPO}"
  else
    require_sacred_main_checkout
  fi

  NONCE="${NONCE:-JARVIS_HEALTH_OK_$(date +%H%M%S)}"
  DEPLOY_SINCE="${DEPLOY_SINCE:-$(date '+%Y-%m-%dT%H:%M:%S')}"

  local bot_json=""
  bot_json="$(resolve_active_bot)"
  local bot_username=""
  local bot_id=""
  bot_username="$(json_field "${bot_json}" username)"
  bot_id="$(json_field "${bot_json}" id)"

  if [[ "${DRY_RUN}" == "1" ]]; then
    log "dry-run: active_bot=${bot_username:-unknown} id=${bot_id:-unknown}"
    log "dry-run: pnpm --silent openclaw:local telegram-user precheck --chat ${bot_username} --json"
    log "dry-run: pnpm --silent openclaw:local telegram-user send --chat ${bot_username} --message ${NONCE} --json"
    log "dry-run: pnpm --silent openclaw:local telegram-user wait --chat ${bot_username} --contains ${NONCE} --timeout-ms ${WAIT_TIMEOUT_MS} --json"
    log "dry-run: sleep ${WATCHDOG_SECONDS}; scan logs after ${DEPLOY_SINCE}"
    return 0
  fi

  local start_ms=""
  start_ms="$(node -e 'console.log(Date.now())')"
  run_json telegram-user precheck --chat "${bot_username}" >/dev/null
  local send_json=""
  send_json="$(run_json telegram-user send --chat "${bot_username}" --message "${NONCE}")"
  local sent_id=""
  local sender_id=""
  sent_id="$(message_id_from_json "${send_json}")"
  sender_id="$(sender_id_from_json "${send_json}")"

  local wait_json=""
  wait_json="$(run_json telegram-user wait --chat "${bot_username}" --after-id "${sent_id}" --contains "${NONCE}" --timeout-ms "${WAIT_TIMEOUT_MS}")"
  assert_wait_contains_nonce "${wait_json}"
  local reply_id=""
  reply_id="$(message_id_from_json "${wait_json}")"

  local pid_before_watchdog=""
  pid_before_watchdog="$(gateway_pid || true)"
  sleep "${WATCHDOG_SECONDS}"
  scan_logs_after_since "${DEPLOY_SINCE}"

  local elapsed_ms=""
  elapsed_ms="$(node -e "console.log(Date.now() - ${start_ms})")"
  local pid=""
  pid="$(gateway_pid || true)"
  if [[ -n "${pid_before_watchdog}" && -n "${pid}" && "${pid}" != "${pid_before_watchdog}" ]]; then
    printf '[prove-main-telegram-runtime] gateway pid changed during watchdog window: before=%s after=%s\n' "${pid_before_watchdog}" "${pid}" >&2
    exit 1
  fi
  if [[ -n "${pid}" ]]; then
    kill -0 "${pid}" 2>/dev/null || {
      printf '[prove-main-telegram-runtime] gateway pid is no longer alive: %s\n' "${pid}" >&2
      exit 1
    }
  fi

  log "proof bot=${bot_username} id=${bot_id:-unknown}"
  log "proof sent_id=${sent_id} sender_id=${sender_id:-unknown}"
  log "proof reply_id=${reply_id}"
  log "proof nonce=${NONCE}"
  log "proof elapsed_ms=${elapsed_ms}"
  log "proof pid_before_watchdog=${pid_before_watchdog:-unknown}"
  log "proof pid_still_alive=${pid:-unknown}"
}

if [[ "${OPENCLAW_SCRIPT_LIB_TEST:-0}" != "1" ]]; then
  main "$@"
fi
