#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/consumer-instance.sh"
source "$ROOT_DIR/scripts/lib/worktree-guards.sh"

INSTANCE_ID="${OPENCLAW_CONSUMER_INSTANCE_ID:-}"
APP_PATH=""
REPLACE=0

usage() {
  cat <<'EOF'
Usage: scripts/open-consumer-mac-app.sh [--instance <id>] [--replace] [app_path]
Set OPENCLAW_CONSUMER_STABLE_TCC_IDENTITY=1 when opening an isolated runtime
lane that was packaged with the stable consumer debug app identity.
EOF
}

terminate_matching_app_binary() {
  local binary_path="$1"
  local pids=()
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    pids+=("$pid")
  done < <(/bin/ps -axo pid=,command= | /usr/bin/awk -v target="$binary_path" 'index($0, target) > 0 { print $1 }')

  if [[ "${#pids[@]}" -eq 0 ]]; then
    return
  fi

  /bin/kill "${pids[@]}" 2>/dev/null || true
}

plist_value() {
  local plist_path="$1"
  local key_path="$2"
  /usr/libexec/PlistBuddy -c "Print :${key_path}" "$plist_path" 2>/dev/null || true
}

bootout_conflicting_gateway_label() {
  local label="$1"
  local target_label="$2"
  local target_state_dir="$3"
  local target_config_path="$4"
  local target_port="$5"

  [[ "$label" == "$target_label" ]] && return

  local plist_path="$HOME/Library/LaunchAgents/${label}.plist"
  [[ -f "$plist_path" ]] || return

  local existing_state_dir
  local existing_config_path
  local existing_port=""
  local index=0
  local arg=""

  existing_state_dir="$(plist_value "$plist_path" 'EnvironmentVariables:OPENCLAW_STATE_DIR')"
  existing_config_path="$(plist_value "$plist_path" 'EnvironmentVariables:OPENCLAW_CONFIG_PATH')"

  while true; do
    arg="$(plist_value "$plist_path" "ProgramArguments:${index}")"
    [[ -n "$arg" ]] || break
    if [[ "$arg" == "--port" ]]; then
      existing_port="$(plist_value "$plist_path" "ProgramArguments:$((index + 1))")"
      break
    fi
    if [[ "$arg" == --port=* ]]; then
      existing_port="${arg#--port=}"
      break
    fi
    index=$((index + 1))
  done

  if [[ "$existing_state_dir" != "$target_state_dir" && "$existing_config_path" != "$target_config_path" && "$existing_port" != "$target_port" ]]; then
    return
  fi

  /bin/launchctl bootout "gui/$(id -u)/${label}" >/dev/null 2>&1 || true
  /bin/launchctl unload "$plist_path" >/dev/null 2>&1 || true
}

refresh_gateway_service_env() {
  local normalized="${1:-}"
  local state_dir
  local config_path
  local gateway_port
  local profile
  local launchd_label

  state_dir="$(consumer_instance_state_dir "$normalized")"
  config_path="$state_dir/openclaw.json"
  gateway_port="$(consumer_instance_gateway_port "$normalized")"
  profile="$(consumer_instance_profile "$normalized")"
  launchd_label="$(consumer_instance_gateway_launchd_label "$normalized")"

  # The app process launched through `open -n` does not reliably inherit arbitrary shell env.
  # Reinstall the dedicated gateway lane from this shell once bootstrap has written the instance
  # config so allowlisted skill env vars land in the supervised runtime for that instance.
  local attempt
  for attempt in {1..20}; do
    if [[ -f "$config_path" ]]; then
      bootout_conflicting_gateway_label "ai.openclaw.gateway" "$launchd_label" "$state_dir" "$config_path" "$gateway_port"
      bootout_conflicting_gateway_label "ai.openclaw.consumer.gateway" "$launchd_label" "$state_dir" "$config_path" "$gateway_port"
      OPENCLAW_STATE_DIR="$state_dir" \
        OPENCLAW_CONFIG_PATH="$config_path" \
        OPENCLAW_PROFILE="$profile" \
        OPENCLAW_LAUNCHD_LABEL="$launchd_label" \
        pnpm --dir "$ROOT_DIR" openclaw:local gateway install --force --port "$gateway_port" --runtime node >/dev/null
      return
    fi
    /bin/sleep 0.25
  done
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --instance requires a value" >&2
        exit 1
      fi
      INSTANCE_ID="$2"
      shift 2
      ;;
    --replace)
      REPLACE=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      if [[ -n "$APP_PATH" ]]; then
        echo "ERROR: unexpected extra argument: $1" >&2
        usage >&2
        exit 1
      fi
      APP_PATH="$1"
      shift
      ;;
  esac
done

if [[ -z "$INSTANCE_ID" ]]; then
  # Match packaging defaults so a linked worktree opens its own isolated
  # consumer instance unless the caller explicitly opts into another lane.
  INSTANCE_ID="$(consumer_instance_default_id_for_checkout "$ROOT_DIR")"
fi

NORMALIZED_INSTANCE_ID="$(consumer_instance_normalize_id "$INSTANCE_ID")"
if [[ -z "$NORMALIZED_INSTANCE_ID" && -z "$APP_PATH" ]]; then
  CURRENT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  CANONICAL_CONSUMER_CHECKOUT="/Users/user/Programming_Projects/openclaw-consumer-openclaw-project"
  if [[ "$CURRENT_ROOT" != "$CANONICAL_CONSUMER_CHECKOUT" ]]; then
    echo "ERROR: default consumer app launch is reserved for the main consumer checkout." >&2
    echo "Use --instance <id> from worktrees so you do not collide with the shared consumer runtime." >&2
    echo "Expected checkout: $CANONICAL_CONSUMER_CHECKOUT" >&2
    echo "Current checkout: ${CURRENT_ROOT:-unknown}" >&2
    exit 1
  fi
