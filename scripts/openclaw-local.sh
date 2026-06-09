#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
source "$ROOT/scripts/lib/validated-node.sh"
openclaw_use_validated_node "$ROOT" >/dev/null
NODE="$OPENCLAW_NODE_BIN"
CLI="$ROOT/openclaw.mjs"
PREFLIGHT="$ROOT/scripts/local-runtime-preflight.sh"
LOCAL_RESTART="$ROOT/scripts/restart-local-gateway.sh"
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

has_explicit_runtime_selector() {
  [[ -n "${OPENCLAW_CONSUMER_INSTANCE_ID:-}" ]] || \
    [[ -n "${OPENCLAW_HOME:-}" ]] || \
    [[ -n "${OPENCLAW_LAUNCHD_LABEL:-}" ]] || \
    [[ -n "${OPENCLAW_PROFILE:-}" ]] || \
    [[ -n "${OPENCLAW_STATE_DIR:-}" ]] || \
    [[ -n "${OPENCLAW_CONFIG_PATH:-}" ]] || \
    [[ -n "${OPENCLAW_GATEWAY_PORT:-}" ]]
}

is_gateway_restart_command() {
  if [[ $# -eq 1 && "$1" == "restart" ]]; then
    return 0
  fi
  if [[ $# -eq 2 ]]; then
    case "$1:$2" in
      gateway:restart|daemon:restart)
        return 0
        ;;
    esac
  fi
  return 1
}

is_telegram_user_command() {
  [[ $# -ge 1 && "$1" == "telegram-user" ]]
}

ensure_telegram_user_lane_assets() {
  local env_file="$ROOT/scripts/telegram-e2e/.env.local"
  local session_file="$ROOT/scripts/telegram-e2e/tmp/userbot.session"
  local bootstrap_script="$ROOT/scripts/bootstrap-worktree-telegram.sh"
  local api_id=""
  local api_hash=""

  if [[ ! -f "$bootstrap_script" ]]; then
    return 0
  fi

  if [[ -f "$env_file" ]]; then
    api_id="$(read_last_env_value "$env_file" "TELEGRAM_API_ID")"
    api_hash="$(read_last_env_value "$env_file" "TELEGRAM_API_HASH")"
  fi

  # Ad-hoc worktrees can bypass scripts/new-worktree.sh and land without the
  # userbot env/session that telegram-user depends on. Self-heal that lane-local
  # bootstrap here so read-only transcript/debug commands do not fail on a
  # missing copy step.
  if [[ -n "$api_id" && -n "$api_hash" && -f "$session_file" ]]; then
    return 0
  fi

  bash "$bootstrap_script" --strict >/dev/null
}

if [[ -x "$PREFLIGHT" ]]; then
  "$PREFLIGHT" --quiet
fi

# Sacred home clones are runtime anchors. They must stay on their base branch
# and free of tracked implementation edits unless the operator has explicitly
# entered the break-glass hotfix path on that same base branch.
worktree_guard_require_sacred_home_clone_base_branch "$ROOT" "scripts/openclaw-local.sh"
worktree_guard_reject_sacred_home_edits "$ROOT" worktree --context "scripts/openclaw-local.sh"

# Short local CLI commands are an easy place to accidentally mutate the shared
# runtime from a manually-created worktree. Require the generated dev launch env
# before we let linked worktrees talk to the local runtime wrapper at all.
worktree_guard_run_for_linked_checkout \
  "$ROOT" \
  --mode generic \
  --require-dev-launch-env \
  --require-node-modules \
  --quiet

DEV_ENV_FILE="$ROOT/.dev-launch.env"
lane_state_dir=""
lane_config_path=""
lane_gateway_port=""
DEFAULT_SHARED_MAIN_CONTEXT=0
if [[ -f "$DEV_ENV_FILE" ]]; then
  # Linked worktree operator commands must use the lane's generated baseline,
  # not silently drift back to ~/.openclaw because the shell lacked explicit env.
  lane_state_dir="$(read_last_env_value "$DEV_ENV_FILE" "OPENCLAW_STATE_DIR")"
  lane_config_path="$(read_last_env_value "$DEV_ENV_FILE" "OPENCLAW_CONFIG_PATH")"
  lane_gateway_port="$(read_last_env_value "$DEV_ENV_FILE" "OPENCLAW_GATEWAY_PORT")"

  # A generated lane baseline is authoritative for isolated runtimes such as
  # Telegram live worktrees. If we infer a consumer instance first, the checkout
  # name hijacks restart/status onto ~/Library/Application Support/OpenClaw
  # Consumer/... instead of the lane that is actually running.
  if [[ -n "$lane_state_dir" ]]; then
    export OPENCLAW_STATE_DIR="$lane_state_dir"
  fi
  if [[ -n "$lane_config_path" ]]; then
    export OPENCLAW_CONFIG_PATH="$lane_config_path"
  fi
  if [[ -n "$lane_gateway_port" ]]; then
    export OPENCLAW_GATEWAY_PORT="$lane_gateway_port"
  fi
fi

if [[ -z "$lane_state_dir" && -z "$lane_config_path" && -z "$lane_gateway_port" ]] && \
  ! has_explicit_runtime_selector && \
  [[ "$(worktree_guard_sacred_home_clone_role "$ROOT" 2>/dev/null || true)" == "main" ]]; then
  # The default shared macOS gateway is app-owned even when it runs code from
  # the sacred main checkout. Keep `pnpm openclaw:local config ...` and status
  # probes pointed at the same config root as the LaunchAgent so smoke setup
  # cannot silently edit ~/.openclaw while the live bot reads Application
  # Support/OpenClaw.
  export OPENCLAW_HOME="$HOME/Library/Application Support/OpenClaw"
  export OPENCLAW_STATE_DIR="$OPENCLAW_HOME/.openclaw"
  export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"
  DEFAULT_SHARED_MAIN_CONTEXT=1
fi

RAW_INSTANCE_ID="${OPENCLAW_CONSUMER_INSTANCE_ID:-}"
if [[ -z "$RAW_INSTANCE_ID" && -z "$lane_state_dir" && -z "$lane_config_path" && -z "$lane_gateway_port" ]]; then
  # Consumer worktrees should behave like consumer lanes by default. Requiring
  # every manual `pnpm openclaw:local ...` call to export an instance id first
  # is exactly how auth/status commands drift back to ~/.openclaw.
  RAW_INSTANCE_ID="$(consumer_instance_default_id_for_checkout "$ROOT")"
fi

NORMALIZED_INSTANCE_ID="$(consumer_instance_normalize_id "$RAW_INSTANCE_ID")"
if [[ -n "$NORMALIZED_INSTANCE_ID" ]]; then
  consumer_instance_apply_runtime_env "$NORMALIZED_INSTANCE_ID"
fi

if [[ -x "$LOCAL_RESTART" ]]; then
  export OPENCLAW_LOCAL_RESTART_SCRIPT="${OPENCLAW_LOCAL_RESTART_SCRIPT:-$LOCAL_RESTART}"
fi

if is_telegram_user_command "$@"; then
  ensure_telegram_user_lane_assets
fi

# Hard-pin lane restart commands to the local fork service script, but never
# intercept the canonical shared-main restart. That path belongs to the real CLI
# service lifecycle so it can use launchd/recovery guards instead of recursing
# into scripts/restart-local-gateway.sh, whose job is to refuse ai.openclaw.gateway.
if [[ "${OPENCLAW_USE_LOCAL_RESTART_SCRIPT:-1}" != "0" && \
  "$DEFAULT_SHARED_MAIN_CONTEXT" != "1" && \
  -x "$LOCAL_RESTART" ]] && \
  is_gateway_restart_command "$@"; then
  exec "$LOCAL_RESTART"
fi

exec "$NODE" "$CLI" "$@"
