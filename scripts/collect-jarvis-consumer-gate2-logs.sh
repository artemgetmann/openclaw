#!/usr/bin/env bash
set -euo pipefail

# Collect read-only proof for the clean-user Jarvis Consumer Gate2 run.
# This script is intentionally self-contained because the staged copy lives in
# /Users/Shared and may be run from the clean macOS account without the repo cwd.

TARGET_USER="${JARVIS_GATE2_USER:-jarvistest}"
INSTANCE_ID="jarvis-consumer-gate2"
APP_NAME="Jarvis Consumer Gate2"
BUNDLE_ID="ai.openclaw.consumer.mac.gate2"
GATEWAY_PORT="25229"
GATEWAY_LABEL="ai.openclaw.consumer.jarvis-consumer-gate2.gateway"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUTPUT_ROOT="${JARVIS_GATE2_LOG_DIR:-/Users/Shared/jarvis-consumer-gate2-proof-${TIMESTAMP}}"

target_home() {
  local home=""
  home="$(dscl . -read "/Users/${TARGET_USER}" NFSHomeDirectory 2>/dev/null | awk '{print $2}' || true)"
  if [[ -n "$home" ]]; then
    printf '%s\n' "$home"
    return
  fi
  printf '/Users/%s\n' "$TARGET_USER"
}

write_section() {
  local title="$1"
  printf '\n## %s\n' "$title"
}

copy_tail_logs() {
  local logs_dir="$1"
  local out_dir="$2"
  local log_file=""

  mkdir -p "$out_dir"
  if [[ ! -d "$logs_dir" ]]; then
    printf 'logs_dir_missing=%s\n' "$logs_dir" >"$out_dir/README.txt"
    return
  fi

  while IFS= read -r log_file; do
    [[ -f "$log_file" ]] || continue
    tail -n "${JARVIS_GATE2_LOG_TAIL_LINES:-300}" "$log_file" \
      >"$out_dir/$(basename "$log_file").tail" 2>&1 || true
  done < <(find "$logs_dir" -maxdepth 2 -type f \( -name '*.log' -o -name '*.jsonl' -o -name '*.txt' \) | sort)
}

redact_config() {
  local config_path="$1"
  local out_path="$2"

  if [[ ! -f "$config_path" ]]; then
    printf 'config_missing=%s\n' "$config_path" >"$out_path"
    return
  fi

  if command -v jq >/dev/null 2>&1; then
    jq '
      def redact:
        if type == "object" then
          with_entries(
            if (.key | test("token|secret|password|apiKey|authorization|cookie"; "i")) then
              .value = "<redacted>"
            else
              .value |= redact
            end
          )
        elif type == "array" then map(redact)
        else .
        end;
      redact
    ' "$config_path" >"$out_path" 2>"$out_path.stderr" || true
    return
  fi

  sed -E 's/("(token|secret|password|apiKey|authorization|cookie)[^"]*"[[:space:]]*:[[:space:]]*)"[^"]*"/\1"<redacted>"/Ig' \
    "$config_path" >"$out_path" 2>"$out_path.stderr" || true
}

main() {
  local home
  local state_root
  local state_dir
  local config_path
  local logs_dir
  local staged_app
  local uid

  home="$(target_home)"
  state_root="${home}/Library/Application Support/OpenClaw/instances/${INSTANCE_ID}"
  state_dir="${state_root}/.openclaw"
  config_path="${state_dir}/openclaw.json"
  logs_dir="${state_dir}/logs"
  staged_app="${home}/Desktop/${APP_NAME}.app"
  uid="$(id -u "$TARGET_USER" 2>/dev/null || true)"

  mkdir -p "$OUTPUT_ROOT"

  {
    write_section "Expected Identity"
    printf 'target_user=%s\n' "$TARGET_USER"
    printf 'target_uid=%s\n' "${uid:-unknown}"
    printf 'target_home=%s\n' "$home"
    printf 'app_name=%s\n' "$APP_NAME"
    printf 'bundle_id=%s\n' "$BUNDLE_ID"
    printf 'instance_id=%s\n' "$INSTANCE_ID"
    printf 'gateway_port=%s\n' "$GATEWAY_PORT"
    printf 'gateway_label=%s\n' "$GATEWAY_LABEL"
    printf 'state_root=%s\n' "$state_root"
    printf 'config_path=%s\n' "$config_path"

    write_section "Collector Runtime"
    date -u
    whoami
    id

    write_section "Staged App"
    ls -ld "$staged_app" "$staged_app/Contents" "$staged_app/Contents/Info.plist" 2>&1 || true
    if [[ -f "$staged_app/Contents/Info.plist" ]]; then
      /usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "$staged_app/Contents/Info.plist" 2>&1 || true
      /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$staged_app/Contents/Info.plist" 2>&1 || true
      /usr/libexec/PlistBuddy -c 'Print :OpenClawConsumerInstanceID' "$staged_app/Contents/Info.plist" 2>&1 || true
      /usr/libexec/PlistBuddy -c 'Print :OpenClawGitCommit' "$staged_app/Contents/Info.plist" 2>&1 || true
    fi

    write_section "LaunchAgent"
    if [[ -n "$uid" ]]; then
      launchctl print "gui/${uid}/${GATEWAY_LABEL}" 2>&1 || true
    else
      printf 'target uid unavailable; skipping launchctl print\n'
    fi

    write_section "Port Owner"
    lsof -nP -iTCP:"${GATEWAY_PORT}" -sTCP:LISTEN 2>&1 || true

    write_section "Process Snapshot"
    ps -axo user=,pid=,ppid=,command= | grep -E "${GATEWAY_LABEL}|${GATEWAY_PORT}|${INSTANCE_ID}|${APP_NAME}|OpenClaw" | grep -v grep || true

    write_section "State Paths"
    ls -la "$state_root" "$state_dir" "$logs_dir" 2>&1 || true
  } >"$OUTPUT_ROOT/summary.txt" 2>&1

  redact_config "$config_path" "$OUTPUT_ROOT/openclaw.redacted.json"
  copy_tail_logs "$logs_dir" "$OUTPUT_ROOT/logs"

  printf 'Gate2 proof collected:\n'
  printf '  output=%s\n' "$OUTPUT_ROOT"
  printf '  summary=%s\n' "$OUTPUT_ROOT/summary.txt"
}

main "$@"
