#!/usr/bin/env bash

# Guardrails for scripts that clean up stale gateway LaunchAgents.
# The default shared gateway is the main Jarvis runtime. Named smoke or
# consumer lanes may run their own isolated labels, but they must not boot out
# ai.openclaw.gateway unless they are deliberately repairing the canonical
# default runtime identity.

OPENCLAW_PLISTBUDDY_BIN="${OPENCLAW_PLISTBUDDY_BIN:-/usr/libexec/PlistBuddy}"
OPENCLAW_LAUNCHCTL_BIN="${OPENCLAW_LAUNCHCTL_BIN:-/bin/launchctl}"

openclaw_gateway_plist_value() {
  local plist_path="$1"
  local key_path="$2"
  "$OPENCLAW_PLISTBUDDY_BIN" -c "Print :${key_path}" "$plist_path" 2>/dev/null || true
}

openclaw_gateway_plist_port() {
  local plist_path="$1"
  local index=0
  local arg=""

  while true; do
    arg="$(openclaw_gateway_plist_value "$plist_path" "ProgramArguments:${index}")"
    [[ -n "$arg" ]] || break
    if [[ "$arg" == "--port" ]]; then
      openclaw_gateway_plist_value "$plist_path" "ProgramArguments:$((index + 1))"
      return 0
    fi
    if [[ "$arg" == --port=* ]]; then
      printf '%s\n' "${arg#--port=}"
      return 0
    fi
    index=$((index + 1))
  done

  return 1
}

openclaw_is_canonical_default_gateway_intent() {
  local target_label="$1"
  local target_state_dir="$2"
  local target_config_path="$3"
  local target_port="$4"

  local canonical_home="${OPENCLAW_CANONICAL_SHARED_GATEWAY_HOME:-${HOME}/Library/Application Support/OpenClaw}"
  local canonical_state_dir="${OPENCLAW_CANONICAL_SHARED_GATEWAY_STATE_DIR:-${canonical_home}/.openclaw}"
  local canonical_config_path="${OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH:-${canonical_state_dir}/openclaw.json}"
  local canonical_port="${OPENCLAW_CANONICAL_SHARED_GATEWAY_PORT:-18789}"

  [[ "$target_label" == "ai.openclaw.gateway" ]] &&
    [[ "$target_state_dir" == "$canonical_state_dir" ]] &&
    [[ "$target_config_path" == "$canonical_config_path" ]] &&
    [[ "$target_port" == "$canonical_port" ]]
}

openclaw_bootout_conflicting_gateway_label() {
  local label="$1"
  local target_label="$2"
  local target_state_dir="$3"
  local target_config_path="$4"
  local target_port="$5"

  # A label never conflicts with itself; the caller manages its own label
  # through the install/restart path that follows.
  [[ "$label" == "$target_label" ]] && return 0

  local plist_path="$HOME/Library/LaunchAgents/${label}.plist"
  [[ -f "$plist_path" ]] || return 0

  # Named/isolated smoke lanes must not unload the shared Jarvis gateway. The
  # only allowed default-service bootout is an explicit canonical default repair
  # where label, state dir, config path, and port all match the default runtime.
  if [[ "$label" == "ai.openclaw.gateway" ]] &&
    ! openclaw_is_canonical_default_gateway_intent \
      "$target_label" "$target_state_dir" "$target_config_path" "$target_port"; then
    printf 'Skipping default gateway bootout for isolated target: label=%s target_label=%s target_port=%s\n' \
      "$label" "$target_label" "$target_port" >&2
    return 0
  fi

  local existing_state_dir
  local existing_config_path
  local existing_port=""

  existing_state_dir="$(openclaw_gateway_plist_value "$plist_path" 'EnvironmentVariables:OPENCLAW_STATE_DIR')"
  existing_config_path="$(openclaw_gateway_plist_value "$plist_path" 'EnvironmentVariables:OPENCLAW_CONFIG_PATH')"
  existing_port="$(openclaw_gateway_plist_port "$plist_path" || true)"

  # Only unload stale labels that point at the target runtime. Requiring all
  # three fields prevents a coincidental port or config overlap from taking down
  # another lane.
  if [[ "$existing_state_dir" != "$target_state_dir" ||
    "$existing_config_path" != "$target_config_path" ||
    "$existing_port" != "$target_port" ]]; then
    return 0
  fi

  "$OPENCLAW_LAUNCHCTL_BIN" bootout "gui/$(id -u)/${label}" >/dev/null 2>&1 || true
  "$OPENCLAW_LAUNCHCTL_BIN" unload "$plist_path" >/dev/null 2>&1 || true
  return 0
}
