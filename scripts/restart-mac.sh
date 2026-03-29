#!/usr/bin/env bash
# Reset OpenClaw like Trimmy: restart the current app instance, rebuild, repackage, relaunch, verify.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${ROOT_DIR}/scripts/lib/worktree-guards.sh"
APP_BUNDLE="${OPENCLAW_APP_BUNDLE:-}"
GATEWAY_ENTRY="${ROOT_DIR}/dist/index.js"
LAUNCH_AGENT="${HOME}/Library/LaunchAgents/ai.openclaw.mac.plist"
LOCK_KEY="$(printf '%s' "${ROOT_DIR}" | shasum -a 256 | cut -c1-8)"
LOCK_DIR="${TMPDIR:-/tmp}/openclaw-restart-${LOCK_KEY}"
LOCK_PID_FILE="${LOCK_DIR}/pid"
WAIT_FOR_LOCK=0
LOG_PATH="${OPENCLAW_RESTART_LOG:-/tmp/openclaw-restart.log}"
NO_SIGN=0
SIGN=0
AUTO_DETECT_SIGNING=1
GATEWAY_WAIT_SECONDS="${OPENCLAW_GATEWAY_WAIT_SECONDS:-0}"
LAUNCHAGENT_DISABLE_MARKER="${HOME}/.openclaw/disable-launchagent"
APP_SCOPE="self"
RESTART_PROCESS_PATTERNS=()
# Default to the normal launchd-owning path. Attach-only is a niche debugging
# mode that explicitly disables ai.openclaw.gateway ownership, so making it the
# default turns "restart the app" into "quietly stop updating the main bot".
ATTACH_ONLY=0

log()  { printf '%s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Ensure local node binaries (rolldown, pnpm) are discoverable for the steps below.
export PATH="${ROOT_DIR}/node_modules/.bin:${PATH}"

run_step() {
  local label="$1"; shift
  log "==> ${label}"
  if ! "$@"; then
    fail "${label} failed"
  fi
}

cleanup() {
  if [[ -d "${LOCK_DIR}" ]]; then
    rm -rf "${LOCK_DIR}"
  fi
}

acquire_lock() {
  while true; do
    if mkdir "${LOCK_DIR}" 2>/dev/null; then
      echo "$$" > "${LOCK_PID_FILE}"
      return 0
    fi

    local existing_pid=""
    if [[ -f "${LOCK_PID_FILE}" ]]; then
      existing_pid="$(cat "${LOCK_PID_FILE}" 2>/dev/null || true)"
    fi

    if [[ -n "${existing_pid}" ]] && kill -0 "${existing_pid}" 2>/dev/null; then
      if [[ "${WAIT_FOR_LOCK}" == "1" ]]; then
        log "==> Another restart is running (pid ${existing_pid}); waiting..."
        while kill -0 "${existing_pid}" 2>/dev/null; do
          sleep 1
        done
        continue
      fi
      log "==> Another restart is running (pid ${existing_pid}); re-run with --wait."
      exit 0
    fi

    rm -rf "${LOCK_DIR}"
  done
}

check_signing_keys() {
  security find-identity -p codesigning -v 2>/dev/null \
    | grep -Eq '(Developer ID Application|Apple Distribution|Apple Development)'
}

trap cleanup EXIT INT TERM

while [[ $# -gt 0 ]]; do
  case "$1" in
    --wait|-w)
      WAIT_FOR_LOCK=1
      shift
      ;;
    --no-sign)
      NO_SIGN=1
      AUTO_DETECT_SIGNING=0
      shift
      ;;
    --sign)
      SIGN=1
      AUTO_DETECT_SIGNING=0
      shift
      ;;
    --attach-only)
      ATTACH_ONLY=1
      shift
      ;;
    --no-attach-only)
      ATTACH_ONLY=0
      shift
      ;;
    --app-scope)
      if [[ $# -lt 2 ]]; then
        fail "--app-scope requires a value of self or all"
      fi
      APP_SCOPE="$2"
      shift 2
      ;;
    --app-scope=*)
      APP_SCOPE="${1#--app-scope=}"
      shift
      ;;
    --help|-h)
      log "Usage: $(basename "$0") [--wait] [--no-sign] [--sign] [--app-scope self|all] [--attach-only|--no-attach-only]"
      log "  --wait    Wait for other restart to complete instead of exiting"
      log "  --no-sign Force no code signing (fastest for development)"
      log "  --sign    Force code signing (will fail if no signing key available)"
      log "  --app-scope self  Only restart the current app bundle and its gateway"
      log "  --app-scope all   Also kill any other OpenClaw app process"
      log "  --attach-only    Launch app with --attach-only (skip launchd install)"
      log "  --no-attach-only Launch app without attach-only override"
      log ""
      log "Env:"
      log "  OPENCLAW_GATEWAY_WAIT_SECONDS=0  Wait time before gateway port check (unsigned only)"
      log ""
      log "Unsigned recovery:"
      log "  node dist/index.js gateway install --force --allow-shared-service-takeover --runtime node"
      log "  node dist/index.js gateway restart"
      log ""
      log "Reset unsigned overrides:"
      log "  rm ~/.openclaw/disable-launchagent"
      log ""
      log "Default behavior: Auto-detect signing keys, fallback to --no-sign if none found"
      log "Default app scope: self (only the current app bundle and its gateway)"
      exit 0
      ;;
    *)
      shift
      ;;
  esac
