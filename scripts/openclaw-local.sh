#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
NODE="${OPENCLAW_NODE_BIN:-$(command -v node)}"
CLI="$ROOT/openclaw.mjs"
PREFLIGHT="$ROOT/scripts/local-runtime-preflight.sh"
LOCAL_RESTART="$ROOT/scripts/restart-local-gateway.sh"
source "$ROOT/scripts/lib/consumer-instance.sh"

if [[ ! -x "$NODE" ]]; then
  echo "ERROR: node runtime not found. Install Node 22+ or set OPENCLAW_NODE_BIN." >&2
  exit 1
fi

if [[ -x "$PREFLIGHT" ]]; then
  "$PREFLIGHT" --quiet
fi

if [[ -n "${OPENCLAW_CONSUMER_INSTANCE_ID:-}" ]]; then
  normalized_instance_id="$(consumer_instance_normalize_id "$OPENCLAW_CONSUMER_INSTANCE_ID")"
  if [[ -n "$normalized_instance_id" ]]; then
    # Short local-CLI commands should respect the active consumer lane when the
    # caller provides an instance id. Without this, re-auth/status commands
    # quietly fall back to ~/.openclaw and mutate the wrong runtime.
    export OPENCLAW_PROFILE="${OPENCLAW_PROFILE:-$(consumer_instance_profile "$normalized_instance_id")}"
    export OPENCLAW_HOME="${OPENCLAW_HOME:-$(consumer_instance_state_dir "$normalized_instance_id")}"
    export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$(consumer_instance_state_dir "$normalized_instance_id")}"
    export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$(consumer_instance_config_path "$normalized_instance_id")}"
    export OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-$(consumer_instance_gateway_port "$normalized_instance_id")}"
    export OPENCLAW_GATEWAY_BIND="${OPENCLAW_GATEWAY_BIND:-loopback}"
    export OPENCLAW_LOG_DIR="${OPENCLAW_LOG_DIR:-$(consumer_instance_state_dir "$normalized_instance_id")/logs}"
    export OPENCLAW_LAUNCHD_LABEL="${OPENCLAW_LAUNCHD_LABEL:-$(consumer_instance_gateway_launchd_label "$normalized_instance_id")}"
  fi
fi

if [[ -x "$LOCAL_RESTART" ]]; then
  export OPENCLAW_LOCAL_RESTART_SCRIPT="${OPENCLAW_LOCAL_RESTART_SCRIPT:-$LOCAL_RESTART}"
fi

# Hard-pin restart commands to the local fork service script.
if [[ "${OPENCLAW_USE_LOCAL_RESTART_SCRIPT:-1}" != "0" && -x "$LOCAL_RESTART" ]]; then
  if [[ $# -eq 1 && "$1" == "restart" ]]; then
    exec "$LOCAL_RESTART"
  fi
  if [[ $# -eq 2 ]]; then
    case "$1:$2" in
      gateway:restart|daemon:restart)
        exec "$LOCAL_RESTART"
        ;;
    esac
  fi
fi

exec "$NODE" "$CLI" "$@"
