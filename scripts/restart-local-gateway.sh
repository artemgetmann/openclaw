#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
source "$ROOT/scripts/lib/validated-node.sh"
openclaw_use_validated_node "$ROOT" >/dev/null
NODE="$OPENCLAW_NODE_BIN"
CLI="$ROOT/openclaw.mjs"
EXPECTED_ENTRY="$ROOT/dist/index.js"
PREFLIGHT="$ROOT/scripts/local-runtime-preflight.sh"
DEFERRED_RESTART_DELAY_SECONDS="${OPENCLAW_DEFERRED_RESTART_DELAY_SECONDS:-1}"
HELPER_LOG_PATH="${OPENCLAW_RESTART_HELPER_LOG:-/tmp/openclaw-restart-helper.log}"
source "$ROOT/scripts/lib/consumer-instance.sh"
source "$ROOT/scripts/lib/worktree-guards.sh"

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

apply_dev_launch_env_if_present() {
  local dev_env_file="$ROOT/.dev-launch.env"
  if [[ ! -f "$dev_env_file" ]]; then
    return 0
  fi

  local lane_state_dir=""
  local lane_config_path=""
  local lane_gateway_port=""
  lane_state_dir="$(read_last_env_value "$dev_env_file" "OPENCLAW_STATE_DIR")"
  lane_config_path="$(read_last_env_value "$dev_env_file" "OPENCLAW_CONFIG_PATH")"
  lane_gateway_port="$(read_last_env_value "$dev_env_file" "OPENCLAW_GATEWAY_PORT")"

  if [[ -n "$lane_state_dir" ]]; then
    export OPENCLAW_STATE_DIR="$lane_state_dir"
  fi
  if [[ -n "$lane_config_path" ]]; then
    export OPENCLAW_CONFIG_PATH="$lane_config_path"
  fi
  if [[ -n "$lane_gateway_port" ]]; then
    export OPENCLAW_GATEWAY_PORT="$lane_gateway_port"
  fi
}

has_explicit_runtime_lane_env() {
  [[ -n "${OPENCLAW_STATE_DIR:-}" || -n "${OPENCLAW_CONFIG_PATH:-}" || -n "${OPENCLAW_GATEWAY_PORT:-}" ]]
}

is_telegram_live_runtime_context() {
  local config_path="${OPENCLAW_CONFIG_PATH:-}"
  local state_dir="${OPENCLAW_STATE_DIR:-}"
  [[ "$config_path" == *"/openclaw.telegram-live.json" ]] && return 0
  [[ "$state_dir" == *"/.openclaw/telegram-live-worktrees/"* ]] && return 0
  [[ "$state_dir" == *"/telegram-live-worktrees/"* ]] && return 0
  return 1
}

# Apply the generated lane env before any consumer-instance fallback. Generic
# linked worktrees like Telegram live lanes should restart the runtime they
# booted, not manufacture a consumer instance from the checkout name.
apply_dev_launch_env_if_present

RAW_INSTANCE_ID="${OPENCLAW_CONSUMER_INSTANCE_ID:-}"
if [[ -z "$RAW_INSTANCE_ID" && ! has_explicit_runtime_lane_env ]]; then
  # Keep direct restarts aligned with `scripts/openclaw-local.sh`: a consumer
  # worktree should restart its own lane without requiring extra env exports.
  RAW_INSTANCE_ID="$(consumer_instance_default_id_for_checkout "$ROOT")"
fi

NORMALIZED_INSTANCE_ID="$(consumer_instance_normalize_id "$RAW_INSTANCE_ID")"
if [[ -n "$NORMALIZED_INSTANCE_ID" ]]; then
  consumer_instance_apply_runtime_env "$NORMALIZED_INSTANCE_ID"
fi

LAUNCHD_DOMAIN="gui/${UID}"
LAUNCHD_LABEL="${OPENCLAW_LAUNCHD_LABEL:-ai.openclaw.gateway}"
PLIST="$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
LAUNCHD_TARGET="${LAUNCHD_DOMAIN}/${LAUNCHD_LABEL}"

if [[ -x "$PREFLIGHT" ]]; then
  "$PREFLIGHT" --quiet
fi

# Sacred home clones are runtime anchors. They must stay on their base branch
# and free of tracked implementation edits unless the operator has explicitly
# entered the break-glass hotfix path on that same base branch.
worktree_guard_require_sacred_home_clone_base_branch "$ROOT" "scripts/restart-local-gateway.sh"
worktree_guard_reject_sacred_home_edits "$ROOT" worktree --context "scripts/restart-local-gateway.sh"