done

if [[ "$NO_SIGN" -eq 1 && "$SIGN" -eq 1 ]]; then
  fail "Cannot use --sign and --no-sign together"
fi
if [[ "$APP_SCOPE" != "self" && "$APP_SCOPE" != "all" ]]; then
  fail "Unknown --app-scope value '${APP_SCOPE}'. Use self or all."
fi

mkdir -p "$(dirname "$LOG_PATH")"
rm -f "$LOG_PATH"
exec > >(tee "$LOG_PATH") 2>&1
log "==> Log: ${LOG_PATH}"
if [[ "$NO_SIGN" -eq 1 ]]; then
  log "==> Using --no-sign (unsigned flow enabled)"
fi
if [[ "$ATTACH_ONLY" -eq 1 ]]; then
  log "==> Using --attach-only (skip launchd install)"
fi
log "==> App scope: ${APP_SCOPE}"

acquire_lock

worktree_guard_reject_shared_root_main_edits \
  "${ROOT_DIR}" \
  worktree \
  --context "scripts/restart-mac.sh"

resolve_restart_app_bundle() {
  if [[ -n "${APP_BUNDLE}" && -d "${APP_BUNDLE}" ]]; then
    printf '%s' "${APP_BUNDLE}"
    return 0
  fi

  if [[ -d "/Applications/OpenClaw.app" ]]; then
    printf '%s' "/Applications/OpenClaw.app"
    return 0
  fi

  if [[ -d "${ROOT_DIR}/dist/OpenClaw.app" ]]; then
    printf '%s' "${ROOT_DIR}/dist/OpenClaw.app"
    return 0
  fi
}

resolve_restart_patterns() {
  RESTART_PROCESS_PATTERNS=()

  local restart_app_bundle=""
  restart_app_bundle="$(resolve_restart_app_bundle)"
  if [[ -n "${restart_app_bundle}" ]]; then
    RESTART_PROCESS_PATTERNS+=("${restart_app_bundle}/Contents/MacOS/OpenClaw")
  fi
  RESTART_PROCESS_PATTERNS+=("${ROOT_DIR}/apps/macos/.build/debug/OpenClaw")
  RESTART_PROCESS_PATTERNS+=("${ROOT_DIR}/apps/macos/.build-local/debug/OpenClaw")
  RESTART_PROCESS_PATTERNS+=("${ROOT_DIR}/apps/macos/.build/release/OpenClaw")
}

