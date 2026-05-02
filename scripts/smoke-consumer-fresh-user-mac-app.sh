#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT_DMG="/Users/user/Programming_Projects/openclaw/OpenClaw Consumer.dmg"

APP_PATH=""
DMG_PATH=""
KEEP_ARTIFACTS=0
TIMEOUT_SECONDS=90
INSTANCE_ID="fresh-user-smoke-$(date +%Y%m%d%H%M%S)-$$"
QUIT_EXISTING_APP=0

usage() {
  cat <<'EOF'
Usage: scripts/smoke-consumer-fresh-user-mac-app.sh [--dmg <path> | --app <path>] [--timeout <seconds>] [--keep-artifacts] [--quit-existing-app]

Runs the packaged OpenClaw Consumer macOS app against an isolated fake home and
instance id. This is the closest non-admin fresh-user smoke: it avoids the real
user's OpenClaw config/runtime while proving bundled runtime bootstrap, isolated
gateway startup, and first-run onboarding visibility from clean state.

By default the script refuses to run while another OpenClaw Consumer app with the
same bundle id is already open. Pass --quit-existing-app only when this smoke is
allowed to close that app first.

The script never prints secrets or dumps config contents.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)
      APP_PATH="${2:-}"
      shift 2
      ;;
    --dmg)
      DMG_PATH="${2:-}"
      shift 2
      ;;
    --timeout)
      TIMEOUT_SECONDS="${2:-}"
      shift 2
      ;;
    --keep-artifacts)
      KEEP_ARTIFACTS=1
      shift
      ;;
    --quit-existing-app)
      QUIT_EXISTING_APP=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -n "$APP_PATH" && -n "$DMG_PATH" ]]; then
  echo "ERROR: pass either --app or --dmg, not both" >&2
  exit 1
fi

if [[ -z "$APP_PATH" && -z "$DMG_PATH" ]]; then
  if [[ -f "$DEFAULT_DMG" ]]; then
    DMG_PATH="$DEFAULT_DMG"
  else
    APP_PATH="$ROOT_DIR/dist/OpenClaw Consumer.app"
  fi
fi

normalize_instance_id() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/-+/-/g; s/^-//; s/-$//'
}

gateway_port_for_instance() {
  node - "$1" <<'NODE'
const id = process.argv[2] ?? "";
let hash = 0x811c9dc5;
for (const byte of Buffer.from(id, "utf8")) {
  hash ^= byte;
  hash = Math.imul(hash, 0x01000193) >>> 0;
}
process.stdout.write(String(20000 + (hash % 20000)));
NODE
}

plist_value() {
  local plist_path="$1"
  local key="$2"
  /usr/libexec/PlistBuddy -c "Print :${key}" "$plist_path" 2>/dev/null || true
}

wait_for_file() {
  local path="$1"
  local deadline="$2"
  while (( SECONDS < deadline )); do
    [[ -e "$path" ]] && return 0
    sleep 0.5
  done
  return 1
}

