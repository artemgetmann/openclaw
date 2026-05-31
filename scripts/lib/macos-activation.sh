#!/usr/bin/env bash

# Shared macOS app foregrounding helper for packaging/open scripts.
#
# `open -n <app>` is the durable launch step. The follow-up AppleScript is only
# a convenience foreground/reopen nudge, and macOS Automation/TCC can leave
# osascript waiting forever. Keep that step bounded so a completed install does
# not look like a packaging hang.

openclaw_macos_activation_timeout_secs() {
  local timeout_secs="${OPENCLAW_MAC_APP_ACTIVATION_TIMEOUT_SECS:-12}"

  if [[ ! "$timeout_secs" =~ ^[0-9]+$ || "$timeout_secs" -le 0 ]]; then
    timeout_secs=12
  fi

  printf '%s\n' "$timeout_secs"
}

openclaw_warn_macos_activation() {
  local app_path="$1"
  local bundle_id="$2"
  local reason="$3"

  echo "WARN: app launch completed, but AppleScript activation ${reason}." >&2
  echo "WARN: continuing without waiting for foreground activation." >&2
  echo "Manual next command:" >&2
  printf '  /usr/bin/open -n %q\n' "$app_path" >&2
  echo "Manual foreground fallback: click the app in Dock/Finder if macOS does not bring it forward." >&2
  echo "Bundle id: $bundle_id" >&2
}

openclaw_activate_macos_app() {
  local app_path="$1"
  local bundle_id="$2"
  local timeout_secs
  local script_path
  local osascript_pid
  local waited=0
  local status=0

  timeout_secs="$(openclaw_macos_activation_timeout_secs)"
  script_path="$(mktemp "${TMPDIR:-/tmp}/openclaw-activate-app.XXXXXX.applescript")"
  cat >"$script_path" <<EOF
tell application id "$bundle_id"
  reopen
  activate
end tell
EOF

  /usr/bin/osascript "$script_path" >/dev/null 2>&1 &
  osascript_pid="$!"

  while /bin/kill -0 "$osascript_pid" 2>/dev/null; do
    if [[ "$waited" -ge "$timeout_secs" ]]; then
      /bin/kill "$osascript_pid" 2>/dev/null || true
      /bin/sleep 1
      /bin/kill -9 "$osascript_pid" 2>/dev/null || true
      rm -f "$script_path"
      openclaw_warn_macos_activation "$app_path" "$bundle_id" "timed out after ${timeout_secs}s"
      return 0
    fi

    /bin/sleep 1
    waited=$((waited + 1))
  done

  wait "$osascript_pid" || status=$?
  rm -f "$script_path"

  if [[ "$status" -ne 0 ]]; then
    openclaw_warn_macos_activation "$app_path" "$bundle_id" "failed with exit status ${status}"
  fi

  return 0
}