is_self_restart_context() {
  # OPENCLAW_RESTART_DETACHED is set when the gateway asks us to restart from
  # inside an active command. LAUNCH_JOB_LABEL/XPC_SERVICE_NAME are set when
  # this script is running under the same launchd job being restarted.
  if [[ "${OPENCLAW_RESTART_DETACHED:-0}" == "1" ]]; then
    return 0
  fi
  if [[ "${LAUNCH_JOB_LABEL:-}" == "$LAUNCHD_LABEL" ]]; then
    return 0
  fi
  if [[ "${XPC_SERVICE_NAME:-}" == "$LAUNCHD_LABEL" ]]; then
    return 0
  fi
  return 1
}

schedule_detached_restart() {
  local helper_script
  helper_script="$(mktemp "${TMPDIR:-/tmp}/openclaw-restart-detached.XXXXXX.sh")"
  cat >"$helper_script" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

LAUNCHD_TARGET="$1"
LAUNCHD_DOMAIN="$2"
PLIST="$3"
DELAY_SECONDS="$4"
HELPER_SCRIPT="$0"

sleep "$DELAY_SECONDS"
launchctl bootout "$LAUNCHD_TARGET" >/dev/null 2>&1 || true
launchctl bootstrap "$LAUNCHD_DOMAIN" "$PLIST" >/dev/null
launchctl kickstart -k "$LAUNCHD_TARGET" >/dev/null
rm -f "$HELPER_SCRIPT"
EOF
  chmod 700 "$helper_script"
  nohup "$helper_script" "$LAUNCHD_TARGET" "$LAUNCHD_DOMAIN" "$PLIST" "$DEFERRED_RESTART_DELAY_SECONDS" >"$HELPER_LOG_PATH" 2>&1 </dev/null &
  local helper_pid="$!"
  disown || true
  echo "OK: scheduled detached gateway restart helper (pid ${helper_pid})."
  echo "Helper log: ${HELPER_LOG_PATH}"
}

schedule_detached_telegram_live_restart() {
  local helper_script
  helper_script="$(mktemp "${TMPDIR:-/tmp}/openclaw-telegram-live-restart.XXXXXX.sh")"
  cat >"$helper_script" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

ROOT="$1"
PORT="$2"
DELAY_SECONDS="$3"
HELPER_SCRIPT="$0"

sleep "$DELAY_SECONDS"

if [[ -n "$PORT" ]]; then
  runtime_pid="$(lsof -nP -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | sed -n '1p' || true)"
  if [[ -n "$runtime_pid" ]]; then
    kill "$runtime_pid" >/dev/null 2>&1 || true
    for _ in {1..15}; do
      if ! kill -0 "$runtime_pid" >/dev/null 2>&1; then
        break
      fi
      sleep 1
    done
    kill -9 "$runtime_pid" >/dev/null 2>&1 || true
  fi
fi

cd "$ROOT"
bash scripts/telegram-live-runtime.sh ensure
rm -f "$HELPER_SCRIPT"
EOF
  chmod 700 "$helper_script"
  nohup "$helper_script" "$ROOT" "${OPENCLAW_GATEWAY_PORT:-}" "$DEFERRED_RESTART_DELAY_SECONDS" \
    >"$HELPER_LOG_PATH" 2>&1 </dev/null &
  local helper_pid="$!"
  disown || true
  echo "OK: scheduled detached Telegram live restart helper (pid ${helper_pid})."
  echo "Helper log: ${HELPER_LOG_PATH}"
}

# Reinstall the lane-local service from this worktree entrypoint itself. Using
# the wrapper/legacy daemon alias here leaves room for whichever launch context
# invoked the script to influence the resolved service target, which is how a
# consumer lane keeps the right label but drifts onto the wrong port/state.
# Installing from dist/index.js with the instance-derived env above gives
# launchd one unambiguous source of truth for this lane.
launchctl bootout "$LAUNCHD_TARGET" >/dev/null 2>&1 || true
INSTALL_PORT_ARGS=()
if [[ -n "${OPENCLAW_GATEWAY_PORT:-}" ]]; then
  INSTALL_PORT_ARGS=(--port "$OPENCLAW_GATEWAY_PORT")
fi
"$NODE" "$EXPECTED_ENTRY" gateway install --force --allow-shared-service-takeover --runtime node "${INSTALL_PORT_ARGS[@]}" >/dev/null

