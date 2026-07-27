#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=scripts/lib/heavy-local-slot.sh
source "${REPO_ROOT}/scripts/lib/heavy-local-slot.sh"
ORIGINAL_ARGS=("$@")
HELPER_MODULE="${SCRIPT_DIR}/lib/telegram-live-runtime-helpers.mjs"
SCENARIO_RESERVATION_MODULE="${SCRIPT_DIR}/lib/telegram-tester-scenario-reservations.mjs"
BASELINE_HELPER_MODULE="${SCRIPT_DIR}/lib/worktree-tester-baseline.mjs"
ASSIGN_BOT_SCRIPT="${SCRIPT_DIR}/assign-bot.sh"
BOOTSTRAP_TELEGRAM_SCRIPT="${SCRIPT_DIR}/bootstrap-worktree-telegram.sh"
MAIN_RECOVER_SCRIPT="${SCRIPT_DIR}/gateway-recover-main.sh"

WORKTREE="$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)"
if [[ -d "$WORKTREE" ]]; then
  WORKTREE="$(cd "$WORKTREE" && pwd -P)"
fi
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
BASE_CONFIG_PATH=""

PROFILE_ID=""
RUNTIME_PORT=""
RUNTIME_STATE_DIR=""
RUNTIME_CONFIG_PATH=""
RUNTIME_LOG_PATH=""
RUNTIME_PID=""
RUNTIME_WORKTREE=""
RUNTIME_OWNERSHIP="fail"
RUNTIME_HEALTH="fail"
RUNTIME_START_ACTION="not-started"
RUNTIME_START_TIMEOUT_SECS="unknown"
RUNTIME_PLUGIN_MODE="main-parity"
PARITY_REPORT_PATH=""
PARITY_CONFIG_DIFF_ALLOWED_ONLY="unknown"
PARITY_BROWSER_SIDECAR_ENABLED="unknown"
PARITY_BROWSER_PROFILES_MATCH="unknown"
PARITY_TOOLS_MATCH="unknown"
PARITY_PLUGINS_MATCH="unknown"
PARITY_MODEL_CONFIG_MATCH="unknown"
PARITY_UPLOAD_DIR="/tmp/openclaw/uploads"
PARITY_UPLOAD_DIR_READY="unknown"
PARITY_UNEXPECTED_DIFFS="unknown"
RUNTIME_STOP_RESULT="skip"
STOPPED_RUNTIME_PID=""
MONITOR_LISTENER_ENABLED="no"
MONITOR_LISTENER_PID=""
MONITOR_LISTENER_BIRTH_IDENTITY=""
MONITOR_LISTENER_INSTANCE_ID=""
MONITOR_LISTENER_OWNERSHIP="not-requested"
MONITOR_LISTENER_HEALTH="not-requested"
MONITOR_LISTENER_START_ACTION="not-requested"
MONITOR_LISTENER_STOP_RESULT="skip"
MONITOR_LISTENER_CRON_STORE_PATH=""
MONITOR_LISTENER_MONITOR_STORE_PATH=""
MONITOR_LISTENER_CURSOR_STORE_PATH=""
MONITOR_LISTENER_HEALTH_STORE_PATH=""
MONITOR_LISTENER_OWNER_PATH=""
MONITOR_LISTENER_LOG_PATH=""
TOKEN_PRESENT="no"
TOKEN_POOL_GUARD="fail"
TOKEN_FINGERPRINT="none"
TOKEN_CLAIM_STATUS="unknown"
TOKEN_CLAIM_REASON="unknown"
TOKEN_POOL_SIZE=0
TOKEN_POOL_CLAIMED_COUNT=0
TOKEN_POOL_RESERVED_COUNT=0
TOKEN_POOL_CLAIMABLE_COUNT=0
ASSIGNED_BOT_TOKEN=""
ASSIGNED_BOT_ID="unknown"
ASSIGNED_BOT_USERNAME="unknown"
ASSIGNED_BOT_NAME="unknown"
CURRENT_LANE_BOT="unknown"
TESTER_SCENARIO_ID="unknown"
TESTER_RESERVATION_GENERATION="unknown"
TESTER_RESERVATION_TOKEN_HASH="unknown"
TESTER_SAFE_REUSE_GENERATION=""
TESTER_SAFE_REUSE_TOKEN_HASH=""
TESTER_SAFE_REUSE_ACCOUNT_ID=""
RUNTIME_TOKEN_SOURCE="unknown"
TOKEN_ORIGIN_HINT="unknown"
TOKEN_CLAIM_COUNT=0
TOKEN_CLAIM_PATHS=()
TOKEN_BOOTSTRAP_STATUS="not-needed"
RUNTIME_CONFIG_PRESENT="no"
RUNTIME_CONFIG_TOKEN_PRESENT="no"
RUNTIME_CONFIG_TOKEN_FINGERPRINT="none"
MODEL_AUTH_PREFLIGHT_STATUS="not-run"
MODEL_AUTH_PREFLIGHT_PROVIDER="unknown"
MODEL_AUTH_PREFLIGHT_MODEL="unknown"
MODEL_AUTH_PREFLIGHT_PROFILE="unknown"
TELEGRAM_SENDER_PREFLIGHT_STATUS="not-run"
TELEGRAM_SENDER_USER_ID="unknown"
TELEGRAM_SENDER_ACCESS_STATUS="not-run"
FAIL=0
FAIL_REASONS=()
PROFILE_COMMAND_LOCK_DIR=""
PROFILE_COMMAND_LOCK_OWNED="no"

repo_toolchain_path() {
  local toolchain_path="${REPO_ROOT}/node_modules/.bin"
  local candidate=""
  # The live harness can run from inside agent shells that prepend their own
  # runtime tools to PATH. Keep repo-local commands on the repo pnpm line so a
  # model/auth preflight does not accidentally bootstrap through a bundled
  # agent runtime.
  for candidate in "/opt/homebrew/bin" "/usr/local/bin"; do
    if [[ -x "${candidate}/pnpm" ]]; then
      toolchain_path="${toolchain_path}:${candidate}"
    fi
  done
  printf '%s:%s' "$toolchain_path" "${PATH:-}"
}

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

add_failure() {
  local reason="$1"
  FAIL=1
  FAIL_REASONS+=("$reason")
}

resolve_base_config_path() {
  local explicit_path="${OPENCLAW_TELEGRAM_BASE_CONFIG_PATH:-${OPENCLAW_CONFIG_PATH:-}}"

  if [[ -n "$explicit_path" ]]; then
    BASE_CONFIG_PATH="$explicit_path"
    return
  fi

  if [[ ! -f "$BASELINE_HELPER_MODULE" ]]; then
    BASE_CONFIG_PATH="${HOME}/.openclaw/openclaw.json"
    return
  fi

  # Default to the sanitized per-worktree tester baseline so fresh Telegram
  # lanes inherit the same cleaned config that bootstrap prepared for them.
  local baseline_path=""
  baseline_path="$(
    WORKTREE_PATH="$WORKTREE" node --input-type=module - "$BASELINE_HELPER_MODULE" <<'NODE'
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const [helperPath] = process.argv.slice(2);
const worktreePath = process.env.WORKTREE_PATH;
const { deriveWorktreeTesterBaseline } = await import(pathToFileURL(helperPath).href);

const baseline = deriveWorktreeTesterBaseline({ worktreePath });
if (fs.existsSync(baseline.configPath)) {
  process.stdout.write(baseline.configPath);
}
NODE
  )" || true

  if [[ -n "$baseline_path" ]]; then
    BASE_CONFIG_PATH="$baseline_path"
  else
    BASE_CONFIG_PATH="${HOME}/.openclaw/openclaw.json"
  fi
}

parse_assign_bot_output() {
  local output="$1"
  local line=""
  local reason=""

  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      Reason:\ *) reason="${line#Reason: }" ;;
      Selection\ reason:\ *) reason="${line#Selection reason: }" ;;
      Claimed:\ *)
        if [[ "$line" =~ Claimed:\ ([0-9]+)\ /\ Pool:\ ([0-9]+)\ /\ Reserved\ by\ main\ runtime:\ ([0-9]+) ]]; then
          TOKEN_POOL_CLAIMED_COUNT="${BASH_REMATCH[1]}"
          TOKEN_POOL_SIZE="${BASH_REMATCH[2]}"
          TOKEN_POOL_RESERVED_COUNT="${BASH_REMATCH[3]}"
        fi
        ;;
      Claimable\ now:\ *)
        if [[ "$line" =~ Claimable\ now:\ ([0-9]+) ]]; then
          TOKEN_POOL_CLAIMABLE_COUNT="${BASH_REMATCH[1]}"
        fi
        ;;
    esac
  done <<< "$output"

  if [[ -n "$reason" ]]; then
    TOKEN_CLAIM_REASON="$reason"
  fi
}

hydrate_current_lane_bot() {
  resolve_token_claims "$ASSIGNED_BOT_TOKEN"
  resolve_bot_identity
  if [[ "${ASSIGNED_BOT_USERNAME}" != "unknown" ]]; then
    CURRENT_LANE_BOT="@${ASSIGNED_BOT_USERNAME}"
  elif [[ "${ASSIGNED_BOT_ID}" != "unknown" ]]; then
    CURRENT_LANE_BOT="id=${ASSIGNED_BOT_ID}"
  fi
}