kill_current_openclaw() {
  resolve_restart_patterns

  for _ in {1..10}; do
    for pattern in "${RESTART_PROCESS_PATTERNS[@]}"; do
      pkill -f "${pattern}" 2>/dev/null || true
    done
    if [[ "$APP_SCOPE" == "all" ]]; then
      pkill -x "OpenClaw" 2>/dev/null || true
    fi
    if ! restart_processes_remaining; then
      return 0
    fi
    sleep 0.3
  done
}

kill_all_openclaw() {
  kill_current_openclaw
}

restart_processes_remaining() {
  local pattern=""

  for pattern in "${RESTART_PROCESS_PATTERNS[@]}"; do
    if [[ -n "${pattern}" ]] && pgrep -f "${pattern}" >/dev/null 2>&1; then
      return 0
    fi
  done

  if [[ "$APP_SCOPE" == "all" ]] && pgrep -x "OpenClaw" >/dev/null 2>&1; then
    return 0
  fi

  return 1
}

stop_launch_agent() {
  launchctl bootout gui/"$UID"/ai.openclaw.mac 2>/dev/null || true
}

# 1) Kill all running instances first.
log "==> Killing existing OpenClaw instances (scope=${APP_SCOPE})"
kill_all_openclaw
stop_launch_agent

# Bundle Gateway-hosted Canvas A2UI assets.
run_step "bundle canvas a2ui" bash -lc "cd '${ROOT_DIR}' && pnpm canvas:a2ui:bundle"

# 2) Rebuild into the same path the packager consumes (.build).
run_step "clean build cache" bash -lc "cd '${ROOT_DIR}/apps/macos' && rm -rf .build .build-swift .swiftpm 2>/dev/null || true"
run_step "swift build" bash -lc "cd '${ROOT_DIR}/apps/macos' && swift build -q --product OpenClaw"

if [ "$AUTO_DETECT_SIGNING" -eq 1 ]; then
  if check_signing_keys; then
    log "==> Signing keys detected, will code sign"
    SIGN=1
  else
    log "==> No signing keys found, will skip code signing (--no-sign)"
    NO_SIGN=1
  fi
fi

if [ "$NO_SIGN" -eq 1 ]; then
  export ALLOW_ADHOC_SIGNING=1
  export SIGN_IDENTITY="-"
  mkdir -p "${HOME}/.openclaw"
  run_step "disable launchagent writes" /usr/bin/touch "${LAUNCHAGENT_DISABLE_MARKER}"
elif [ "$SIGN" -eq 1 ]; then
  if ! check_signing_keys; then
    fail "No signing identity found. Use --no-sign or install a signing key."
  fi
  unset ALLOW_ADHOC_SIGNING
  unset SIGN_IDENTITY
fi

# 3) Package app (no embedded gateway).
run_step "package app" bash -lc "cd '${ROOT_DIR}' && SKIP_TSC=${SKIP_TSC:-1} '${ROOT_DIR}/scripts/package-mac-app.sh'"

choose_app_bundle() {
  if [[ -n "${APP_BUNDLE}" && -d "${APP_BUNDLE}" ]]; then
    return 0
  fi

  if [[ -d "/Applications/OpenClaw.app" ]]; then
    APP_BUNDLE="/Applications/OpenClaw.app"
    return 0
  fi

  if [[ -d "${ROOT_DIR}/dist/OpenClaw.app" ]]; then
    APP_BUNDLE="${ROOT_DIR}/dist/OpenClaw.app"
    if [[ ! -d "${APP_BUNDLE}/Contents/Frameworks/Sparkle.framework" ]]; then
      fail "dist/OpenClaw.app missing Sparkle after packaging"
    fi
    return 0
  fi

  fail "App bundle not found. Set OPENCLAW_APP_BUNDLE to your installed OpenClaw.app"
}

