#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
NODE="${OPENCLAW_NODE_BIN:-$(command -v node)}"
CLI="$ROOT/openclaw.mjs"
PREFLIGHT="$ROOT/scripts/local-runtime-preflight.sh"
LOCAL_RESTART="$ROOT/scripts/restart-local-gateway.sh"
source "$ROOT/scripts/lib/consumer-instance.sh"
source "$ROOT/scripts/lib/worktree-guards.sh"

if [[ ! -x "$NODE" ]]; then
  echo "ERROR: node runtime not found. Install Node 22+ or set OPENCLAW_NODE_BIN." >&2
  exit 1
fi

if [[ -x "$PREFLIGHT" ]]; then
  "$PREFLIGHT" --quiet
fi

# The canonical shared checkout powers the long-lived local Jarvis gateway.
# Refuse to run it from a feature/consumer branch so checkout drift cannot
# silently repoint the shared bot at the wrong code.
worktree_guard_require_shared_root_main_branch "$ROOT"
worktree_guard_reject_shared_root_main_edits \
  "$ROOT" \
  worktree \
  --context "scripts/openclaw-local.sh"

RAW_INSTANCE_ID="${OPENCLAW_CONSUMER_INSTANCE_ID:-}"
if [[ -z "$RAW_INSTANCE_ID" ]]; then
  # Consumer worktrees should behave like consumer lanes by default. Requiring
  # every manual `pnpm openclaw:local ...` call to export an instance id first
  # is exactly how auth/status commands drift back to ~/.openclaw.
  RAW_INSTANCE_ID="$(consumer_instance_default_id_for_checkout "$ROOT")"
fi

NORMALIZED_INSTANCE_ID="$(consumer_instance_normalize_id "$RAW_INSTANCE_ID")"
if [[ -n "$NORMALIZED_INSTANCE_ID" ]]; then
  consumer_instance_apply_runtime_env "$NORMALIZED_INSTANCE_ID"
fi

# Short local CLI commands are an easy place to accidentally mutate the shared
# runtime from a manually-created worktree. Require the generated dev launch env
# before we let linked worktrees talk to the local runtime wrapper at all.
worktree_guard_run_for_linked_checkout \
  "$ROOT" \
  --mode generic \
  --require-dev-launch-env \
  --require-node-modules \
  --quiet

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