resolve_token_claims() {
  local current_token="$1"
  local worktree_path=""
  local env_local_path=""
  local claimed=""

  TOKEN_CLAIM_COUNT=0
  TOKEN_CLAIM_PATHS=()

  while IFS= read -r worktree_path || [[ -n "${worktree_path}" ]]; do
    [[ -z "${worktree_path}" ]] && continue
    env_local_path="${worktree_path}/.env.local"
    [[ -f "${env_local_path}" ]] || continue
    claimed="$(read_last_env_value "${env_local_path}" "TELEGRAM_BOT_TOKEN")"
    if [[ -n "${claimed}" && "${claimed}" == "${current_token}" ]]; then
      TOKEN_CLAIM_COUNT=$((TOKEN_CLAIM_COUNT + 1))
      TOKEN_CLAIM_PATHS+=("${worktree_path}")
    fi
  done < <(git worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')
}

resolve_bot_identity() {
  [[ -n "${ASSIGNED_BOT_TOKEN}" ]] || return 0

  if [[ "${ASSIGNED_BOT_TOKEN}" == *:* ]]; then
    ASSIGNED_BOT_ID="${ASSIGNED_BOT_TOKEN%%:*}"
  fi

  if ! command -v python3 >/dev/null 2>&1; then
    return 0
  fi

  local identity
  identity="$(
    TELEGRAM_BOT_TOKEN="${ASSIGNED_BOT_TOKEN}" python3 - <<'PY' 2>/dev/null || true
import json
import os
import urllib.request

token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
if not token:
    raise SystemExit(0)

req = urllib.request.Request(
    f"https://api.telegram.org/bot{token}/getMe",
    headers={"User-Agent": "openclaw-telegram-live-runtime"},
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

  if [[ -n "${identity}" ]]; then
    ASSIGNED_BOT_ID="$(python3 -c 'import json,sys; data=json.loads(sys.stdin.read()); print(data.get("id") or "unknown")' <<<"${identity}" 2>/dev/null || printf '%s' "${ASSIGNED_BOT_ID}")"
    ASSIGNED_BOT_USERNAME="$(python3 -c 'import json,sys; data=json.loads(sys.stdin.read()); print(data.get("username") or "unknown")' <<<"${identity}" 2>/dev/null || printf 'unknown')"
    ASSIGNED_BOT_NAME="$(python3 -c 'import json,sys; data=json.loads(sys.stdin.read()); print(data.get("name") or "unknown")' <<<"${identity}" 2>/dev/null || printf 'unknown')"
  fi
}

sanitize_runtime_log_line() {
  local line="$1"
  printf '%s\n' "$line" | sed -E \
    -e 's/([A-Za-z_][A-Za-z0-9_]*(TOKEN|SECRET|PASSWORD|API_KEY)[A-Za-z0-9_]*=)[^[:space:]]+/\1***REDACTED***/Ig' \
    -e 's/[0-9]{8,}:[A-Za-z0-9_-]{20,}/****:***REDACTED***/g' \
    -e 's/sk-[A-Za-z0-9_-]{16,}/sk-***REDACTED***/g' \
    -e 's/(fc|nvapi|rnd|BSA)-[A-Za-z0-9_-]{8,}/\1-***REDACTED***/g'
}

emit_runtime_log_summary() {
  local lines="${OPENCLAW_TELEGRAM_LIVE_FAIL_LOG_LINES:-40}"
  if [[ ! "$lines" =~ ^[0-9]+$ ]]; then
    lines=40
  fi
  if [[ -z "$RUNTIME_LOG_PATH" || ! -f "$RUNTIME_LOG_PATH" ]]; then
    return
  fi

  echo "runtime_log_tail_begin" >&2
  while IFS= read -r line || [[ -n "$line" ]]; do
    sanitize_runtime_log_line "$line" >&2
  done < <(tail -n "$lines" "$RUNTIME_LOG_PATH")
  echo "runtime_log_tail_end" >&2
}

is_truthy_env_flag() {
  local value
  value="$(trim "${1:-}")"
  value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
  [[ "$value" == "1" || "$value" == "true" || "$value" == "yes" || "$value" == "on" ]]
}

reset_acp_validation_runtime_state_if_needed() {
  local acp_validation="${OPENCLAW_TELEGRAM_LIVE_ACP_VALIDATION:-}"
  if ! is_truthy_env_flag "$acp_validation"; then
    return
  fi
  if [[ -z "$RUNTIME_STATE_DIR" || ! -d "$RUNTIME_STATE_DIR" ]]; then
    return
  fi
  if [[ -n "$RUNTIME_PID" ]]; then
    return
  fi

  # ACP validation needs a genuinely clean runtime state snapshot. Reusing a
  # stale Telegram live lane state dir is what kept secrets precheck pinned to
  # Anthropic even after the runtime config switched to Codex-only auth.
  rm -rf "$RUNTIME_STATE_DIR"
}

resolve_profile() {
  if [[ ! -f "$HELPER_MODULE" ]]; then
    add_failure "helper_missing:${HELPER_MODULE}"
    return
  fi

  local state_root="${OPENCLAW_TELEGRAM_LIVE_STATE_ROOT:-}"
  local acp_validation="${OPENCLAW_TELEGRAM_LIVE_ACP_VALIDATION:-}"
  local profile_lines
  profile_lines="$(
    WORKTREE_PATH="$WORKTREE" STATE_ROOT="$state_root" OPENCLAW_TELEGRAM_LIVE_ACP_VALIDATION="$acp_validation" node --input-type=module - "$HELPER_MODULE" <<'NODE'
import { pathToFileURL } from "node:url";

const [helperPath] = process.argv.slice(2);
const helpers = await import(pathToFileURL(helperPath).href);
const profile = helpers.deriveTelegramLiveRuntimeProfile({
  acpValidation: process.env.OPENCLAW_TELEGRAM_LIVE_ACP_VALIDATION,
  worktreePath: process.env.WORKTREE_PATH,
  stateRoot: process.env.STATE_ROOT || undefined,
});

process.stdout.write(
  `${profile.profileId}\n${String(profile.runtimePort)}\n${profile.runtimeStateDir}\n${profile.commandLockDir}\n`,
);
NODE
  )"

  PROFILE_ID="$(printf '%s\n' "$profile_lines" | sed -n '1p')"
  RUNTIME_PORT="$(printf '%s\n' "$profile_lines" | sed -n '2p')"
  RUNTIME_STATE_DIR="$(printf '%s\n' "$profile_lines" | sed -n '3p')"
  PROFILE_COMMAND_LOCK_DIR="$(printf '%s\n' "$profile_lines" | sed -n '4p')"
  RUNTIME_CONFIG_PATH="${RUNTIME_STATE_DIR}/openclaw.telegram-live.json"
  RUNTIME_LOG_PATH="/tmp/openclaw-telegram-live-${PROFILE_ID}.log"
  # Every listener artifact lives under the already-derived tester state tree.
  # These paths are never inferred from the host default, so a healthy shared
  # listener cannot satisfy this lane's ownership or health checks.
  MONITOR_LISTENER_CRON_STORE_PATH="${RUNTIME_STATE_DIR}/cron/jobs.json"
  MONITOR_LISTENER_MONITOR_STORE_PATH="${RUNTIME_STATE_DIR}/cron/monitors.json"
  MONITOR_LISTENER_CURSOR_STORE_PATH="${RUNTIME_STATE_DIR}/cron/telegram-user-listener-cursors.json"
  MONITOR_LISTENER_HEALTH_STORE_PATH="${RUNTIME_STATE_DIR}/cron/listener-health.json"
  MONITOR_LISTENER_OWNER_PATH="${RUNTIME_STATE_DIR}/telegram-user-monitor-listener.owner.json"
  MONITOR_LISTENER_LOG_PATH="${RUNTIME_STATE_DIR}/telegram-user-monitor-listener.log"

  if [[ -z "$PROFILE_ID" || -z "$RUNTIME_PORT" || -z "$RUNTIME_STATE_DIR" ||
    -z "$PROFILE_COMMAND_LOCK_DIR" ]]; then
    add_failure "profile_resolution_failed"
  fi
}

remove_runtime_state_dir() {
  if [[ -z "$RUNTIME_STATE_DIR" ]]; then
    add_failure "runtime_state_dir_missing"
    return
  fi

  # Only delete the exact derived profile dir for this worktree. That keeps the
  # cleanup narrow even when callers override the shared state root.
  local resolved_state_dir=""
  resolved_state_dir="$(
    WORKTREE_PATH="$WORKTREE" STATE_ROOT="${OPENCLAW_TELEGRAM_LIVE_STATE_ROOT:-}" node --input-type=module - "$HELPER_MODULE" <<'NODE'
import { pathToFileURL } from "node:url";

const [helperPath] = process.argv.slice(2);
const helpers = await import(pathToFileURL(helperPath).href);
const profile = helpers.deriveTelegramLiveRuntimeProfile({
  worktreePath: process.env.WORKTREE_PATH,
  stateRoot: process.env.STATE_ROOT || undefined,
});

process.stdout.write(profile.runtimeStateDir);
NODE
  )" || true

  if [[ -z "$resolved_state_dir" || "$resolved_state_dir" != "$RUNTIME_STATE_DIR" ]]; then
    add_failure "runtime_state_dir_mismatch"
    return
  fi

  if [[ -d "$RUNTIME_STATE_DIR" ]]; then
    rm -rf "$RUNTIME_STATE_DIR"
  fi
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

  if [[ "$count" == "0" ]]; then
    return
  fi
  if [[ "$count" != "1" ]]; then
    add_failure "multiple_listeners_on_runtime_port:${RUNTIME_PORT}"
    return
  fi

  RUNTIME_PID="$(printf '%s\n' "$pids" | sed -n '1p' | tr -d '[:space:]')"
  if [[ -z "$RUNTIME_PID" ]]; then
    return
  fi

  local runtime_cmd
  runtime_cmd="$(ps -o command= -p "$RUNTIME_PID" 2>/dev/null || true)"
  RUNTIME_WORKTREE="$(lsof -a -p "$RUNTIME_PID" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | sed -n '1p')"

  local has_runtime_profile="no"
  # The gateway changes cwd to its configured workspace after startup. Its
  # non-secret, worktree-derived profile remains in argv for the process life,
  # so it is durable ownership proof without reading tokens or process env.
  if [[ -n "$PROFILE_ID" ]] &&
    { [[ " $runtime_cmd " == *" --profile ${PROFILE_ID} "* ]] ||
      [[ " $runtime_cmd " == *" --profile=${PROFILE_ID} "* ]]; }; then
    has_runtime_profile="yes"
  fi

  if [[ "$runtime_cmd" == *" gateway run"* || "$runtime_cmd" == *"openclaw-gateway"* ]] &&
    { [[ -n "$RUNTIME_WORKTREE" && "$RUNTIME_WORKTREE" == "$WORKTREE" ]] ||
      [[ "$has_runtime_profile" == "yes" ]]; }; then
    # Profile evidence proves the expected owner even when cwd is now workspace.
    RUNTIME_WORKTREE="$WORKTREE"
    RUNTIME_OWNERSHIP="ok"
  fi
}

stop_owned_runtime() {
  RUNTIME_STOP_RESULT="skip"
  STOPPED_RUNTIME_PID=""

  if [[ -n "$RUNTIME_PID" && "$RUNTIME_OWNERSHIP" == "ok" ]]; then
    STOPPED_RUNTIME_PID="$RUNTIME_PID"
    if kill "$RUNTIME_PID" 2>/dev/null; then
      local waited=0
      while [[ "$waited" -lt 15 ]]; do
        if ! kill -0 "$RUNTIME_PID" 2>/dev/null; then
          break
        fi
        sleep 1
        waited=$((waited + 1))
      done
      if kill -0 "$RUNTIME_PID" 2>/dev/null; then
        kill -9 "$RUNTIME_PID" 2>/dev/null || true
      fi
      RUNTIME_STOP_RESULT="ok"
    else
      RUNTIME_STOP_RESULT="fail"
      add_failure "runtime_stop_failed"
    fi
  fi
}

process_has_monitor_listener_instance() {
  local pid="$1"
  local instance_id="$2"
  [[ "$pid" =~ ^[0-9]+$ && "$instance_id" =~ ^[a-f0-9]{48}$ ]] || return 1

  # Node rewrites the process title, which can make `ps eww` omit the original
  # environment entirely on macOS. The listener therefore publishes its
  # child-only random instance marker in the isolated health record. Birth time
  # and cwd still prove the live PID; this marker binds that PID to this spawn.
  HEALTH_PATH="$MONITOR_LISTENER_HEALTH_STORE_PATH" \
    EXPECTED_PID="$pid" \
    EXPECTED_INSTANCE="$instance_id" \
    node --input-type=module - <<'NODE'
import fs from "node:fs";
try {
  const store = JSON.parse(fs.readFileSync(process.env.HEALTH_PATH, "utf8"));
  const owner = store?.records?.["telegram-user"]?.owner;
  process.exit(
    owner?.pid === Number.parseInt(process.env.EXPECTED_PID ?? "", 10) &&
      owner?.instanceId === process.env.EXPECTED_INSTANCE
      ? 0
      : 1,
  );
} catch {
  process.exit(1);
}
NODE
}

resolve_monitor_listener_owner() {
  MONITOR_LISTENER_PID=""
  MONITOR_LISTENER_BIRTH_IDENTITY=""
  MONITOR_LISTENER_INSTANCE_ID=""
  MONITOR_LISTENER_OWNERSHIP="missing"

  [[ -n "$MONITOR_LISTENER_OWNER_PATH" && -f "$MONITOR_LISTENER_OWNER_PATH" ]] || return 0

  local owner_lines=""
  owner_lines="$(
    OWNER_PATH="$MONITOR_LISTENER_OWNER_PATH" node --input-type=module - <<'NODE'
import fs from "node:fs";
try {
  const owner = JSON.parse(fs.readFileSync(process.env.OWNER_PATH, "utf8"));
  const argv = Array.isArray(owner.argv) && owner.argv.every((value) => typeof value === "string")
    ? owner.argv
    : [];
  const expects = (flag, value) => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] === value;
  };
  const completeIdentity =
    owner.version === 2 &&
    Number.isSafeInteger(owner.pid) &&
    typeof owner.birthIdentity === "string" &&
    owner.birthIdentity.trim() &&
    typeof owner.instanceId === "string" &&
    /^[a-f0-9]{48}$/u.test(owner.instanceId) &&
    typeof owner.executable === "string" &&
    owner.executable.startsWith("/") &&
    typeof owner.cwd === "string" &&
    typeof owner.envFile === "string" &&
    typeof owner.session === "string" &&
    argv[0] === "openclaw.mjs" &&
    expects("--profile", owner.profileId) &&
    argv.includes("telegram-user") &&
    argv.includes("monitor-poll") &&
    argv.includes("--watch") &&
    expects("--cron-store", owner.cronStorePath) &&
    expects("--monitor-store", owner.monitorStorePath) &&
    expects("--cursor-store", owner.cursorStorePath) &&
    expects("--hook-url", owner.hookUrl) &&
    expects("--env-file", owner.envFile) &&
    expects("--session", owner.session);
  if (!completeIdentity) {
    process.exit(1);
  }
  process.stdout.write([
    owner.pid,
    owner.profileId,
    owner.worktree,
    owner.cronStorePath,
    owner.monitorStorePath,
    owner.cursorStorePath,
    owner.hookUrl,
    owner.birthIdentity.trim(),
    owner.instanceId,
    owner.executable,
    `${owner.executable} ${argv.join(" ")}`,
    owner.cwd,
    owner.envFile,
    owner.session,
  ].map((value) => String(value ?? "")).join("\n"));
} catch {
  process.exit(1);
}
NODE
  )" || {
    MONITOR_LISTENER_OWNERSHIP="invalid-record"
    return 0
  }

  local owner_pid owner_profile owner_worktree owner_cron owner_monitor owner_cursor owner_hook
  local owner_birth owner_executable owner_command owner_cwd owner_env_file owner_session
  local owner_instance
  owner_pid="$(printf '%s\n' "$owner_lines" | sed -n '1p')"
  owner_profile="$(printf '%s\n' "$owner_lines" | sed -n '2p')"
  owner_worktree="$(printf '%s\n' "$owner_lines" | sed -n '3p')"
  owner_cron="$(printf '%s\n' "$owner_lines" | sed -n '4p')"
  owner_monitor="$(printf '%s\n' "$owner_lines" | sed -n '5p')"
  owner_cursor="$(printf '%s\n' "$owner_lines" | sed -n '6p')"
  owner_hook="$(printf '%s\n' "$owner_lines" | sed -n '7p')"
  owner_birth="$(printf '%s\n' "$owner_lines" | sed -n '8p')"
  owner_instance="$(printf '%s\n' "$owner_lines" | sed -n '9p')"
  owner_executable="$(printf '%s\n' "$owner_lines" | sed -n '10p')"
  owner_command="$(printf '%s\n' "$owner_lines" | sed -n '11p')"
  owner_cwd="$(printf '%s\n' "$owner_lines" | sed -n '12p')"
  owner_env_file="$(printf '%s\n' "$owner_lines" | sed -n '13p')"
  owner_session="$(printf '%s\n' "$owner_lines" | sed -n '14p')"
  MONITOR_LISTENER_PID="$owner_pid"
  MONITOR_LISTENER_BIRTH_IDENTITY="$owner_birth"
  MONITOR_LISTENER_INSTANCE_ID="$owner_instance"

  if [[ ! "$owner_pid" =~ ^[0-9]+$ ]] ||
    [[ "$owner_profile" != "$PROFILE_ID" ]] ||
    [[ "$owner_worktree" != "$WORKTREE" ]] ||
    [[ "$owner_cron" != "$MONITOR_LISTENER_CRON_STORE_PATH" ]] ||
    [[ "$owner_monitor" != "$MONITOR_LISTENER_MONITOR_STORE_PATH" ]] ||
    [[ "$owner_cursor" != "$MONITOR_LISTENER_CURSOR_STORE_PATH" ]] ||
    [[ "$owner_hook" != "http://127.0.0.1:${RUNTIME_PORT}/hooks/telegram-user-monitor-event" ]] ||
    [[ "$owner_cwd" != "$WORKTREE" ]] ||
    [[ -z "$owner_executable" || -z "$owner_env_file" || -z "$owner_session" ]]; then
    MONITOR_LISTENER_OWNERSHIP="foreign-record"
    return 0
  fi

  if ! kill -0 "$owner_pid" 2>/dev/null; then
    MONITOR_LISTENER_PID=""
    MONITOR_LISTENER_OWNERSHIP="stale-record"
    return 0
  fi

  local current_birth current_cwd
  current_birth="$(
    LC_ALL=C TZ=UTC ps -p "$owner_pid" -o lstart= 2>/dev/null |
      awk '{$1=$1; print}'
  )"
  current_cwd="$(lsof -a -p "$owner_pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | sed -n '1p')"
  # OpenClaw intentionally rewrites the process title after launch, so the live
  # command line cannot be compared with the immutable launch argv in the owner
  # record. Birth time closes PID reuse, the random 192-bit child-only instance
  # marker proves this exact spawn, and cwd binds it to this worktree.
  if [[ -z "$current_birth" || "$current_birth" != "$owner_birth" ]] ||
    [[ "$current_cwd" != "$owner_cwd" ]] ||
    ! process_has_monitor_listener_instance "$owner_pid" "$owner_instance"; then
    MONITOR_LISTENER_OWNERSHIP="foreign-process"
    return 0
  fi

  MONITOR_LISTENER_OWNERSHIP="ok"
}