if is_telegram_live_runtime_context; then
  schedule_detached_telegram_live_restart
  exit 0
fi

if is_self_restart_context; then
  schedule_detached_restart
  exit 0
fi

# Restart deterministically via launchctl so we don't depend on whichever global
# openclaw binary might be active in PATH.
launchctl bootout "$LAUNCHD_TARGET" >/dev/null 2>&1 || true
launchctl bootstrap "$LAUNCHD_DOMAIN" "$PLIST" >/dev/null
launchctl kickstart -k "$LAUNCHD_TARGET" >/dev/null

STATUS=""
for _ in {1..20}; do
  # `gateway status` now exits non-zero on lane drift, which is exactly what we
  # want after the final restart. During the warm-up loop we still want the text
  # output so we can wait for the listener to settle instead of bailing early.
  STATUS="$("$NODE" "$CLI" gateway status --deep 2>&1 || true)"
  if printf '%s\n' "$STATUS" | grep -Fq "RPC probe: ok"; then
    break
  fi
  sleep 1
done

printf '%s\n' "$STATUS"

if ! launchctl print "$LAUNCHD_TARGET" >/dev/null 2>&1; then
  echo "ERROR: launchd service $LAUNCHD_TARGET is not loaded." >&2
  exit 1
fi

if ! printf '%s\n' "$STATUS" | grep -Fq "$EXPECTED_ENTRY"; then
  echo "ERROR: gateway is not pinned to local fork entry: $EXPECTED_ENTRY" >&2
  exit 1
fi

if ! printf '%s\n' "$STATUS" | grep -Fq "RPC probe: ok"; then
  echo "ERROR: gateway did not become healthy (RPC probe not ok)." >&2
  exit 1
fi

STATUS_JSON="$("$NODE" "$CLI" gateway status --deep --json)"
STATUS_JSON="$STATUS_JSON" \
EXPECTED_ENTRY="$EXPECTED_ENTRY" \
EXPECTED_PORT="${OPENCLAW_GATEWAY_PORT:-}" \
EXPECTED_STATE_DIR="${OPENCLAW_STATE_DIR:-}" \
EXPECTED_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-}" \
node <<'EOF'
const status = JSON.parse(process.env.STATUS_JSON ?? "{}");
const expectedEntry = process.env.EXPECTED_ENTRY ?? "";
const expectedPortRaw = process.env.EXPECTED_PORT ?? "";
const expectedStateDir = process.env.EXPECTED_STATE_DIR ?? "";
const expectedConfigPath = process.env.EXPECTED_CONFIG_PATH ?? "";
const expectedPort = expectedPortRaw ? Number(expectedPortRaw) : null;
const args = status?.service?.command?.programArguments;
const env = status?.service?.command?.environment ?? {};

if (!Array.isArray(args) || !args.includes(expectedEntry)) {
  console.error(`ERROR: gateway is not pinned to local fork entry: ${expectedEntry}`);
  process.exit(1);
}

if (expectedPort !== null && status?.gateway?.port !== expectedPort) {
  console.error(
    `ERROR: gateway service port mismatch after restart (expected ${expectedPort}, got ${status?.gateway?.port ?? "unknown"}).`,
  );
  process.exit(1);
}

if (
  expectedPort !== null &&
  Number(env.OPENCLAW_GATEWAY_PORT ?? "0") !== expectedPort
) {
  console.error(
    `ERROR: launchd environment drifted after restart (expected OPENCLAW_GATEWAY_PORT=${expectedPort}, got ${env.OPENCLAW_GATEWAY_PORT ?? "unset"}).`,
  );
  process.exit(1);
}

if (status?.portMismatch) {
  console.error(
    `ERROR: status still reports a lane-local port mismatch (service ${status.portMismatch.servicePort}, expected ${status.portMismatch.expectedPort}).`,
  );
  process.exit(1);
}

if (expectedStateDir && env.OPENCLAW_STATE_DIR !== expectedStateDir) {
  console.error(
    `ERROR: launchd state dir drifted after restart (expected ${expectedStateDir}, got ${env.OPENCLAW_STATE_DIR ?? "unset"}).`,
  );
  process.exit(1);
}

if (expectedConfigPath && env.OPENCLAW_CONFIG_PATH !== expectedConfigPath) {
  console.error(
    `ERROR: launchd config path drifted after restart (expected ${expectedConfigPath}, got ${env.OPENCLAW_CONFIG_PATH ?? "unset"}).`,
  );
  process.exit(1);
}
EOF

echo "OK: gateway pinned to local fork entry."