fi
# Treat GUI launches from linked worktrees the same way as shell launches:
# require the generated isolation env first so a manually-added checkout cannot
# quietly wake the shared consumer runtime.
worktree_guard_run_for_linked_checkout \
  "$ROOT_DIR" \
  --mode generic \
  --require-dev-launch-env \
  --quiet

# Opening the packaged app from a worktree should use the same isolation checks
# as the shell launch path; otherwise GUI QA can silently wake the wrong lane.
worktree_guard_run_doctor \
  "$ROOT_DIR" \
  --mode open-consumer \
  --instance "$NORMALIZED_INSTANCE_ID" \
  --telegram-mode skip \
  --quiet
EXPECTED_NAME="$(consumer_instance_display_name "$NORMALIZED_INSTANCE_ID")"
EXPECTED_BUNDLE_ID="$(consumer_instance_bundle_id "$NORMALIZED_INSTANCE_ID")"
EXPECTED_VARIANT="consumer"

if [[ -z "$APP_PATH" ]]; then
  APP_PATH="$(consumer_instance_app_path "$ROOT_DIR" "$NORMALIZED_INSTANCE_ID")"
fi

INFO_PLIST="$APP_PATH/Contents/Info.plist"
if [[ ! -f "$INFO_PLIST" ]]; then
  echo "ERROR: consumer app bundle not found: $APP_PATH" >&2
  echo "Run scripts/package-consumer-mac-app.sh${NORMALIZED_INSTANCE_ID:+ --instance ${NORMALIZED_INSTANCE_ID}} first." >&2
  exit 1
fi

actual_name=$(/usr/libexec/PlistBuddy -c "Print :CFBundleDisplayName" "$INFO_PLIST")
actual_bundle_id=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$INFO_PLIST")
actual_variant=$(/usr/libexec/PlistBuddy -c "Print :OpenClawAppVariant" "$INFO_PLIST")
actual_instance_id=$(/usr/libexec/PlistBuddy -c "Print :OpenClawConsumerInstanceID" "$INFO_PLIST" 2>/dev/null || true)

if [[ "$actual_name" != "$EXPECTED_NAME" || "$actual_bundle_id" != "$EXPECTED_BUNDLE_ID" || "$actual_variant" != "$EXPECTED_VARIANT" || "$actual_instance_id" != "${NORMALIZED_INSTANCE_ID}" ]]; then
  echo "ERROR: refusing to open unexpected consumer bundle." >&2
  echo "  path=$APP_PATH" >&2
  echo "  display_name=$actual_name" >&2
  echo "  bundle_id=$actual_bundle_id" >&2
  echo "  variant=$actual_variant" >&2
  echo "  instance_id=$actual_instance_id" >&2
  echo "Expected:" >&2
  echo "  display_name=$EXPECTED_NAME" >&2
  echo "  bundle_id=$EXPECTED_BUNDLE_ID" >&2
  echo "  variant=$EXPECTED_VARIANT" >&2
  echo "  instance_id=${NORMALIZED_INSTANCE_ID:-}" >&2
  exit 1
fi

if [[ "$REPLACE" == "1" ]]; then
  terminate_matching_app_binary "$APP_PATH/Contents/MacOS/OpenClaw"
fi

if [[ -n "$NORMALIZED_INSTANCE_ID" ]]; then
  env -i \
    HOME="${HOME}" \
    USER="${USER:-$(id -un)}" \
    LOGNAME="${LOGNAME:-$(id -un)}" \
    TMPDIR="${TMPDIR:-/tmp}" \
    PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
    LANG="${LANG:-en_US.UTF-8}" \
    GOOGLE_PLACES_API_KEY="${GOOGLE_PLACES_API_KEY:-}" \
    HIMALAYA_CONFIG="${HIMALAYA_CONFIG:-}" \
    OPENCLAW_CONSUMER_INSTANCE_ID="$NORMALIZED_INSTANCE_ID" \
    /usr/bin/open -n "$APP_PATH"
else
  env -i \
    HOME="${HOME}" \
    USER="${USER:-$(id -un)}" \
    LOGNAME="${LOGNAME:-$(id -un)}" \
    TMPDIR="${TMPDIR:-/tmp}" \
    PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
    LANG="${LANG:-en_US.UTF-8}" \
    GOOGLE_PLACES_API_KEY="${GOOGLE_PLACES_API_KEY:-}" \
    HIMALAYA_CONFIG="${HIMALAYA_CONFIG:-}" \
    /usr/bin/open -n "$APP_PATH"
fi

# Consumer builds are menu bar apps (`LSUIElement=true`), so plain `open` can
# leave the right instance running without surfacing its window. Reopen+activate
# the exact bundle id so "open the app" actually brings the intended lane
# forward instead of a random existing consumer variant.
refresh_gateway_service_env "$NORMALIZED_INSTANCE_ID"

/usr/bin/osascript <<EOF >/dev/null 2>&1 || true
tell application id "$actual_bundle_id"
  reopen
  activate
end tell
EOF

echo "Opened consumer app:"
echo "  path=$APP_PATH"
echo "  display_name=$actual_name"
echo "  bundle_id=$actual_bundle_id"
echo "  variant=$actual_variant"
echo "  instance_id=${NORMALIZED_INSTANCE_ID:-default}"