probe_monitor_listener_health() {
  MONITOR_LISTENER_HEALTH="fail"
  [[ "$MONITOR_LISTENER_OWNERSHIP" == "ok" && -n "$MONITOR_LISTENER_PID" ]] || return 0

  if HEALTH_PATH="$MONITOR_LISTENER_HEALTH_STORE_PATH" \
    EXPECTED_PID="$MONITOR_LISTENER_PID" \
    EXPECTED_PROFILE="$PROFILE_ID" \
    EXPECTED_INSTANCE="$MONITOR_LISTENER_INSTANCE_ID" \
    node --input-type=module - <<'NODE'
import fs from "node:fs";
try {
  const store = JSON.parse(fs.readFileSync(process.env.HEALTH_PATH, "utf8"));
  const record = store?.records?.["telegram-user"];
  const expectedPid = Number.parseInt(process.env.EXPECTED_PID ?? "", 10);
  const interval = Number.isFinite(record?.pollIntervalMs) ? Math.max(1, record.pollIntervalMs) : 1000;
  const staleAfterMs = Math.max(30_000, interval * 3);
  const exactOwner =
    record?.owner?.pid === expectedPid &&
    record?.owner?.profile === process.env.EXPECTED_PROFILE &&
    record?.owner?.instanceId === process.env.EXPECTED_INSTANCE;
  const freshSuccess =
    Number.isFinite(record?.lastSuccessfulCheckAtMs) &&
    Date.now() - record.lastSuccessfulCheckAtMs < staleAfterMs;
  process.exit(exactOwner && freshSuccess && record?.state === "healthy" ? 0 : 1);
} catch {
  process.exit(1);
}
NODE
  then
    MONITOR_LISTENER_HEALTH="ok"
  fi
}

stop_owned_monitor_listener() {
  MONITOR_LISTENER_STOP_RESULT="not-running"
  resolve_monitor_listener_owner

  if [[ "$MONITOR_LISTENER_OWNERSHIP" == "stale-record" ]]; then
    rm -f "$MONITOR_LISTENER_OWNER_PATH" "$MONITOR_LISTENER_HEALTH_STORE_PATH"
    MONITOR_LISTENER_STOP_RESULT="stale-cleaned"
    return 0
  fi
  if [[ "$MONITOR_LISTENER_OWNERSHIP" == "missing" ]]; then
    return 0
  fi
  if [[ "$MONITOR_LISTENER_OWNERSHIP" != "ok" ]]; then
    MONITOR_LISTENER_STOP_RESULT="not-owned"
    add_failure "monitor_listener_not_owned:${MONITOR_LISTENER_OWNERSHIP}"
    return 0
  fi

  local owned_pid="$MONITOR_LISTENER_PID"
  local owned_birth="$MONITOR_LISTENER_BIRTH_IDENTITY"
  local owned_instance="$MONITOR_LISTENER_INSTANCE_ID"
  # Re-resolve immediately before TERM. Validation done even milliseconds ago
  # is not authority to signal a PID that may since have been recycled.
  resolve_monitor_listener_owner
  if [[ "$MONITOR_LISTENER_OWNERSHIP" != "ok" ||
    "$MONITOR_LISTENER_PID" != "$owned_pid" ||
    "$MONITOR_LISTENER_BIRTH_IDENTITY" != "$owned_birth" ||
    "$MONITOR_LISTENER_INSTANCE_ID" != "$owned_instance" ]]; then
    MONITOR_LISTENER_STOP_RESULT="identity-changed"
    add_failure "monitor_listener_identity_changed_before_term"
    return 0
  fi
  if kill "$owned_pid" 2>/dev/null; then
    local waited=0
    while [[ "$waited" -lt 15 ]]; do
      resolve_monitor_listener_owner
      if [[ "$MONITOR_LISTENER_OWNERSHIP" == "stale-record" ]]; then
        break
      fi
      if [[ "$MONITOR_LISTENER_OWNERSHIP" != "ok" ||
        "$MONITOR_LISTENER_PID" != "$owned_pid" ||
        "$MONITOR_LISTENER_BIRTH_IDENTITY" != "$owned_birth" ||
        "$MONITOR_LISTENER_INSTANCE_ID" != "$owned_instance" ]]; then
        MONITOR_LISTENER_STOP_RESULT="identity-changed"
        add_failure "monitor_listener_identity_changed_while_stopping"
        return 0
      fi
      sleep 1
      waited=$((waited + 1))
    done
    resolve_monitor_listener_owner
    if [[ "$MONITOR_LISTENER_OWNERSHIP" == "ok" &&
      "$MONITOR_LISTENER_PID" == "$owned_pid" &&
      "$MONITOR_LISTENER_BIRTH_IDENTITY" == "$owned_birth" &&
      "$MONITOR_LISTENER_INSTANCE_ID" == "$owned_instance" ]]; then
      # KILL is separately authorized against the same birth identity; never
      # inherit authority from the earlier TERM validation.
      kill -9 "$owned_pid" 2>/dev/null || true
    elif [[ "$MONITOR_LISTENER_OWNERSHIP" != "stale-record" ]]; then
      MONITOR_LISTENER_STOP_RESULT="identity-changed"
      add_failure "monitor_listener_identity_changed_before_kill"
      return 0
    fi
    MONITOR_LISTENER_STOP_RESULT="stopped"
    MONITOR_LISTENER_PID=""
    MONITOR_LISTENER_OWNERSHIP="missing"
    rm -f "$MONITOR_LISTENER_OWNER_PATH" "$MONITOR_LISTENER_HEALTH_STORE_PATH"
  else
    MONITOR_LISTENER_STOP_RESULT="failed"
    add_failure "monitor_listener_stop_failed"
  fi
}

probe_runtime_health() {
  RUNTIME_HEALTH="fail"
  if [[ -z "$RUNTIME_PORT" || -z "$RUNTIME_STATE_DIR" || -z "$RUNTIME_CONFIG_PATH" ]]; then
    return
  fi
  # Readiness probe is bounded and profile-scoped (derived runtime port).
  if RUNTIME_PORT="$RUNTIME_PORT" node --input-type=module - >/tmp/openclaw-telegram-live-health.$$ 2>&1 <<'NODE'
const port = Number.parseInt(process.env.RUNTIME_PORT ?? "", 10);
if (!Number.isFinite(port) || port <= 0) {
  process.exit(1);
}

let response;
try {
  response = await fetch(`http://127.0.0.1:${port}/readyz`, {
    signal: AbortSignal.timeout(2500),
  });
} catch {
  process.exit(1);
}

if (!response.ok) {
  process.exit(1);
}

let payload = null;
try {
  payload = await response.json();
} catch {
  process.exit(1);
}

if (payload && typeof payload === "object" && payload.ready === true) {
  process.exit(0);
}

process.exit(1);
NODE
  then
    RUNTIME_HEALTH="ok"
  fi
}

probe_runtime_stability() {
  local hold_secs="${OPENCLAW_TELEGRAM_LIVE_STABILITY_HOLD_SECS:-2}"
  if [[ ! "$hold_secs" =~ ^[0-9]+$ ]]; then
    hold_secs=2
  fi
  if [[ "$hold_secs" -gt 0 ]]; then
    sleep "$hold_secs"
  fi
  resolve_runtime_owner
  if [[ "$RUNTIME_OWNERSHIP" != "ok" || -z "$RUNTIME_PID" ]]; then
    RUNTIME_HEALTH="fail"
    return
  fi
  if ! kill -0 "$RUNTIME_PID" 2>/dev/null; then
    RUNTIME_HEALTH="fail"
    return
  fi
  probe_runtime_health
}

ensure_tester_bot_claim() {
  local env_local="${REPO_ROOT}/.env.local"
  local env_bots="${REPO_ROOT}/.env.bots"
  local token=""
  local assign_output=""
  local bootstrap_output=""

  if [[ ! -x "$ASSIGN_BOT_SCRIPT" ]]; then
    TOKEN_CLAIM_STATUS="fail"
    TOKEN_CLAIM_REASON="assign_script_missing"
    add_failure "assign_bot_script_missing:${ASSIGN_BOT_SCRIPT}"
    return
  fi

  if [[ ! -r "$env_bots" ]]; then
    if [[ -x "$BOOTSTRAP_TELEGRAM_SCRIPT" ]]; then
      TOKEN_BOOTSTRAP_STATUS="attempted"
      if ! bootstrap_output="$(cd "$REPO_ROOT" && bash "$BOOTSTRAP_TELEGRAM_SCRIPT" --strict 2>&1)"; then
        TOKEN_BOOTSTRAP_STATUS="failed"
        TOKEN_CLAIM_STATUS="fail"
        TOKEN_CLAIM_REASON="bootstrap_failed"
        add_failure "token_bootstrap_failed"
        echo "telegram_bootstrap_hint=bash scripts/bootstrap-worktree-telegram.sh --strict" >&2
        printf '%s\n' "$bootstrap_output" >&2
        return
      fi
      if [[ -r "$env_bots" ]]; then
        TOKEN_BOOTSTRAP_STATUS="ok"
      else
        TOKEN_BOOTSTRAP_STATUS="missing_env_bots_after_bootstrap"
        TOKEN_CLAIM_STATUS="fail"
        TOKEN_CLAIM_REASON="env_bots_missing"
        add_failure "env_bots_missing"
        echo "telegram_bootstrap_hint=bash scripts/bootstrap-worktree-telegram.sh --strict" >&2
        echo "telegram_bootstrap_error=.env.bots is still missing after bootstrap; check OPENCLAW_MAIN_REPO and the main checkout .env.bots file." >&2
        return
      fi
    else
      TOKEN_BOOTSTRAP_STATUS="script_missing"
      TOKEN_CLAIM_STATUS="fail"
      TOKEN_CLAIM_REASON="env_bots_missing"
      add_failure "env_bots_missing"
      echo "telegram_bootstrap_hint=bash scripts/bootstrap-worktree-telegram.sh --strict" >&2
      return
    fi
  fi

  # Always resolve the claim via assign-bot so a stale .env.local token can be
  # rotated away when another runtime actively holds the lease.
  if ! assign_output="$(
    cd "$REPO_ROOT" &&
      OPENCLAW_TELEGRAM_TESTER_RESERVATION_ROOT="${OPENCLAW_TELEGRAM_TESTER_RESERVATION_ROOT:-${HOME}/.openclaw/telegram-tester-scenario-reservations}" \
        bash "$ASSIGN_BOT_SCRIPT" 2>&1
  )"; then
    TOKEN_CLAIM_STATUS="fail"
    TOKEN_CLAIM_REASON="assign_failed"
    parse_assign_bot_output "$assign_output"
    if [[ "$TOKEN_CLAIM_REASON" == "pool_exhausted" ]]; then
      TOKEN_POOL_GUARD="blocked"
      RUNTIME_START_ACTION="blocked_no_token"
    fi
    add_failure "token_claim_failed:${TOKEN_CLAIM_REASON}"
    return
  fi

  if [[ ! -f "$env_local" ]]; then
    TOKEN_CLAIM_STATUS="fail"
    TOKEN_CLAIM_REASON="env_local_missing_after_assign"
    add_failure "env_local_missing_after_assign"
    return
  fi
  if [[ ! -f "$env_bots" ]]; then
    TOKEN_CLAIM_STATUS="fail"
    TOKEN_CLAIM_REASON="env_bots_missing_after_assign"
    add_failure "env_bots_missing_after_assign"
    return
  fi

  token="$(read_last_env_value "$env_local" "TELEGRAM_BOT_TOKEN")"
  if [[ -z "$token" ]]; then
    TOKEN_CLAIM_STATUS="fail"
    TOKEN_CLAIM_REASON="telegram_token_missing_in_env_local"
    add_failure "telegram_token_missing_in_env_local"
    return
  fi
  TESTER_SCENARIO_ID="$(read_last_env_value "$env_local" "OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID")"
  TESTER_RESERVATION_GENERATION="$(
    read_last_env_value "$env_local" "OPENCLAW_TELEGRAM_TESTER_RESERVATION_GENERATION"
  )"
  TESTER_RESERVATION_TOKEN_HASH="$(
    read_last_env_value "$env_local" "OPENCLAW_TELEGRAM_TESTER_TOKEN_HASH"
  )"
  TESTER_SAFE_REUSE_GENERATION="$(
    read_last_env_value "$env_local" "OPENCLAW_TELEGRAM_SAFE_REUSE_GENERATION"
  )"
  TESTER_SAFE_REUSE_TOKEN_HASH="$(
    read_last_env_value "$env_local" "OPENCLAW_TELEGRAM_SAFE_REUSE_TOKEN_HASH"
  )"
  TESTER_SAFE_REUSE_ACCOUNT_ID="$(
    read_last_env_value "$env_local" "OPENCLAW_TELEGRAM_SAFE_REUSE_ACCOUNT_ID"
  )"
  if [[ -z "$TESTER_SCENARIO_ID" || -z "$TESTER_RESERVATION_GENERATION" ||
    ! "$TESTER_RESERVATION_TOKEN_HASH" =~ ^[a-f0-9]{64}$ ]]; then
    TOKEN_CLAIM_STATUS="fail"
    TOKEN_CLAIM_REASON="scenario_reservation_metadata_missing"
    add_failure "scenario_reservation_metadata_missing"
    return
  fi

  TOKEN_CLAIM_STATUS="ok"
  parse_assign_bot_output "$assign_output"
  TOKEN_PRESENT="yes"
  ASSIGNED_BOT_TOKEN="$token"
  TOKEN_FINGERPRINT="$(mask_token "$token")"
  RUNTIME_TOKEN_SOURCE="repo_env_local"
  TOKEN_ORIGIN_HINT="repo_env_local"
  hydrate_current_lane_bot

  if [[ ! -f "$env_bots" ]]; then
    add_failure "env_bots_missing_after_assign"
    return
  fi

  local in_pool="no"
  local line=""
  local trimmed=""
  local parsed=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="$(trim "$line")"
    if [[ -z "$trimmed" || "$trimmed" == \#* ]]; then
      continue
    fi
    parsed="$(parse_env_assignment "BOT_TOKEN" "$trimmed")"
    if [[ -n "$parsed" && "$parsed" == "$token" ]]; then
      in_pool="yes"
      break
    fi
  done < "$env_bots"

  if [[ "$in_pool" == "yes" ]]; then
    TOKEN_POOL_GUARD="ok"
  else
    TOKEN_POOL_GUARD="fail"
    add_failure "token_not_in_pool"
  fi
}

ensure_telegram_user_owner() {
  local bootstrap_output=""
  if [[ ! -x "$BOOTSTRAP_TELEGRAM_SCRIPT" ]]; then
    add_failure "telegram_session_owner_bootstrap_missing"
    return
  fi
  # Ownership is independent from tester-token availability. Resolve it on
  # every ensure so stale worktree selectors self-heal from the machine-wide
  # reference before token claim or runtime mutation begins.
  if ! bootstrap_output="$(
    cd "$REPO_ROOT" && bash "$BOOTSTRAP_TELEGRAM_SCRIPT" --copy-only 2>&1
  )"; then
    add_failure "telegram_session_owner_resolution_failed"
    printf '%s\n' "$bootstrap_output" >&2
    return
  fi
}