choose_app_bundle

# When signed, clear any previous launchagent override marker.
if [[ "$NO_SIGN" -ne 1 && "$ATTACH_ONLY" -ne 1 && -f "${LAUNCHAGENT_DISABLE_MARKER}" ]]; then
  run_step "clear launchagent disable marker" /bin/rm -f "${LAUNCHAGENT_DISABLE_MARKER}"
fi

# When unsigned, ensure the gateway LaunchAgent targets the repo CLI (before the app launches).
# This reduces noisy "could not connect" errors during app startup.
if [ "$NO_SIGN" -eq 1 ] && [ "$ATTACH_ONLY" -ne 1 ]; then
  # The unsigned recovery path still owns the shared main LaunchAgent, so it
  # must use the canonical repo entrypoint plus explicit takeover instead of a
  # wrapper/alias install that can drift back to ~/.openclaw.
  run_step "install gateway launch agent (unsigned)" bash -lc "cd '${ROOT_DIR}' && node '${GATEWAY_ENTRY}' gateway install --force --allow-shared-service-takeover --runtime node"
  run_step "restart gateway daemon (unsigned)" bash -lc "cd '${ROOT_DIR}' && node '${GATEWAY_ENTRY}' gateway restart"
  if [[ "${GATEWAY_WAIT_SECONDS}" -gt 0 ]]; then
    run_step "wait for gateway (unsigned)" sleep "${GATEWAY_WAIT_SECONDS}"
  fi
  GATEWAY_PORT="$(
    node -e '
      const fs = require("node:fs");
      const path = require("node:path");
      try {
        const raw = fs.readFileSync(path.join(process.env.HOME, ".openclaw", "openclaw.json"), "utf8");
        const cfg = JSON.parse(raw);
        const port = cfg && cfg.gateway && typeof cfg.gateway.port === "number" ? cfg.gateway.port : 18789;
        process.stdout.write(String(port));
      } catch {
        process.stdout.write("18789");
      }
    '
  )"
  run_step "verify gateway port ${GATEWAY_PORT} (unsigned)" bash -lc "lsof -iTCP:${GATEWAY_PORT} -sTCP:LISTEN | head -n 5 || true"
  run_step "verify gateway launch agent target (unsigned)" bash -lc "launchctl print gui/\$(id -u)/ai.openclaw.gateway | grep -F '${GATEWAY_ENTRY}'"
fi

ATTACH_ONLY_ARGS=()
if [[ "$ATTACH_ONLY" -eq 1 ]]; then
  ATTACH_ONLY_ARGS+=(--args --attach-only)
fi

# 4) Launch the installed app in the foreground so the menu bar extra appears.
# LaunchServices can inherit a huge environment from this shell (secrets, prompt vars, etc.).
# That can cause launchd spawn failures and is undesirable for a GUI app anyway.
run_step "launch app" env -i \
  HOME="${HOME}" \
  USER="${USER:-$(id -un)}" \
  LOGNAME="${LOGNAME:-$(id -un)}" \
  TMPDIR="${TMPDIR:-/tmp}" \
  PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
  LANG="${LANG:-en_US.UTF-8}" \
  /usr/bin/open "${APP_BUNDLE}" ${ATTACH_ONLY_ARGS[@]:+"${ATTACH_ONLY_ARGS[@]}"}

# 5) Verify the app is alive.
sleep 1.5
resolve_restart_patterns
if restart_processes_remaining; then
  log "OK: OpenClaw is running."
else
  fail "App exited immediately. Check ${LOG_PATH} or Console.app (User Reports)."
fi

if [ "$NO_SIGN" -eq 1 ] && [ "$ATTACH_ONLY" -ne 1 ]; then
  run_step "show gateway launch agent args (unsigned)" bash -lc "/usr/bin/plutil -p '${HOME}/Library/LaunchAgents/ai.openclaw.gateway.plist' | head -n 40 || true"
fi