wait_for_health() {
  local port="$1"
  local deadline="$2"
  while (( SECONDS < deadline )); do
    if curl -fsS "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

read_onboarding_windows() {
  # CGWindowList does not require Accessibility permission, unlike System Events.
  swift -e 'import CoreGraphics; let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []; for w in list { let owner = w[kCGWindowOwnerName as String] as? String ?? ""; let name = w[kCGWindowName as String] as? String ?? ""; if owner == "OpenClaw" || owner == "OpenClaw Consumer" || name.contains("OpenClaw") { print(name.isEmpty ? "<untitled>" : name) } }' 2>/dev/null || true
}

running_openclaw_consumer_pids() {
  /bin/ps -axo pid=,command= \
    | /usr/bin/awk '/OpenClaw Consumer\.app\/Contents\/MacOS\/OpenClaw/ { print $1 }'
}

cleanup() {
  local exit_code=$?
  set +e
  if [[ -n "${GATEWAY_LABEL:-}" ]]; then
    /bin/launchctl bootout "gui/$(id -u)/${GATEWAY_LABEL}" >/dev/null 2>&1
  fi
  if [[ -n "${APP_PID:-}" ]]; then
    /bin/kill "$APP_PID" >/dev/null 2>&1
  fi
  if [[ -n "${APP_BINARY:-}" ]]; then
    /usr/bin/pkill -f "$APP_BINARY" >/dev/null 2>&1
  fi
  if [[ -n "${STATE_DIR:-}" ]]; then
    /usr/bin/pkill -f "$STATE_DIR" >/dev/null 2>&1
  fi
  if [[ -n "${MOUNT_DIR:-}" && -d "$MOUNT_DIR" ]]; then
    /usr/bin/hdiutil detach "$MOUNT_DIR" -quiet >/dev/null 2>&1
  fi
  if [[ "${KEEP_ARTIFACTS:-0}" != "1" && -n "${SMOKE_ROOT:-}" && -d "$SMOKE_ROOT" ]]; then
    rm -rf "$SMOKE_ROOT"
  elif [[ -n "${SMOKE_ROOT:-}" && -d "$SMOKE_ROOT" ]]; then
    echo "artifacts=$SMOKE_ROOT"
  fi
  exit "$exit_code"
}
trap cleanup EXIT

if ! sudo -n true >/dev/null 2>&1; then
  echo "true_fresh_macos_user=blocked_noninteractive_sudo"
fi

NORMALIZED_INSTANCE_ID="$(normalize_instance_id "$INSTANCE_ID")"
GATEWAY_PORT="$(gateway_port_for_instance "$NORMALIZED_INSTANCE_ID")"
GATEWAY_LABEL="ai.openclaw.consumer.${NORMALIZED_INSTANCE_ID}.gateway"

SMOKE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-consumer-fresh-smoke.XXXXXX")"
FRESH_HOME="$SMOKE_ROOT/home"
INSTALL_DIR="$SMOKE_ROOT/install"
MOUNT_DIR="$SMOKE_ROOT/dmg"
mkdir -p "$FRESH_HOME/Library/Preferences" "$INSTALL_DIR"

if [[ -n "$DMG_PATH" ]]; then
  if [[ ! -f "$DMG_PATH" ]]; then
    echo "ERROR: DMG not found: $DMG_PATH" >&2
    exit 1
  fi
  mkdir -p "$MOUNT_DIR"
  hdiutil attach "$DMG_PATH" -nobrowse -readonly -mountpoint "$MOUNT_DIR" -quiet
  APP_SOURCE="$(find "$MOUNT_DIR" -maxdepth 2 -name '*.app' -type d | head -n 1)"
  if [[ -z "$APP_SOURCE" ]]; then
    echo "ERROR: no .app found in DMG: $DMG_PATH" >&2
    exit 1
  fi
else
  APP_SOURCE="$APP_PATH"
fi

if [[ ! -d "$APP_SOURCE" ]]; then
  echo "ERROR: app bundle not found: $APP_SOURCE" >&2
  exit 1
fi

APP_UNDER_TEST="$INSTALL_DIR/$(basename "$APP_SOURCE")"
/bin/cp -R "$APP_SOURCE" "$APP_UNDER_TEST"
APP_BINARY="$APP_UNDER_TEST/Contents/MacOS/OpenClaw"
INFO_PLIST="$APP_UNDER_TEST/Contents/Info.plist"

DISPLAY_NAME="$(plist_value "$INFO_PLIST" "CFBundleDisplayName")"
BUNDLE_ID="$(plist_value "$INFO_PLIST" "CFBundleIdentifier")"
VARIANT="$(plist_value "$INFO_PLIST" "OpenClawAppVariant")"
COMMIT="$(plist_value "$INFO_PLIST" "OpenClawGitCommit")"

if [[ "$DISPLAY_NAME" != "OpenClaw Consumer" || "$VARIANT" != "consumer" ]]; then
  echo "ERROR: refusing to smoke unexpected app bundle" >&2
  echo "display_name=$DISPLAY_NAME" >&2
  echo "variant=$VARIANT" >&2
  exit 1
fi

EXISTING_APP_PIDS=()
while IFS= read -r pid; do
  [[ -n "$pid" ]] || continue
  EXISTING_APP_PIDS+=("$pid")
done < <(running_openclaw_consumer_pids)
if [[ "${#EXISTING_APP_PIDS[@]}" -gt 0 ]]; then
  if [[ "$QUIT_EXISTING_APP" != "1" ]]; then
    echo "ERROR: another OpenClaw Consumer app is already running with the same bundle identity" >&2
    echo "existing_app_pids=${EXISTING_APP_PIDS[*]}" >&2
    echo "rerun_with=--quit-existing-app" >&2
    exit 1
  fi
  /bin/kill "${EXISTING_APP_PIDS[@]}" 2>/dev/null || true
  sleep 2
fi

STATE_DIR="$FRESH_HOME/Library/Application Support/OpenClaw/instances/${NORMALIZED_INSTANCE_ID}/.openclaw"
CONFIG_PATH="$STATE_DIR/openclaw.json"
REAL_CONFIG_PATH="$HOME/Library/Application Support/OpenClaw/.openclaw/openclaw.json"
REAL_CONFIG_MTIME_BEFORE=""
if [[ -f "$REAL_CONFIG_PATH" ]]; then
  REAL_CONFIG_MTIME_BEFORE="$(stat -f '%m' "$REAL_CONFIG_PATH")"
fi

env -i \
  HOME="$FRESH_HOME" \
  CFFIXED_USER_HOME="$FRESH_HOME" \
  USER="${USER:-$(id -un)}" \
  LOGNAME="${LOGNAME:-$(id -un)}" \
  TMPDIR="${TMPDIR:-/tmp}" \
  PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
  LANG="${LANG:-en_US.UTF-8}" \
  OPENCLAW_TEST=1 \
  OPENCLAW_TEST_HOME="$FRESH_HOME" \
  OPENCLAW_CONSUMER_INSTANCE_ID="$NORMALIZED_INSTANCE_ID" \
  "$APP_BINARY" >/dev/null 2>&1 &
APP_PID=$!

DEADLINE=$((SECONDS + TIMEOUT_SECONDS))
wait_for_file "$CONFIG_PATH" "$DEADLINE" || {
  echo "ERROR: fresh config was not created before timeout" >&2
  echo "config_path=$CONFIG_PATH" >&2
  exit 1
}

wait_for_file "$STATE_DIR/bin/openclaw" "$DEADLINE" || {
  echo "ERROR: bundled runtime wrapper was not seeded before timeout" >&2
  echo "state_dir=$STATE_DIR" >&2
  exit 1
}

wait_for_health "$GATEWAY_PORT" "$DEADLINE" || {
  echo "ERROR: isolated gateway did not become healthy before timeout" >&2
  echo "gateway_port=$GATEWAY_PORT" >&2
  echo "gateway_label=$GATEWAY_LABEL" >&2
  exit 1
}

WINDOW_TITLES="$(read_onboarding_windows)"
if [[ "$WINDOW_TITLES" != *"Welcome to OpenClaw"* ]]; then
  echo "ERROR: onboarding window was not observed" >&2
  echo "observed_window_titles=${WINDOW_TITLES:-<none_or_not_authorized>}" >&2
  exit 1
fi

if [[ ! -f "$CONFIG_PATH" || ! -d "$STATE_DIR/workspace" || ! -d "$STATE_DIR/logs" ]]; then
  echo "ERROR: fresh runtime directories are incomplete" >&2
  echo "state_dir=$STATE_DIR" >&2
  exit 1
fi

if [[ -n "$REAL_CONFIG_MTIME_BEFORE" ]]; then
  REAL_CONFIG_MTIME_AFTER="$(stat -f '%m' "$REAL_CONFIG_PATH")"
  if [[ "$REAL_CONFIG_MTIME_AFTER" != "$REAL_CONFIG_MTIME_BEFORE" ]]; then
    echo "ERROR: real user config mtime changed; refusing to call this isolated" >&2
    echo "real_config_path=$REAL_CONFIG_PATH" >&2
    exit 1
  fi
fi

echo "fresh_user_smoke=passed"
echo "app_path=$APP_UNDER_TEST"
echo "display_name=$DISPLAY_NAME"
echo "bundle_id=$BUNDLE_ID"
echo "variant=$VARIANT"
echo "git_commit=${COMMIT:-unknown}"
echo "instance_id=$NORMALIZED_INSTANCE_ID"
echo "fake_home=$FRESH_HOME"
echo "state_dir=$STATE_DIR"
echo "config_path=$CONFIG_PATH"
echo "gateway_label=$GATEWAY_LABEL"
echo "gateway_port=$GATEWAY_PORT"
echo "onboarding_window=observed"
echo "real_user_config_unchanged=yes"