prepare_isolated_runtime_config() {
  if [[ -z "$RUNTIME_STATE_DIR" ]]; then
    add_failure "runtime_state_dir_missing"
    return
  fi
  if [[ -z "$ASSIGNED_BOT_TOKEN" ]]; then
    add_failure "assigned_token_missing"
    return
  fi
  if [[ -z "$RUNTIME_PORT" ]]; then
    add_failure "runtime_port_missing"
    return
  fi

  RUNTIME_CONFIG_PATH="${RUNTIME_STATE_DIR}/openclaw.telegram-live.json"
  mkdir -p "$RUNTIME_STATE_DIR"

  if ! BASE_CONFIG_PATH="$BASE_CONFIG_PATH" \
    RUNTIME_CONFIG_PATH="$RUNTIME_CONFIG_PATH" \
    ASSIGNED_BOT_TOKEN="$ASSIGNED_BOT_TOKEN" \
    RUNTIME_PORT="$RUNTIME_PORT" \
    OPENCLAW_TELEGRAM_LIVE_WORKSPACE_DIR="${OPENCLAW_TELEGRAM_LIVE_WORKSPACE_DIR:-}" \
    OPENCLAW_TELEGRAM_LIVE_DM_POLICY="${OPENCLAW_TELEGRAM_LIVE_DM_POLICY:-}" \
    OPENCLAW_TELEGRAM_LIVE_ACP_VALIDATION="${OPENCLAW_TELEGRAM_LIVE_ACP_VALIDATION:-}" \
    OPENCLAW_TELEGRAM_LIVE_MODEL="${OPENCLAW_TELEGRAM_LIVE_MODEL:-}" \
    OPENCLAW_TELEGRAM_LIVE_ENABLE_MONITOR_LISTENER="${OPENCLAW_TELEGRAM_LIVE_ENABLE_MONITOR_LISTENER:-0}" \
    HELPER_MODULE="$HELPER_MODULE" \
    node --input-type=module - <<'NODE'
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

const basePath = process.env.BASE_CONFIG_PATH;
const runtimeConfigPath = process.env.RUNTIME_CONFIG_PATH;
const assignedToken = process.env.ASSIGNED_BOT_TOKEN;
const runtimePort = Number.parseInt(process.env.RUNTIME_PORT ?? "", 10);
const workspaceDir = process.env.OPENCLAW_TELEGRAM_LIVE_WORKSPACE_DIR;
const dmPolicy = process.env.OPENCLAW_TELEGRAM_LIVE_DM_POLICY;
const preferredModel = process.env.OPENCLAW_TELEGRAM_LIVE_MODEL ?? "";
const acpValidation = process.env.OPENCLAW_TELEGRAM_LIVE_ACP_VALIDATION ?? "";
const enableHooks = process.env.OPENCLAW_TELEGRAM_LIVE_ENABLE_MONITOR_LISTENER === "1";
const helperPath = process.env.HELPER_MODULE;

if (!runtimeConfigPath || !assignedToken || !Number.isFinite(runtimePort) || runtimePort <= 0 || !helperPath) {
  throw new Error("Missing runtime config path, assigned token, or runtime port.");
}

const { buildTelegramLiveRuntimeConfig, isLocalCodexAuthAvailable } = await import(
  pathToFileURL(helperPath).href
);

let config = {};
if (basePath && fs.existsSync(basePath)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(basePath, "utf8"));
    if (parsed && typeof parsed === "object") {
      config = parsed;
    }
  } catch {
    // Fall back to a minimal config if base config is absent/invalid.
  }
}
let gatewayAuthToken = "";
let hooksToken = "";
if (fs.existsSync(runtimeConfigPath)) {
  try {
    const existing = JSON.parse(fs.readFileSync(runtimeConfigPath, "utf8"));
    const token = existing?.gateway?.auth?.token;
    if (typeof token === "string" && token.trim()) {
      gatewayAuthToken = token.trim();
    }
    const existingHooksToken = existing?.hooks?.token;
    if (typeof existingHooksToken === "string" && existingHooksToken.trim()) {
      hooksToken = existingHooksToken.trim();
    }
  } catch {
    // Ignore corrupt prior runtime config; a fresh isolated token is safer.
  }
}
if (!gatewayAuthToken) {
  gatewayAuthToken = crypto.randomBytes(32).toString("base64url");
}
if (enableHooks && (!hooksToken || hooksToken === gatewayAuthToken)) {
  // Reuse the isolated hook secret on restart, but never reuse gateway auth.
  // Neither token is printed or placed in process arguments.
  do {
    hooksToken = crypto.randomBytes(32).toString("base64url");
  } while (hooksToken === gatewayAuthToken);
}
config = buildTelegramLiveRuntimeConfig({
  acpValidation,
  baseConfig: config,
  assignedToken,
  enableHooks,
  gatewayAuthToken,
  hooksToken,
  preferredModel,
  preferCodexAuth: isLocalCodexAuthAvailable(),
  runtimePort,
  runtimeStateDir: path.dirname(runtimeConfigPath),
  worktreePath: process.cwd(),
  workspaceDir,
  dmPolicy,
});

fs.mkdirSync(path.dirname(runtimeConfigPath), { recursive: true });
fs.writeFileSync(runtimeConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
NODE
  then
    add_failure "runtime_config_prepare_failed"
  fi
}

write_parity_report() {
  PARITY_REPORT_PATH="${RUNTIME_STATE_DIR}/tester-runtime-parity.json"
  mkdir -p "$RUNTIME_STATE_DIR" "$PARITY_UPLOAD_DIR"

  local main_commit="unknown"
  local tester_commit="unknown"
  main_commit="$(git rev-parse origin/main 2>/dev/null || printf 'unknown')"
  tester_commit="$(git rev-parse HEAD 2>/dev/null || printf 'unknown')"

  if ! BASE_CONFIG_PATH="$BASE_CONFIG_PATH" \
    RUNTIME_CONFIG_PATH="$RUNTIME_CONFIG_PATH" \
    PARITY_REPORT_PATH="$PARITY_REPORT_PATH" \
    MAIN_COMMIT="$main_commit" \
    TESTER_COMMIT="$tester_commit" \
    WORKTREE="$WORKTREE" \
    RUNTIME_PORT="$RUNTIME_PORT" \
    CURRENT_LANE_BOT="$CURRENT_LANE_BOT" \
    PARITY_UPLOAD_DIR="$PARITY_UPLOAD_DIR" \
    BROWSER_SIDECAR_SKIPPED="${OPENCLAW_SKIP_BROWSER_CONTROL_SERVER:-0}" \
    HELPER_MODULE="$HELPER_MODULE" \
    node --input-type=module - <<'NODE'
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const helperPath = process.env.HELPER_MODULE;
const { buildTelegramLiveRuntimeParityReport } = await import(pathToFileURL(helperPath).href);
const report = buildTelegramLiveRuntimeParityReport({
  baseConfigPath: process.env.BASE_CONFIG_PATH,
  runtimeConfigPath: process.env.RUNTIME_CONFIG_PATH,
  mainCommit: process.env.MAIN_COMMIT,
  testerCommit: process.env.TESTER_COMMIT,
  runtimeWorktree: process.env.WORKTREE,
  runtimePort: process.env.RUNTIME_PORT,
  currentLaneBot: process.env.CURRENT_LANE_BOT,
  uploadDir: process.env.PARITY_UPLOAD_DIR,
  browserSidecarSkipped: process.env.BROWSER_SIDECAR_SKIPPED,
});
fs.writeFileSync(process.env.PARITY_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
NODE
  then
    add_failure "parity_report_failed"
    return
  fi

  local report_json=""
  report_json="$(cat "$PARITY_REPORT_PATH" 2>/dev/null || true)"
  PARITY_CONFIG_DIFF_ALLOWED_ONLY="$(printf '%s' "$report_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String(j.config_diff_allowed_only))}catch{process.stdout.write("unknown")}})')"
  PARITY_BROWSER_SIDECAR_ENABLED="$(printf '%s' "$report_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String(j.browser_sidecar_enabled))}catch{process.stdout.write("unknown")}})')"
  PARITY_BROWSER_PROFILES_MATCH="$(printf '%s' "$report_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String(j.browser_profiles_match))}catch{process.stdout.write("unknown")}})')"
  PARITY_TOOLS_MATCH="$(printf '%s' "$report_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String(j.tools_match))}catch{process.stdout.write("unknown")}})')"
  PARITY_PLUGINS_MATCH="$(printf '%s' "$report_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String(j.plugins_match))}catch{process.stdout.write("unknown")}})')"
  PARITY_MODEL_CONFIG_MATCH="$(printf '%s' "$report_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String(j.model_config_match))}catch{process.stdout.write("unknown")}})')"
  PARITY_UPLOAD_DIR_READY="$(printf '%s' "$report_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String(j.upload_dir_ready))}catch{process.stdout.write("unknown")}})')"
  PARITY_UNEXPECTED_DIFFS="$(printf '%s' "$report_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const j=JSON.parse(s);process.stdout.write((j.config_diff_unexpected_paths||[]).join(","))}catch{process.stdout.write("unknown")}})')"

  if [[ "$PARITY_CONFIG_DIFF_ALLOWED_ONLY" != "true" ]]; then
    add_failure "parity_config_diff:${PARITY_UNEXPECTED_DIFFS}"
  fi
  if [[ "$PARITY_BROWSER_SIDECAR_ENABLED" != "true" ]]; then
    add_failure "parity_browser_sidecar_disabled"
  fi
  if [[ "$PARITY_BROWSER_PROFILES_MATCH" != "true" ]]; then
    add_failure "parity_browser_profiles_mismatch"
  fi
  if [[ "$PARITY_TOOLS_MATCH" != "true" ]]; then
    add_failure "parity_tools_mismatch"
  fi
}

stage_upload_command() {
  local source_path="${1:-}"
  if [[ -z "$source_path" ]]; then
    echo "Usage: scripts/telegram-live-runtime.sh stage-upload <file>" >&2
    return 2
  fi
  if [[ ! -f "$source_path" ]]; then
    echo "error=upload_source_missing:${source_path}" >&2
    return 1
  fi

  mkdir -p "$PARITY_UPLOAD_DIR"
  local file_name target_path
  file_name="$(basename "$source_path")"
  target_path="${PARITY_UPLOAD_DIR}/${file_name}"
  cp "$source_path" "$target_path"
  echo "upload_source=${source_path}"
  echo "upload_path=${target_path}"
  echo "upload_dir=${PARITY_UPLOAD_DIR}"
  echo "upload_allowed=yes"
}

sync_runtime_auth_profiles() {
  local acp_validation="${OPENCLAW_TELEGRAM_LIVE_ACP_VALIDATION:-}"
  local normalized_acp_validation
  normalized_acp_validation="$(printf '%s' "$acp_validation" | tr '[:upper:]' '[:lower:]')"
  if [[ "$normalized_acp_validation" == "1" || "$normalized_acp_validation" == "true" || "$normalized_acp_validation" == "yes" || "$normalized_acp_validation" == "on" ]]; then
    # ACP validation should boot from a clean isolated state dir and import
    # local Codex auth before Telegram delivers the first turn. Relying on the
    # runtime to lazily materialize auth on demand is too late for this lane.
    if ! RUNTIME_STATE_DIR="$RUNTIME_STATE_DIR" \
      HELPER_MODULE="$HELPER_MODULE" \
      node --input-type=module - <<'NODE'
import { pathToFileURL } from "node:url";

const runtimeStateDir = process.env.RUNTIME_STATE_DIR;
const helperPath = process.env.HELPER_MODULE;
if (!runtimeStateDir || !helperPath) {
  throw new Error("Missing ACP validation auth bootstrap inputs.");
}

const home = process.env.HOME || os.homedir();
const sourceAuthPaths = [
  path.join(
    home,
    "Library",
    "Application Support",
    "OpenClaw",
    ".openclaw",
    "agents",
    "main",
    "agent",
    "auth-profiles.json",
  ),
  path.join(home, ".openclaw", "agents", "main", "agent", "auth-profiles.json"),
];
const { bootstrapTelegramLiveAcpValidationAuthStore } = await import(pathToFileURL(helperPath).href);
const result = bootstrapTelegramLiveAcpValidationAuthStore({
  runtimeStateDir,
  agentId: "main",
  sourceAuthPaths,
});
if (!result?.ok) {
  throw new Error(
    `ACP validation auth bootstrap failed: ${result?.reason ?? "unknown"}. Re-run Codex login or sync ~/.codex/auth.json, then retry.`,
  );
}
console.log(`codex_auth_bootstrap=${JSON.stringify({
  agentId: "main",
  sourceKind: result.sourceKind ?? "unknown",
  sourcePath: result.sourceAuthPath ?? result.codexAuthPath ?? "",
  selectedProfileId: result.selectedProfileId ?? "",
  accessExpiryMs: result.accessExpiryMs ?? null,
  expirySource: result.expirySource ?? "unknown",
  candidateCount: result.candidateCount ?? 0,
})}`);
NODE
    then
      add_failure "runtime_auth_bootstrap_failed"
    fi
    return
  fi

  if [[ -z "$RUNTIME_STATE_DIR" ]]; then
    add_failure "runtime_state_dir_missing"
    return
  fi
  if [[ -z "$RUNTIME_CONFIG_PATH" ]]; then
    add_failure "runtime_config_path_missing"
    return
  fi

  # Seed the isolated Telegram runtime from the lane's tester baseline snapshot.
  # That gives fresh worktrees real provider auth without pointing them back at
  # the shared main auth store during runtime.
  if ! RUNTIME_CONFIG_PATH="$RUNTIME_CONFIG_PATH" \
    RUNTIME_STATE_DIR="$RUNTIME_STATE_DIR" \
    BASELINE_HELPER_MODULE="$BASELINE_HELPER_MODULE" \
    WORKTREE_PATH="$WORKTREE" \
    node --input-type=module - <<'NODE'
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const runtimeConfigPath = process.env.RUNTIME_CONFIG_PATH;
const runtimeStateDir = process.env.RUNTIME_STATE_DIR;
const helperPath = process.env.BASELINE_HELPER_MODULE;
const worktreePath = process.env.WORKTREE_PATH;

if (!runtimeConfigPath || !runtimeStateDir || !helperPath || !worktreePath) {
  throw new Error("Missing runtime state dir or baseline helper inputs.");
}

const { deriveWorktreeTesterBaseline, resolveTesterBaselineAgentIds } = await import(
  pathToFileURL(helperPath).href
);
const {
  bootstrapTelegramLiveCodexAuthStoreFromSources,
  readUsableOpenClawCodexAuthStore,
  resolveTesterRuntimeAuthStoreFromSources,
  syncTelegramLiveRuntimeMemoryStore,
  syncTelegramLiveRuntimeTtsPreferences,
} = await import(pathToFileURL(path.join(path.dirname(helperPath), "telegram-live-runtime-helpers.mjs")).href);

function emitCodexAuthBootstrapDiagnostic(agentId, bootstrap) {
  console.log(`codex_auth_bootstrap=${JSON.stringify({
    agentId,
    sourceKind: bootstrap?.sourceKind ?? "unknown",
    sourcePath: bootstrap?.sourceAuthPath ?? bootstrap?.codexAuthPath ?? "",
    selectedProfileId: bootstrap?.selectedProfileId ?? "",
    accessExpiryMs: bootstrap?.accessExpiryMs ?? null,
    expirySource: bootstrap?.expirySource ?? "unknown",
    candidateCount: bootstrap?.candidateCount ?? 0,
  })}`);
}

let config = {};
if (fs.existsSync(runtimeConfigPath)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(runtimeConfigPath, "utf8"));
    if (parsed && typeof parsed === "object") {
      config = parsed;
    }
  } catch {
    // Ignore invalid runtime config here; auth sync simply falls back to defaults.
  }
}

