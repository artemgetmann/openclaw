#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/consumer-instance.sh"
source "$ROOT_DIR/scripts/lib/worktree-guards.sh"
source "$ROOT_DIR/scripts/lib/gateway-launchagent-guard.sh"
source "$ROOT_DIR/scripts/lib/macos-activation.sh"

INSTANCE_ID="${OPENCLAW_CONSUMER_INSTANCE_ID:-}"
APP_PATH=""
REPLACE=0
REFRESH_GATEWAY="${OPENCLAW_CONSUMER_REFRESH_GATEWAY:-0}"

usage() {
  cat <<'EOF'
Usage: scripts/open-consumer-mac-app.sh [--instance <id>] [--replace] [--refresh-gateway] [app_path]
Set OPENCLAW_CONSUMER_STABLE_TCC_IDENTITY=1 when opening an isolated runtime
lane that was packaged with the stable consumer debug app identity.

By default this only opens the app. Use --refresh-gateway when the caller
intentionally wants to reinstall a per-instance gateway LaunchAgent from this
source checkout.

Default Jarvis runtime warning:
  --refresh-gateway on the empty/default instance would install ai.jarvis.gateway
  from the current source checkout. That is not app-managed bundled runtime
  proof. Use scripts/prove-jarvis-runtime.sh for read-only bundled proof, or
  pass --instance <id> for isolated source-checkout debug lanes.
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

bootout_conflicting_gateway_label() {
  # This helper is advisory cleanup for stale launchd labels, not a required
  # gate. It delegates the default-gateway invariant to a shared guard so named
  # consumer lanes cannot accidentally unload the main Jarvis gateway.
  openclaw_bootout_conflicting_gateway_label "$@"
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

require_refresh_gateway_scope_is_explicit() {
  local normalized="${1:-}"

  if [[ "$REFRESH_GATEWAY" != "1" ]]; then
    return
  fi

  if [[ -n "$normalized" ]]; then
    return
  fi

  # The default instance is the real Jarvis app-support runtime. Reinstalling
  # its gateway through `pnpm openclaw:local` makes launchd run this checkout,
  # which is fine for an intentional emergency debug session but invalid for
  # any claim that runtime_source=jarvis-managed-bundle. Force the operator to
  # name that provenance change instead of hiding it behind a generic relaunch.
  if [[ "${OPENCLAW_ALLOW_SOURCE_CHECKOUT_JARVIS_REFRESH:-0}" == "1" ]]; then
    echo "WARNING: --refresh-gateway is reinstalling the default Jarvis gateway from source checkout: $ROOT_DIR" >&2
    echo "WARNING: do not claim runtime_source=jarvis-managed-bundle after this; prove actual runtime provenance first." >&2
    return
  fi

  echo "ERROR: refusing --refresh-gateway for the default Jarvis runtime." >&2
  echo "  It would install ai.jarvis.gateway from this source checkout:" >&2
  echo "  $ROOT_DIR" >&2
  echo "  That is not jarvis-managed-bundle proof." >&2
  echo "" >&2
  echo "Use one of these explicit paths instead:" >&2
  echo "  - Read-only managed-bundle proof: bash scripts/prove-jarvis-runtime.sh --expected-commit <sha>" >&2
  echo "  - Isolated source-checkout debug lane: scripts/open-consumer-mac-app.sh --instance <id> --refresh-gateway" >&2
  echo "  - Break-glass source-checkout default refresh: OPENCLAW_ALLOW_SOURCE_CHECKOUT_JARVIS_REFRESH=1 ..." >&2
  exit 1
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
    --refresh-gateway)
      REFRESH_GATEWAY=1
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
require_refresh_gateway_scope_is_explicit "$NORMALIZED_INSTANCE_ID"
if [[ -z "$NORMALIZED_INSTANCE_ID" && -z "$APP_PATH" ]]; then
  if ! consumer_instance_default_checkout_allowed "$ROOT_DIR"; then
    echo "ERROR: default Jarvis app launch is reserved for the sacred home clone." >&2
    consumer_instance_default_checkout_hint >&2
    echo "Current checkout: $ROOT_DIR" >&2
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

if [[ "$REFRESH_GATEWAY" == "1" ]]; then
  # Some rebuild/smoke flows intentionally refresh the isolated gateway after
  # app bootstrap so shell-only env vars land in launchd. Plain "open app"
  # should not mutate persistent gateway jobs every time.
  refresh_gateway_service_env "$NORMALIZED_INSTANCE_ID"
fi

openclaw_activate_macos_app "$APP_PATH" "$actual_bundle_id"

echo "Opened consumer app:"
echo "  path=$APP_PATH"
echo "  display_name=$actual_name"
echo "  bundle_id=$actual_bundle_id"
echo "  variant=$actual_variant"
echo "  instance_id=${NORMALIZED_INSTANCE_ID:-default}"