const preferredModel =
  typeof config?.agents?.defaults?.model?.primary === "string"
    ? config.agents.defaults.model.primary
    : typeof config?.agents?.defaults?.model === "string"
      ? config.agents.defaults.model
      : "";
const preferredProvider = preferredModel.includes("/")
  ? preferredModel.slice(0, preferredModel.indexOf("/")).trim().toLowerCase()
  : "";
const needsCodexAuth = preferredProvider === "openai-codex";

const baseline = deriveWorktreeTesterBaseline({ worktreePath });
const baselineStateDir = baseline.stateDir;
const fallbackStateDir = path.join(os.homedir(), ".openclaw");
const sharedMainStateDir = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "OpenClaw",
  ".openclaw",
);
const agentIds = resolveTesterBaselineAgentIds(config);

syncTelegramLiveRuntimeTtsPreferences({
  baselineStateDir,
  runtimeStateDir,
});

syncTelegramLiveRuntimeMemoryStore({
  runtimeStateDir,
});

for (const agentId of agentIds) {
  const sourceAuthPath = path.join(
    baselineStateDir,
    "agents",
    agentId,
    "agent",
    "auth-profiles.json",
  );
  const fallbackAuthPath = path.join(
    fallbackStateDir,
    "agents",
    agentId,
    "agent",
    "auth-profiles.json",
  );
  const sharedMainAuthPath = path.join(
    sharedMainStateDir,
    "agents",
    agentId,
    "agent",
    "auth-profiles.json",
  );
  const targetAuthPath = path.join(runtimeStateDir, "agents", agentId, "agent", "auth-profiles.json");
  const sourceAuthPaths = [sourceAuthPath, fallbackAuthPath, sharedMainAuthPath];
  const selectedAuthStore = resolveTesterRuntimeAuthStoreFromSources({
    sourceAuthPaths,
    preferredModel,
  });

  if (!selectedAuthStore.ok) {
    if (needsCodexAuth) {
      const bootstrap = bootstrapTelegramLiveCodexAuthStoreFromSources({
        runtimeStateDir,
        agentId,
        sourceAuthPaths,
      });
      if (!bootstrap?.ok) {
        throw new Error(
          `Codex auth bootstrap failed for ${agentId}: ${bootstrap?.reason ?? "unknown"}. Re-run Codex login or sync ~/.codex/auth.json, then retry.`,
        );
      }
      emitCodexAuthBootstrapDiagnostic(agentId, bootstrap);
    }
    if (preferredProvider && !needsCodexAuth) {
      throw new Error(
        `Tester runtime auth sync could not find a usable ${preferredProvider} auth profile for ${agentId}; checked ${selectedAuthStore.checkedPathCount ?? 0} auth store(s). Run clean tester-lane adoption or sync main runtime auth before E2E proof.`,
      );
    }
    continue;
  }

  if (needsCodexAuth) {
    const sourceCodexAuth = readUsableOpenClawCodexAuthStore({
      authStorePath: selectedAuthStore.sourceAuthPath,
      preferredModel,
    });
    if (sourceCodexAuth.ok) {
      const bootstrap = bootstrapTelegramLiveCodexAuthStoreFromSources({
        runtimeStateDir,
        agentId,
        sourceAuthPaths,
      });
      if (!bootstrap?.ok) {
        throw new Error(
          `Codex auth bootstrap failed for ${agentId}: ${bootstrap?.reason ?? "unknown"}. Re-run Codex login or sync ~/.codex/auth.json, then retry.`,
        );
      }
      emitCodexAuthBootstrapDiagnostic(agentId, bootstrap);
      continue;
    }
  }

  const runtimeStore = selectedAuthStore.store;

  if (needsCodexAuth && Object.keys(runtimeStore.profiles ?? {}).length === 0) {
    const bootstrap = bootstrapTelegramLiveCodexAuthStoreFromSources({
      runtimeStateDir,
      agentId,
      sourceAuthPaths,
    });
    if (!bootstrap?.ok) {
      throw new Error(
        `Codex auth bootstrap failed for ${agentId}: ${bootstrap?.reason ?? "unknown"}. Re-run Codex login or sync ~/.codex/auth.json, then retry.`,
      );
    }
    emitCodexAuthBootstrapDiagnostic(agentId, bootstrap);
    continue;
  }

  fs.mkdirSync(path.dirname(targetAuthPath), { recursive: true });
  fs.writeFileSync(targetAuthPath, `${JSON.stringify(runtimeStore, null, 2)}\n`, "utf8");
  fs.chmodSync(targetAuthPath, 0o600);
}
NODE
  then
    add_failure "runtime_auth_sync_failed"
  fi
}

probe_runtime_model_auth() {
  MODEL_AUTH_PREFLIGHT_STATUS="not-run"
  MODEL_AUTH_PREFLIGHT_PROVIDER="unknown"
  MODEL_AUTH_PREFLIGHT_MODEL="unknown"
  MODEL_AUTH_PREFLIGHT_PROFILE="unknown"

  if [[ "${OPENCLAW_TELEGRAM_LIVE_SKIP_MODEL_AUTH_PREFLIGHT:-0}" == "1" ]]; then
    MODEL_AUTH_PREFLIGHT_STATUS="skipped_disabled"
    return
  fi
  if [[ -z "$RUNTIME_CONFIG_PATH" || -z "$RUNTIME_STATE_DIR" ]]; then
    MODEL_AUTH_PREFLIGHT_STATUS="fail"
    add_failure "model_auth_preflight_missing_runtime_paths"
    return
  fi

  local probe_lines=""
  if ! probe_lines="$(
    RUNTIME_CONFIG_PATH="$RUNTIME_CONFIG_PATH" \
    HELPER_MODULE="$HELPER_MODULE" \
    node --input-type=module - <<'NODE'
import { pathToFileURL } from "node:url";

const helperPath = process.env.HELPER_MODULE;
const runtimeConfigPath = process.env.RUNTIME_CONFIG_PATH;
const { resolveTelegramLiveModelAuthProbe } = await import(pathToFileURL(helperPath).href);
const probe = resolveTelegramLiveModelAuthProbe({ runtimeConfigPath });
process.stdout.write(`${probe.required ? "required" : "skipped"}\n`);
process.stdout.write(`${probe.provider || "unknown"}\n`);
process.stdout.write(`${probe.model || "unknown"}\n`);
process.stdout.write(`${probe.profile || "unknown"}\n`);
process.stdout.write(`${probe.reason || "unknown"}\n`);
NODE
  )"; then
    MODEL_AUTH_PREFLIGHT_STATUS="fail"
    add_failure "model_auth_preflight_probe_resolution_failed"
    return
  fi

  local probe_requirement probe_reason
  probe_requirement="$(printf '%s\n' "$probe_lines" | sed -n '1p')"
  MODEL_AUTH_PREFLIGHT_PROVIDER="$(printf '%s\n' "$probe_lines" | sed -n '2p')"
  MODEL_AUTH_PREFLIGHT_MODEL="$(printf '%s\n' "$probe_lines" | sed -n '3p')"
  MODEL_AUTH_PREFLIGHT_PROFILE="$(printf '%s\n' "$probe_lines" | sed -n '4p')"
  probe_reason="$(printf '%s\n' "$probe_lines" | sed -n '5p')"

  if [[ "$probe_requirement" != "required" ]]; then
    MODEL_AUTH_PREFLIGHT_STATUS="skipped_${probe_reason}"
    return
  fi

  local probe_timeout="${OPENCLAW_TELEGRAM_LIVE_MODEL_PROBE_TIMEOUT_MS:-60000}"
  if [[ ! "$probe_timeout" =~ ^[0-9]+$ ]]; then
    probe_timeout=60000
  fi

  local probe_args=(
    models status
    --json
    --probe
    --probe-provider "$MODEL_AUTH_PREFLIGHT_PROVIDER"
    --probe-timeout "$probe_timeout"
    --probe-concurrency 1
    --probe-max-tokens "${OPENCLAW_TELEGRAM_LIVE_MODEL_PROBE_MAX_TOKENS:-8}"
  )
  if [[ -n "$MODEL_AUTH_PREFLIGHT_PROFILE" && "$MODEL_AUTH_PREFLIGHT_PROFILE" != "unknown" ]]; then
    probe_args+=(--probe-profile "$MODEL_AUTH_PREFLIGHT_PROFILE")
  fi

  local probe_output=""
  if PATH="$(repo_toolchain_path)" \
    OPENCLAW_STATE_DIR="$RUNTIME_STATE_DIR" \
    OPENCLAW_CONFIG_PATH="$RUNTIME_CONFIG_PATH" \
    OPENCLAW_GATEWAY_PORT="$RUNTIME_PORT" \
    OPENCLAW_DISABLE_MAIN_AUTH_INHERITANCE=1 \
    OPENCLAW_DISABLE_EXTERNAL_CLI_AUTH_SYNC="${OPENCLAW_TELEGRAM_LIVE_DISABLE_EXTERNAL_CLI_AUTH_SYNC:-0}" \
    node scripts/run-node.mjs "${probe_args[@]}" \
      >/tmp/openclaw-telegram-live-model-probe.$$ 2>&1; then
    MODEL_AUTH_PREFLIGHT_STATUS="ok"
    rm -f /tmp/openclaw-telegram-live-model-probe.$$
    return
  fi

  probe_output="$(cat /tmp/openclaw-telegram-live-model-probe.$$ 2>/dev/null || true)"
  rm -f /tmp/openclaw-telegram-live-model-probe.$$
  MODEL_AUTH_PREFLIGHT_STATUS="fail"
  add_failure "model_auth_preflight_failed:${MODEL_AUTH_PREFLIGHT_PROVIDER}"
  if [[ -n "$probe_output" ]]; then
    echo "model_auth_preflight_error_begin" >&2
    while IFS= read -r line || [[ -n "$line" ]]; do
      sanitize_runtime_log_line "$line" >&2
    done <<< "$probe_output"
    echo "model_auth_preflight_error_end" >&2
  fi
}

ensure_telegram_sender_access() {
  TELEGRAM_SENDER_PREFLIGHT_STATUS="not-run"
  TELEGRAM_SENDER_USER_ID="unknown"
  TELEGRAM_SENDER_ACCESS_STATUS="not-run"

  if [[ "${OPENCLAW_TELEGRAM_LIVE_SKIP_SENDER_ACCESS_PREFLIGHT:-0}" == "1" ]]; then
    TELEGRAM_SENDER_PREFLIGHT_STATUS="skipped_disabled"
    TELEGRAM_SENDER_ACCESS_STATUS="skipped_disabled"
    return
  fi
  if [[ -z "$RUNTIME_CONFIG_PATH" || -z "$RUNTIME_STATE_DIR" ]]; then
    TELEGRAM_SENDER_PREFLIGHT_STATUS="fail"
    TELEGRAM_SENDER_ACCESS_STATUS="fail"
    add_failure "telegram_sender_preflight_missing_runtime_paths"
    return
  fi

  local precheck_output=""
  if ! precheck_output="$(
    cd "$REPO_ROOT" && \
      PATH="$(repo_toolchain_path)" \
      OPENCLAW_STATE_DIR="$RUNTIME_STATE_DIR" \
      OPENCLAW_CONFIG_PATH="$RUNTIME_CONFIG_PATH" \
      OPENCLAW_GATEWAY_PORT="$RUNTIME_PORT" \
      OPENCLAW_TELEGRAM_USER_REPO_LOCAL_COMPAT=1 \
      node scripts/run-node.mjs telegram-user precheck --json
  )"; then
    TELEGRAM_SENDER_PREFLIGHT_STATUS="fail"
    TELEGRAM_SENDER_ACCESS_STATUS="not-run"
    add_failure "telegram_user_preflight_failed"
    return
  fi

  local sender_id=""
  sender_id="$(
    PRECHECK_JSON="$precheck_output" node --input-type=module - <<'NODE'
const raw = process.env.PRECHECK_JSON ?? "";
try {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  const parsed = start >= 0 && end >= start ? JSON.parse(raw.slice(start, end + 1)) : {};
  const id = parsed?.user?.user_id;
  if (typeof id === "number" || typeof id === "string") {
    process.stdout.write(String(id));
  }
} catch {
  process.exit(0);
}
NODE
  )"

  if [[ -z "$sender_id" ]]; then
    TELEGRAM_SENDER_PREFLIGHT_STATUS="fail"
    TELEGRAM_SENDER_ACCESS_STATUS="not-run"
    add_failure "telegram_user_id_unresolved"
    return
  fi
  TELEGRAM_SENDER_USER_ID="$sender_id"
  TELEGRAM_SENDER_PREFLIGHT_STATUS="ok"

  local access_lines=""
  if ! access_lines="$(
    RUNTIME_STATE_DIR="$RUNTIME_STATE_DIR" \
    RUNTIME_CONFIG_PATH="$RUNTIME_CONFIG_PATH" \
    SENDER_ID="$sender_id" \
    HELPER_MODULE="$HELPER_MODULE" \
    STATE_ROOT="${OPENCLAW_TELEGRAM_LIVE_STATE_ROOT:-}" \
    node --input-type=module - <<'NODE'
import { pathToFileURL } from "node:url";

const helperPath = process.env.HELPER_MODULE;
const { ensureTelegramLiveSenderAccess } = await import(pathToFileURL(helperPath).href);
const result = ensureTelegramLiveSenderAccess({
  runtimeStateDir: process.env.RUNTIME_STATE_DIR,
  runtimeConfigPath: process.env.RUNTIME_CONFIG_PATH,
  senderId: process.env.SENDER_ID,
  stateRoot: process.env.STATE_ROOT,
});
process.stdout.write(`${result.ok ? "ok" : "fail"}\n`);
process.stdout.write(`${result.status || "unknown"}\n`);
process.stdout.write(`${result.reason || "unknown"}\n`);
NODE
  )"; then
    TELEGRAM_SENDER_ACCESS_STATUS="fail"
    add_failure "telegram_sender_access_preflight_failed"
    return
  fi

  local access_ok access_status access_reason
  access_ok="$(printf '%s\n' "$access_lines" | sed -n '1p')"
  access_status="$(printf '%s\n' "$access_lines" | sed -n '2p')"
  access_reason="$(printf '%s\n' "$access_lines" | sed -n '3p')"
  TELEGRAM_SENDER_ACCESS_STATUS="$access_status"
  if [[ "$access_ok" != "ok" ]]; then
    add_failure "telegram_sender_access_preflight_failed:${access_reason}"
  fi
}

start_isolated_runtime() {
  mkdir -p "$RUNTIME_STATE_DIR"
  if [[ -z "$RUNTIME_CONFIG_PATH" ]]; then
    RUNTIME_START_ACTION="start-failed"
    add_failure "runtime_config_path_missing"
    return
  fi
  # Shell-level `nohup ... &` is flaky in this environment: the helper shell can
  # report success while the gateway child dies immediately after detach. Launch
  # a real detached process from Node instead so the runtime survives the helper
  # shell exiting and keeps its own stdio on the runtime log file.
  if REPO_ROOT="$REPO_ROOT" \
    PROFILE_ID="$PROFILE_ID" \
    RUNTIME_STATE_DIR="$RUNTIME_STATE_DIR" \
    RUNTIME_CONFIG_PATH="$RUNTIME_CONFIG_PATH" \
    RUNTIME_PORT="$RUNTIME_PORT" \
    RUNTIME_LOG_PATH="$RUNTIME_LOG_PATH" \
    HELPER_MODULE="$HELPER_MODULE" \
    OPENCLAW_TELEGRAM_SAFE_REUSE_GENERATION="$TESTER_SAFE_REUSE_GENERATION" \
    OPENCLAW_TELEGRAM_SAFE_REUSE_TOKEN_HASH="$TESTER_SAFE_REUSE_TOKEN_HASH" \
    OPENCLAW_TELEGRAM_SAFE_REUSE_ACCOUNT_ID="$TESTER_SAFE_REUSE_ACCOUNT_ID" \
    OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID="$TESTER_SCENARIO_ID" \
    OPENCLAW_TELEGRAM_TESTER_RESERVATION_GENERATION="$TESTER_RESERVATION_GENERATION" \
    OPENCLAW_TELEGRAM_TESTER_TOKEN_HASH="$TESTER_RESERVATION_TOKEN_HASH" \
    OPENCLAW_TELEGRAM_TESTER_WORKTREE="$WORKTREE" \
    OPENCLAW_TELEGRAM_TESTER_RESERVATION_ROOT="${OPENCLAW_TELEGRAM_TESTER_RESERVATION_ROOT:-${HOME}/.openclaw/telegram-tester-scenario-reservations}" \
    OPENCLAW_TELEGRAM_LIVE_ACP_VALIDATION="${OPENCLAW_TELEGRAM_LIVE_ACP_VALIDATION:-}" \
    OPENCLAW_TELEGRAM_LIVE_DISABLE_EXTERNAL_CLI_AUTH_SYNC="${OPENCLAW_TELEGRAM_LIVE_DISABLE_EXTERNAL_CLI_AUTH_SYNC:-0}" \
    node --input-type=module - <<'NODE'
import fs from "node:fs";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const repoRoot = process.env.REPO_ROOT;
const runtimeStateDir = process.env.RUNTIME_STATE_DIR;
const runtimeConfigPath = process.env.RUNTIME_CONFIG_PATH;
const runtimePort = process.env.RUNTIME_PORT;
const profileId = process.env.PROFILE_ID;
const runtimeLogPath = process.env.RUNTIME_LOG_PATH;
const helperPath = process.env.HELPER_MODULE;
const safeReuseGeneration = process.env.OPENCLAW_TELEGRAM_SAFE_REUSE_GENERATION;
const safeReuseTokenHash = process.env.OPENCLAW_TELEGRAM_SAFE_REUSE_TOKEN_HASH;
const safeReuseAccountId = process.env.OPENCLAW_TELEGRAM_SAFE_REUSE_ACCOUNT_ID;
const testerScenarioId = process.env.OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID;
const testerReservationGeneration =
  process.env.OPENCLAW_TELEGRAM_TESTER_RESERVATION_GENERATION;
const testerTokenHash = process.env.OPENCLAW_TELEGRAM_TESTER_TOKEN_HASH;
const testerWorktree = process.env.OPENCLAW_TELEGRAM_TESTER_WORKTREE;
const acpValidation = process.env.OPENCLAW_TELEGRAM_LIVE_ACP_VALIDATION ?? "";
const preferredModel = process.env.OPENCLAW_TELEGRAM_LIVE_MODEL ?? "";
const enableCron = process.env.OPENCLAW_TELEGRAM_LIVE_ENABLE_CRON === "1";
const disableExternalCliAuthSync =
  process.env.OPENCLAW_TELEGRAM_LIVE_DISABLE_EXTERNAL_CLI_AUTH_SYNC ?? "0";

const safeReuseScopeValues = [safeReuseGeneration, safeReuseTokenHash, safeReuseAccountId];
const safeReuseScopeComplete = safeReuseScopeValues.every(Boolean);
const safeReuseScopeAbsent = safeReuseScopeValues.every((value) => !value);
if (!repoRoot || !runtimeStateDir || !runtimeConfigPath || !runtimePort || !runtimeLogPath || !helperPath || !profileId || (!safeReuseScopeComplete && !safeReuseScopeAbsent) || !testerScenarioId || !testerReservationGeneration || !testerTokenHash || !testerWorktree) {
  throw new Error("Missing detached runtime launch parameters.");
}

const { buildTelegramLiveRuntimeChildEnv } = await import(pathToFileURL(helperPath).href);

fs.mkdirSync(runtimeStateDir, { recursive: true });
const logFd = fs.openSync(runtimeLogPath, "a");
const child = spawn(
  process.execPath,
  [
    "scripts/run-node.mjs",
    "--profile",
    profileId,
    "gateway",
    "run",
    "--bind",
    "loopback",
    "--port",
    runtimePort,
    "--force",
    "--allow-unconfigured",
  ],
  {
    cwd: repoRoot,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: buildTelegramLiveRuntimeChildEnv({
      acpValidation,
      repoRoot,
      parentEnv: {
        ...process.env,
        OPENCLAW_PROFILE: process.env.OPENCLAW_PROFILE || process.env.PROFILE_ID,
        OPENCLAW_STATE_DIR: runtimeStateDir,
        OPENCLAW_CONFIG_PATH: runtimeConfigPath,
        OPENCLAW_GATEWAY_PORT: runtimePort,
        ...(safeReuseScopeComplete
          ? {
              OPENCLAW_TELEGRAM_SAFE_REUSE_GENERATION: safeReuseGeneration,
              OPENCLAW_TELEGRAM_SAFE_REUSE_TOKEN_HASH: safeReuseTokenHash,
              OPENCLAW_TELEGRAM_SAFE_REUSE_ACCOUNT_ID: safeReuseAccountId,
            }
          : {
              OPENCLAW_TELEGRAM_SAFE_REUSE_GENERATION: "",
              OPENCLAW_TELEGRAM_SAFE_REUSE_TOKEN_HASH: "",
              OPENCLAW_TELEGRAM_SAFE_REUSE_ACCOUNT_ID: "",
            }),
        OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID: testerScenarioId,
        OPENCLAW_TELEGRAM_TESTER_RESERVATION_GENERATION: testerReservationGeneration,
        OPENCLAW_TELEGRAM_TESTER_TOKEN_HASH: testerTokenHash,
        OPENCLAW_TELEGRAM_TESTER_WORKTREE: testerWorktree,
        OPENCLAW_TELEGRAM_TESTER_RESERVATION_ROOT:
          process.env.OPENCLAW_TELEGRAM_TESTER_RESERVATION_ROOT,
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        // Normal Telegram smoke lanes keep background jobs off so old cron
        // state cannot create fake chat activity. Goal/monitor proof can opt
        // into real scheduled wakes with OPENCLAW_TELEGRAM_LIVE_ENABLE_CRON=1.
        OPENCLAW_SKIP_CRON: enableCron ? "0" : "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_DISABLE_BONJOUR: "1",
        OPENCLAW_DISABLE_MAIN_AUTH_INHERITANCE: "1",
        OPENCLAW_DISABLE_EXTERNAL_CLI_AUTH_SYNC: disableExternalCliAuthSync,
      },
      preferredModel,
    }),
  },
);
child.unref();
fs.closeSync(logFd);
NODE
  then
    RUNTIME_START_ACTION="started"
  else
    RUNTIME_START_ACTION="start-failed"
    add_failure "runtime_start_failed"
  fi
}

probe_monitor_hook_readiness() {
  [[ "$MONITOR_LISTENER_ENABLED" == "yes" ]] || return 0
  # A healthy gateway process is insufficient: it may have booted before this
  # ensure enabled hooks. An authenticated malformed request must reach the
  # exact isolated route (HTTP 400); 401/404 prove auth/registration is absent.
  RUNTIME_CONFIG_PATH="$RUNTIME_CONFIG_PATH" RUNTIME_PORT="$RUNTIME_PORT" \
    node --input-type=module - <<'NODE'
import fs from "node:fs";
const config = JSON.parse(fs.readFileSync(process.env.RUNTIME_CONFIG_PATH, "utf8"));
const token = config?.hooks?.token;
if (config?.hooks?.enabled !== true || typeof token !== "string" || !token.trim()) {
  process.exit(1);
}
try {
  const response = await fetch(
    `http://127.0.0.1:${process.env.RUNTIME_PORT}/hooks/telegram-user-monitor-event`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(2500),
    },
  );
  process.exit(response.status === 400 ? 0 : 1);
} catch {
  process.exit(1);
}
NODE
}

start_isolated_monitor_listener() {
  MONITOR_LISTENER_START_ACTION="start-failed"
  mkdir -p "$(dirname "$MONITOR_LISTENER_CRON_STORE_PATH")"
  rm -f "$MONITOR_LISTENER_OWNER_PATH" "$MONITOR_LISTENER_HEALTH_STORE_PATH"

  if REPO_ROOT="$REPO_ROOT" \
    WORKTREE="$WORKTREE" \
    PROFILE_ID="$PROFILE_ID" \
    RUNTIME_STATE_DIR="$RUNTIME_STATE_DIR" \
    RUNTIME_CONFIG_PATH="$RUNTIME_CONFIG_PATH" \
    RUNTIME_PORT="$RUNTIME_PORT" \
    LISTENER_CRON_STORE_PATH="$MONITOR_LISTENER_CRON_STORE_PATH" \
    LISTENER_MONITOR_STORE_PATH="$MONITOR_LISTENER_MONITOR_STORE_PATH" \
    LISTENER_CURSOR_STORE_PATH="$MONITOR_LISTENER_CURSOR_STORE_PATH" \
    LISTENER_OWNER_PATH="$MONITOR_LISTENER_OWNER_PATH" \
    LISTENER_LOG_PATH="$MONITOR_LISTENER_LOG_PATH" \
    HELPER_MODULE="$HELPER_MODULE" \
    node --input-type=module - <<'NODE'
import fs from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { pathToFileURL } from "node:url";

const config = JSON.parse(fs.readFileSync(process.env.RUNTIME_CONFIG_PATH, "utf8"));
const hooksToken = config?.hooks?.token;
if (config?.hooks?.enabled !== true || typeof hooksToken !== "string" || !hooksToken.trim()) {
  throw new Error("Isolated monitor hooks are not configured.");
}
const { buildTelegramLiveRuntimeChildEnv } = await import(
  pathToFileURL(process.env.HELPER_MODULE).href
);
const childEnv = buildTelegramLiveRuntimeChildEnv({
  repoRoot: process.env.REPO_ROOT,
  parentEnv: {
    ...process.env,
    OPENCLAW_PROFILE: process.env.PROFILE_ID,
    OPENCLAW_STATE_DIR: process.env.RUNTIME_STATE_DIR,
    OPENCLAW_CONFIG_PATH: process.env.RUNTIME_CONFIG_PATH,
    OPENCLAW_GATEWAY_PORT: process.env.RUNTIME_PORT,
    // The dedicated hook bearer stays in child env only. It is never printed,
    // persisted in the ownership record, or exposed in argv.
    OPENCLAW_HOOKS_TOKEN: hooksToken,
    OPENCLAW_GATEWAY_TOKEN: "",
    // The owner record must identify the process that reports listener health.
    // Running the built CLI directly and disabling its optional respawn keeps
    // lifecycle ownership on one exact PID instead of a wrapper process tree.
    OPENCLAW_NO_RESPAWN: "1",
  },
});
const envFile = childEnv.OPENCLAW_TELEGRAM_USER_ENV_FILE;
const session = childEnv.OPENCLAW_TELEGRAM_USER_SESSION;
if (!envFile || !session) {
  throw new Error("Telegram-user selectors were not resolved for the isolated listener.");
}
const hookUrl =
  `http://127.0.0.1:${process.env.RUNTIME_PORT}/hooks/telegram-user-monitor-event`;
const instanceId = randomBytes(24).toString("hex");
childEnv.OPENCLAW_TELEGRAM_LIVE_MONITOR_LISTENER_INSTANCE = instanceId;
const args = [
  "openclaw.mjs",
  "--profile",
  process.env.PROFILE_ID,
  "telegram-user",
  "monitor-poll",
  "--watch",
  "--poll-interval-ms",
  "1000",
  "--cron-store",
  process.env.LISTENER_CRON_STORE_PATH,
  "--monitor-store",
  process.env.LISTENER_MONITOR_STORE_PATH,
  "--cursor-store",
  process.env.LISTENER_CURSOR_STORE_PATH,
  "--hook-url",
  hookUrl,
  "--env-file",
  envFile,
  "--session",
  session,
  "--json",
];
const readBirthIdentity = (pid) => {
  if (process.env.OPENCLAW_TELEGRAM_LIVE_TEST_FORCE_LISTENER_LSTART_MISSING === "1") {
    return "";
  }
  try {
    return execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    }).trim().replace(/\s+/g, " ");
  } catch {
    return "";
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const terminateExactSpawn = async (child, birthIdentity) => {
  // Before owner publication, the still-referenced ChildProcess handle is the
  // strongest identity available. It cannot accidentally select an unrelated
  // process, and birth identity adds a second guard whenever macOS supplied it.
  if (
    !child?.pid ||
    child.exitCode !== null ||
    child.signalCode !== null ||
    (birthIdentity && readBirthIdentity(child.pid) !== birthIdentity)
  ) {
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(100);
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    if (birthIdentity && readBirthIdentity(child.pid) !== birthIdentity) {
      return;
    }
  }
  if (
    child.exitCode === null &&
    child.signalCode === null &&
    (!birthIdentity || readBirthIdentity(child.pid) === birthIdentity)
  ) {
    try {
      child.kill("SIGKILL");
    } catch {
      // The exact child exited between the final birth check and signal.
    }
  }
};
fs.mkdirSync(process.env.RUNTIME_STATE_DIR, { recursive: true });
const logFd = fs.openSync(process.env.LISTENER_LOG_PATH, "a");
const tempPath = `${process.env.LISTENER_OWNER_PATH}.${process.pid}.tmp`;
let child;
let childBirthIdentity = "";
try {
  child = spawn(process.execPath, args, {
    cwd: process.env.REPO_ROOT,
    detached: true,
    env: childEnv,
    stdio: ["ignore", logFd, logFd],
  });
  await once(child, "spawn");
  for (let attempt = 0; attempt < 20 && !childBirthIdentity; attempt += 1) {
    childBirthIdentity = readBirthIdentity(child.pid);
    if (!childBirthIdentity) {
      await sleep(25);
    }
  }
  if (!childBirthIdentity) {
    throw new Error("Could not capture isolated monitor listener birth identity.");
  }
  const owner = {
    version: 2,
    pid: child.pid,
    birthIdentity: childBirthIdentity,
    instanceId,
    executable: process.execPath,
    argv: args,
    cwd: process.env.REPO_ROOT,
    profileId: process.env.PROFILE_ID,
    worktree: process.env.WORKTREE,
    cronStorePath: process.env.LISTENER_CRON_STORE_PATH,
    monitorStorePath: process.env.LISTENER_MONITOR_STORE_PATH,
    cursorStorePath: process.env.LISTENER_CURSOR_STORE_PATH,
    envFile,
    session,
    hookUrl,
    startedAtMs: Date.now(),
  };
  if (process.env.OPENCLAW_TELEGRAM_LIVE_TEST_FAIL_LISTENER_OWNER_WRITE === "1") {
    await sleep(100);
    throw new Error("Injected listener owner write failure.");
  }
  fs.writeFileSync(tempPath, `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, process.env.LISTENER_OWNER_PATH);
  child.unref();
} catch (error) {
  fs.rmSync(tempPath, { force: true });
  if (child?.pid) {
    await terminateExactSpawn(child, childBirthIdentity);
  }
  throw error;
} finally {
  fs.closeSync(logFd);
}
NODE
  then
    MONITOR_LISTENER_START_ACTION="started"
  else
    add_failure "monitor_listener_start_failed"
  fi
}

ensure_isolated_monitor_listener() {
  [[ "$MONITOR_LISTENER_ENABLED" == "yes" ]] || return 0
  if [[ "$RUNTIME_OWNERSHIP" != "ok" || "$RUNTIME_HEALTH" != "ok" ]]; then
    add_failure "monitor_listener_gateway_not_ready"
    return 0
  fi

  resolve_monitor_listener_owner
  probe_monitor_listener_health
  if [[ "$MONITOR_LISTENER_OWNERSHIP" == "ok" && "$MONITOR_LISTENER_HEALTH" == "ok" ]]; then
    MONITOR_LISTENER_START_ACTION="reused"
    return 0
  fi
  if [[ "$MONITOR_LISTENER_OWNERSHIP" == "ok" ]]; then
    stop_owned_monitor_listener
  elif [[ "$MONITOR_LISTENER_OWNERSHIP" == "stale-record" ]]; then
    rm -f "$MONITOR_LISTENER_OWNER_PATH" "$MONITOR_LISTENER_HEALTH_STORE_PATH"
  elif [[ "$MONITOR_LISTENER_OWNERSHIP" != "missing" ]]; then
    add_failure "monitor_listener_not_owned:${MONITOR_LISTENER_OWNERSHIP}"
    return 0
  fi
  [[ "$FAIL" -eq 0 ]] || return 0

  start_isolated_monitor_listener
  local waited=0
  local timeout="${OPENCLAW_TELEGRAM_LIVE_MONITOR_LISTENER_TIMEOUT_SECS:-30}"
  [[ "$timeout" =~ ^[0-9]+$ ]] || timeout=30
  while [[ "$waited" -lt "$timeout" ]]; do
    resolve_monitor_listener_owner
    probe_monitor_listener_health
    if [[ "$MONITOR_LISTENER_OWNERSHIP" == "ok" && "$MONITOR_LISTENER_HEALTH" == "ok" ]]; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  # A child that never publishes exact health is not useful and must not keep
  # polling after ensure fails. The stop path revalidates its complete birth
  # identity before every signal.
  if [[ "$MONITOR_LISTENER_START_ACTION" == "started" ]]; then
    stop_owned_monitor_listener
  fi
  add_failure "monitor_listener_readiness_failed"
}

emit_ensure_proof_lines() {
  echo "branch=${BRANCH:-unknown}"
  echo "worktree=${WORKTREE}"
  echo "runtime_pid=${RUNTIME_PID:-}"
  echo "runtime_worktree=${RUNTIME_WORKTREE:-}"
  echo "runtime_port=${RUNTIME_PORT:-}"
  echo "runtime_state_dir=${RUNTIME_STATE_DIR:-}"
  echo "runtime_ownership=${RUNTIME_OWNERSHIP}"
  echo "runtime_health=${RUNTIME_HEALTH}"
  echo "runtime_start_action=${RUNTIME_START_ACTION}"
  echo "runtime_start_timeout_secs=${RUNTIME_START_TIMEOUT_SECS}"
  echo "runtime_plugin_mode=${RUNTIME_PLUGIN_MODE}"
  echo "monitor_listener_enabled=${MONITOR_LISTENER_ENABLED}"
  echo "monitor_listener_pid=${MONITOR_LISTENER_PID:-}"
  echo "monitor_listener_ownership=${MONITOR_LISTENER_OWNERSHIP}"
  echo "monitor_listener_health=${MONITOR_LISTENER_HEALTH}"
  echo "monitor_listener_start_action=${MONITOR_LISTENER_START_ACTION}"
  echo "monitor_listener_cron_store=${MONITOR_LISTENER_CRON_STORE_PATH:-}"
  echo "monitor_listener_monitor_store=${MONITOR_LISTENER_MONITOR_STORE_PATH:-}"
  echo "monitor_listener_cursor_store=${MONITOR_LISTENER_CURSOR_STORE_PATH:-}"
  echo "token_present=${TOKEN_PRESENT}"
  echo "token_pool_guard=${TOKEN_POOL_GUARD}"
  echo "token_bootstrap_status=${TOKEN_BOOTSTRAP_STATUS}"
  echo "token_fingerprint=${TOKEN_FINGERPRINT}"
  echo "current_lane_bot=${CURRENT_LANE_BOT}"
  echo "runtime_token_source=${RUNTIME_TOKEN_SOURCE}"
  echo "token_origin_hint=${TOKEN_ORIGIN_HINT}"
  echo "assigned_bot_id=${ASSIGNED_BOT_ID}"
  echo "assigned_bot_username=${ASSIGNED_BOT_USERNAME}"
  echo "assigned_bot_name=${ASSIGNED_BOT_NAME}"
  echo "tester_scenario_id=${TESTER_SCENARIO_ID}"
  echo "tester_reservation_generation=${TESTER_RESERVATION_GENERATION}"
  echo "tester_reservation_token_hash=${TESTER_RESERVATION_TOKEN_HASH}"
  echo "token_claim_count=${TOKEN_CLAIM_COUNT}"
  echo "model_auth_preflight=${MODEL_AUTH_PREFLIGHT_STATUS}"
  echo "model_auth_preflight_provider=${MODEL_AUTH_PREFLIGHT_PROVIDER}"
  echo "model_auth_preflight_model=${MODEL_AUTH_PREFLIGHT_MODEL}"
  echo "model_auth_preflight_profile=${MODEL_AUTH_PREFLIGHT_PROFILE}"
  echo "telegram_sender_preflight=${TELEGRAM_SENDER_PREFLIGHT_STATUS}"
  echo "telegram_sender_user_id=${TELEGRAM_SENDER_USER_ID}"
  echo "telegram_sender_access=${TELEGRAM_SENDER_ACCESS_STATUS}"
  echo "parity_report_path=${PARITY_REPORT_PATH}"
  echo "config_diff_allowed_only=${PARITY_CONFIG_DIFF_ALLOWED_ONLY}"
  echo "browser_sidecar_enabled=${PARITY_BROWSER_SIDECAR_ENABLED}"
  echo "browser_profiles_match=${PARITY_BROWSER_PROFILES_MATCH}"
  echo "tools_match=${PARITY_TOOLS_MATCH}"
  echo "plugins_match=${PARITY_PLUGINS_MATCH}"
  echo "model_config_match=${PARITY_MODEL_CONFIG_MATCH}"
  echo "upload_dir=${PARITY_UPLOAD_DIR}"
  echo "upload_dir_ready=${PARITY_UPLOAD_DIR_READY}"
  echo "parity_unexpected_diffs=${PARITY_UNEXPECTED_DIFFS}"
  for claim_path in "${TOKEN_CLAIM_PATHS[@]-}"; do
    if [[ -z "$claim_path" ]]; then
      continue
    fi
    echo "token_claim_path=${claim_path}"
  done
}

release_profile_command_lock() {
  if [[ "$PROFILE_COMMAND_LOCK_OWNED" != "yes" || -z "$PROFILE_COMMAND_LOCK_DIR" ]]; then
    return
  fi
  # The owner keeps the directory for the full command transaction. A waiter
  # never deletes it, so this cleanup cannot erase a successor's lock.
  rm -rf "$PROFILE_COMMAND_LOCK_DIR"
  PROFILE_COMMAND_LOCK_OWNED="no"
}

acquire_profile_command_lock() {
  local timeout_secs="${OPENCLAW_TELEGRAM_LIVE_COMMAND_LOCK_TIMEOUT_SECS:-300}"
  if [[ ! "$timeout_secs" =~ ^[0-9]+$ ]]; then
    timeout_secs=300
  fi
  local deadline=$((SECONDS + timeout_secs))
  local owner_pid=""
  if [[ -z "$PROFILE_COMMAND_LOCK_DIR" || "$PROFILE_COMMAND_LOCK_DIR" != /* ]]; then
    echo "Error: refusing Telegram live command lock for invalid stable lock path." >&2
    return 1
  fi
  # resolve_profile derives this path from state-root + worktree profile ID,
  # independent of the normal/ACP runtime-state variant. That keeps every
  # lifecycle mutator on one transaction while they share reservation/env data.
  mkdir -p -- "$(dirname "$PROFILE_COMMAND_LOCK_DIR")"

  while ! mkdir "$PROFILE_COMMAND_LOCK_DIR" 2>/dev/null; do
    owner_pid=""
    if [[ -r "${PROFILE_COMMAND_LOCK_DIR}/owner.pid" ]]; then
      IFS= read -r owner_pid < "${PROFILE_COMMAND_LOCK_DIR}/owner.pid" || true
    fi
    if [[ "$owner_pid" =~ ^[0-9]+$ ]] && ! kill -0 "$owner_pid" 2>/dev/null; then
      echo "Error: stale Telegram live command lock requires manual recovery: ${PROFILE_COMMAND_LOCK_DIR}" >&2
      echo "Recorded owner PID is not running: ${owner_pid}" >&2
      return 1
    fi
    if (( SECONDS >= deadline )); then
      echo "Error: timed out waiting for Telegram live command lock: ${PROFILE_COMMAND_LOCK_DIR}" >&2
      return 1
    fi
    sleep 0.05
  done

  PROFILE_COMMAND_LOCK_OWNED="yes"
  printf '%s\n' "$$" > "${PROFILE_COMMAND_LOCK_DIR}/owner.pid"
  printf '{"version":1,"pid":%s,"createdAt":"%s"}\n' \
    "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "${PROFILE_COMMAND_LOCK_DIR}/owner.json"
}

with_profile_command_lock() (
  # The lock lives beside the stable profile directory, outside either
  # removable runtime-state variant. Running the command in a subshell gives
  # EXIT/interrupt cleanup a bounded scope while preserving stdout, stderr,
  # and exit status.
  resolve_profile
  acquire_profile_command_lock || exit 1
  trap release_profile_command_lock EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  "$@"
)

ensure_command_unlocked() {
  resolve_profile
  resolve_base_config_path
  if [[ "${OPENCLAW_TELEGRAM_LIVE_ENABLE_MONITOR_LISTENER:-0}" == "1" ]]; then
    MONITOR_LISTENER_ENABLED="yes"
  fi

  if [[ -z "${BRANCH}" || "${BRANCH}" == "HEAD" ]]; then
    add_failure "branch_detached_head"
  fi

  resolve_runtime_owner

  if [[ -n "$RUNTIME_PID" && "$RUNTIME_OWNERSHIP" != "ok" ]]; then
    add_failure "runtime_owned_by_other_worktree_or_process"
  fi
  if [[ "$FAIL" -eq 0 ]]; then
    reset_acp_validation_runtime_state_if_needed
  fi

  if [[ "$FAIL" -eq 0 ]]; then
    ensure_telegram_user_owner
  fi
  if [[ "$FAIL" -eq 0 ]]; then
    ensure_tester_bot_claim
  fi
  if [[ "$FAIL" -eq 0 ]]; then
    prepare_isolated_runtime_config
  fi
  if [[ "$FAIL" -eq 0 ]]; then
    write_parity_report
  fi
  if [[ "$FAIL" -eq 0 ]]; then
    sync_runtime_auth_profiles
  fi
  if [[ "$FAIL" -eq 0 ]]; then
    probe_runtime_model_auth
  fi
  if [[ "$FAIL" -eq 0 ]]; then
    ensure_telegram_sender_access
  fi

  resolve_runtime_owner

  if [[ -z "$RUNTIME_PID" && "$FAIL" -eq 0 ]]; then
    start_isolated_runtime
  fi

  if [[ "$FAIL" -eq 0 ]]; then
    local waited=0
    # Cold isolated boots can take a couple of minutes on this repo because the
    # runtime still initializes bundled services before Telegram is ready.
    local startup_timeout="${OPENCLAW_TELEGRAM_LIVE_START_TIMEOUT_SECS:-240}"
    if [[ ! "$startup_timeout" =~ ^[0-9]+$ ]]; then
      startup_timeout=240
    fi
    RUNTIME_START_TIMEOUT_SECS="$startup_timeout"
    while [[ "$waited" -lt "$startup_timeout" ]]; do
      resolve_runtime_owner
      if [[ "$RUNTIME_OWNERSHIP" == "ok" ]]; then
        probe_runtime_health
        if [[ "$RUNTIME_HEALTH" == "ok" ]]; then
          probe_runtime_stability
          if [[ "$RUNTIME_HEALTH" == "ok" ]]; then
            break
          fi
        fi
      fi
      sleep 1
      waited=$((waited + 1))
    done
  fi

  if [[ "$FAIL" -eq 0 && "$RUNTIME_OWNERSHIP" != "ok" ]]; then
    add_failure "runtime_ownership_check_failed"
  fi
  if [[ "$FAIL" -eq 0 && "$RUNTIME_HEALTH" != "ok" ]]; then
    add_failure "runtime_health_check_failed"
  fi
  if [[ "$FAIL" -eq 0 && "$MONITOR_LISTENER_ENABLED" == "yes" ]]; then
    if ! probe_monitor_hook_readiness; then
      # Reload is disabled in tester profiles. If this gateway predated the
      # opt-in config, restart only the owned isolated gateway so it registers
      # the newly enabled hook route and token.
      stop_owned_runtime
      if [[ "$FAIL" -eq 0 ]]; then
        start_isolated_runtime
        local hook_waited=0
        local hook_timeout="${OPENCLAW_TELEGRAM_LIVE_START_TIMEOUT_SECS:-240}"
        [[ "$hook_timeout" =~ ^[0-9]+$ ]] || hook_timeout=240
        while [[ "$hook_waited" -lt "$hook_timeout" ]]; do
          resolve_runtime_owner
          probe_runtime_health
          if [[ "$RUNTIME_OWNERSHIP" == "ok" && "$RUNTIME_HEALTH" == "ok" ]] &&
            probe_monitor_hook_readiness; then
            break
          fi
          sleep 1
          hook_waited=$((hook_waited + 1))
        done
      fi
      if [[ "$FAIL" -eq 0 ]] && ! probe_monitor_hook_readiness; then
        add_failure "monitor_listener_hook_not_ready"
      fi
    fi
  fi
  if [[ "$FAIL" -eq 0 ]]; then
    ensure_isolated_monitor_listener
  fi
  if [[ "${TOKEN_CLAIM_COUNT}" -gt 1 ]]; then
    add_failure "token_claim_count:${TOKEN_CLAIM_COUNT}"
  fi

  emit_ensure_proof_lines

  if [[ "$FAIL" -ne 0 ]]; then
    local reason
    for reason in "${FAIL_REASONS[@]-}"; do
      echo "error=${reason}" >&2
    done
    if [[ -n "$RUNTIME_LOG_PATH" ]] &&
      [[ "$RUNTIME_START_ACTION" == "started" || "$RUNTIME_START_ACTION" == "start-failed" ]]; then
      echo "runtime_log=${RUNTIME_LOG_PATH}" >&2
      emit_runtime_log_summary
    fi
    return 1
  fi
}

ensure_command() {
  with_profile_command_lock ensure_command_unlocked
}

emit_handoff_proof_lines() {
  echo "handoff_worktree=${WORKTREE}"
  echo "handoff_runtime_port=${RUNTIME_PORT:-}"
  echo "handoff_stopped_pid=${STOPPED_RUNTIME_PID}"
  echo "handoff_runtime_stop=${RUNTIME_STOP_RESULT}"
}

handoff_main_command_unlocked() {
  resolve_profile
  stop_owned_monitor_listener
  resolve_runtime_owner
  stop_owned_runtime
  emit_handoff_proof_lines

  local pre_health="fail"
  if openclaw gateway status --deep --require-rpc >/dev/null 2>&1; then
    pre_health="ok"
  fi

  local recover_result="fail"
  local main_health="fail"
  if [[ "$(uname -s)" != "Darwin" ]]; then
    recover_result="skip-non-darwin"
    main_health="skip-non-darwin"
  elif [[ ! -x "$MAIN_RECOVER_SCRIPT" ]]; then
    recover_result="fail-missing-script"
    add_failure "main_recover_script_missing"
  elif "$MAIN_RECOVER_SCRIPT"; then
    if [[ "$pre_health" == "ok" ]]; then
      recover_result="already-healthy"
    else
      recover_result="ok"
    fi
    if openclaw gateway status --deep --require-rpc >/dev/null 2>&1; then
      main_health="ok"
    else
      main_health="fail"
      add_failure "main_health_check_failed"
    fi
  else
    recover_result="fail"
    add_failure "main_recover_failed"
  fi

  echo "handoff_main_recover=${recover_result}"
  echo "handoff_main_health=${main_health}"

  if [[ "$recover_result" != "ok" && "$recover_result" != "already-healthy" && "$recover_result" != "skip-non-darwin" ]]; then
    return 1
  fi
  if [[ "$main_health" == "fail" ]]; then
    return 1
  fi
}

handoff_main_command() {
  with_profile_command_lock handoff_main_command_unlocked
}

release_command_unlocked() {
  resolve_profile
  # The listener is a sibling child, not a launchd service and not a gateway
  # descendant. Stop it first while its isolated ownership record still exists.
  stop_owned_monitor_listener
  resolve_runtime_owner

  local env_local="${REPO_ROOT}/.env.local"
  local release_token_present_before="no"
  local release_token_cleared="no"
  local release_token_fingerprint="none"
  local release_runtime_pid="${RUNTIME_PID:-}"
  local release_runtime_state_removed="no"
  local token_before=""
  local scenario_before=""
  local generation_before=""

  if [[ -f "$env_local" ]]; then
    token_before="$(read_last_env_value "$env_local" "TELEGRAM_BOT_TOKEN")"
    scenario_before="$(read_last_env_value "$env_local" "OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID")"
    generation_before="$(
      read_last_env_value "$env_local" "OPENCLAW_TELEGRAM_TESTER_RESERVATION_GENERATION"
    )"
  fi

  if [[ -n "$token_before" ]]; then
    release_token_present_before="yes"
    release_token_fingerprint="$(mask_token "$token_before")"
  fi

  if [[ -n "$RUNTIME_PID" && "$RUNTIME_OWNERSHIP" != "ok" ]]; then
    add_failure "release_runtime_owned_by_other_worktree_or_process"
  fi

  if [[ "$FAIL" -eq 0 ]]; then
    stop_owned_runtime
  fi

  if [[ "$FAIL" -eq 0 && "$release_token_present_before" == "yes" ]]; then
    local release_lines=""
    local release_ok=""
    local release_reason=""
    if [[ -z "$scenario_before" && -z "$generation_before" ]]; then
      # Pre-reservation tester lanes have only the token claim. The owned
      # runtime is stopped above; clear that exact legacy claim under the same
      # token-specific lock used by modern reservation acquisition.
      if ! release_lines="$(
        TOKEN="$token_before" \
        ENV_LOCAL_PATH="$env_local" \
        RESERVATION_ROOT="${OPENCLAW_TELEGRAM_TESTER_RESERVATION_ROOT:-${HOME}/.openclaw/telegram-tester-scenario-reservations}" \
        SCENARIO_RESERVATION_MODULE="$SCENARIO_RESERVATION_MODULE" \
        node --input-type=module - <<'NODE'
import { pathToFileURL } from "node:url";

const { releaseLegacyTelegramTesterTokenAssignment } = await import(
  pathToFileURL(process.env.SCENARIO_RESERVATION_MODULE).href
);
const result = await releaseLegacyTelegramTesterTokenAssignment({
  token: process.env.TOKEN,
  envLocalPath: process.env.ENV_LOCAL_PATH,
  reservationRoot: process.env.RESERVATION_ROOT,
});
process.stdout.write(`${result.ok ? "ok" : "fail"}\n`);
process.stdout.write(`${result.reason ?? "unknown"}\n`);
NODE
      )"; then
        add_failure "release_legacy_token_assignment_command_failed"
      else
        release_ok="$(printf '%s\n' "$release_lines" | sed -n '1p')"
        release_reason="$(printf '%s\n' "$release_lines" | sed -n '2p')"
        if [[ "$release_ok" == "ok" ]] &&
          [[ -z "$(read_last_env_value "$env_local" "TELEGRAM_BOT_TOKEN")" ]]; then
          release_token_cleared="yes"
        else
          add_failure "release_legacy_token_assignment_failed:${release_reason}"
        fi
      fi
    elif [[ -z "$scenario_before" || -z "$generation_before" ]]; then
      add_failure "release_scenario_reservation_metadata_missing"
    elif ! release_lines="$(
      TOKEN="$token_before" \
      SCENARIO_ID="$scenario_before" \
      GENERATION="$generation_before" \
      WORKTREE="$WORKTREE" \
      ENV_LOCAL_PATH="$env_local" \
      RESERVATION_ROOT="${OPENCLAW_TELEGRAM_TESTER_RESERVATION_ROOT:-${HOME}/.openclaw/telegram-tester-scenario-reservations}" \
      SCENARIO_RESERVATION_MODULE="$SCENARIO_RESERVATION_MODULE" \
      node --input-type=module - <<'NODE'
import { pathToFileURL } from "node:url";

const { releaseTelegramTesterScenarioReservation } = await import(
  pathToFileURL(process.env.SCENARIO_RESERVATION_MODULE).href
);
const result = await releaseTelegramTesterScenarioReservation({
  token: process.env.TOKEN,
  scenarioId: process.env.SCENARIO_ID,
  worktreePath: process.env.WORKTREE,
  generation: process.env.GENERATION,
  envLocalPath: process.env.ENV_LOCAL_PATH,
  reservationRoot: process.env.RESERVATION_ROOT,
});
process.stdout.write(`${result.ok ? "ok" : "fail"}\n`);
process.stdout.write(`${result.reason ?? "unknown"}\n`);
NODE
    )"; then
      add_failure "release_scenario_reservation_command_failed"
    else
      release_ok="$(printf '%s\n' "$release_lines" | sed -n '1p')"
      release_reason="$(printf '%s\n' "$release_lines" | sed -n '2p')"
      if [[ "$release_ok" == "ok" ]] &&
        [[ -z "$(read_last_env_value "$env_local" "TELEGRAM_BOT_TOKEN")" ]] &&
        [[ -z "$(read_last_env_value "$env_local" "OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID")" ]]; then
        release_token_cleared="yes"
      else
        add_failure "release_scenario_reservation_failed:${release_reason}"
      fi
    fi
  fi

  if [[ "$FAIL" -eq 0 ]]; then
    remove_runtime_state_dir
    if [[ ! -e "$RUNTIME_STATE_DIR" ]]; then
      release_runtime_state_removed="yes"
    else
      add_failure "release_runtime_state_remove_failed"
    fi
  fi

  echo "release_worktree=${WORKTREE}"
  echo "release_runtime_port=${RUNTIME_PORT:-}"
  echo "release_runtime_pid=${release_runtime_pid}"
  echo "release_runtime_stop=${RUNTIME_STOP_RESULT}"
  echo "release_runtime_state_dir=${RUNTIME_STATE_DIR:-}"
  echo "release_runtime_state_removed=${release_runtime_state_removed}"
  echo "release_monitor_listener_stop=${MONITOR_LISTENER_STOP_RESULT}"
  echo "release_token_present_before=${release_token_present_before}"
  echo "release_token_cleared=${release_token_cleared}"
  echo "release_token_fingerprint=${release_token_fingerprint}"
  echo "release_scenario_id=${scenario_before:-none}"
  echo "release_reservation_generation=${generation_before:-none}"

  if [[ "$FAIL" -ne 0 ]]; then
    local reason
    for reason in "${FAIL_REASONS[@]-}"; do
      echo "error=${reason}" >&2
    done
    return 1
  fi
}

release_command() {
  with_profile_command_lock release_command_unlocked
}

usage() {
  cat <<'USAGE'
Usage:
  scripts/telegram-live-runtime.sh [ensure|handoff-main|release|stage-upload <file>]

Commands:
  ensure       Validate and ensure isolated Telegram live runtime ownership for this worktree.
  handoff-main Stop isolated worktree runtime (if owned) and recover stable main runtime.
  release      Stop isolated worktree runtime (if owned) and clear this worktree tester bot claim.
  stage-upload Copy a benchmark asset under /tmp/openclaw/uploads for browser upload tools.
USAGE
}

main() {
  local cmd="${1:-ensure}"

  # Help is read-only. Every executable mode can claim, boot, stop, recover, or
  # stage state for a live tester campaign, so keep it inside one shared slot.
  case "$cmd" in
    -h|--help|help)
      usage
      return 0
      ;;
    ensure|handoff-main|release|stage-upload)
      ;;
    *)
      echo "Unknown command: $cmd" >&2
      usage >&2
      return 1
      ;;
  esac
  openclaw_heavy_local_slot_require_or_reexec \
    "telegram-live-runtime:${cmd}" \
    "$REPO_ROOT" \
    "$REPO_ROOT/scripts/telegram-live-runtime.sh" \
    "${ORIGINAL_ARGS[@]}"

  case "$cmd" in
    ensure)
      ensure_command
      ;;
    handoff-main)
      handoff_main_command
      ;;
    release)
      release_command
      ;;
    stage-upload)
      shift
      stage_upload_command "$@"
      ;;
  esac
}

main "$@"
