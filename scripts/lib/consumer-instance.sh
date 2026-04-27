#!/usr/bin/env bash

# Shared consumer-instance derivation for local packaging/launch scripts.
# Runtime identity math now lives in TypeScript so shell, tests, and future
# call sites all read the same contract instead of quietly drifting apart.

consumer_instance_repo_root() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  cd "${script_dir}/../.." && pwd
}

consumer_instance_contract() {
  local repo_root
  repo_root="$(consumer_instance_repo_root)"
  node --import tsx "${repo_root}/scripts/consumer-runtime-identity.ts" "$@"
}

consumer_instance_identity_field() {
  local field="$1"
  shift

  local home_dir="${HOME}"
  local normalized=""
  if [[ $# -ge 2 ]]; then
    home_dir="${1:-$HOME}"
    normalized="${2:-}"
  else
    normalized="${1:-}"
  fi

  consumer_instance_contract field --field "$field" --home "$home_dir" --instance "$normalized"
}

consumer_instance_normalize_id() {
  local raw="${1:-}"
  consumer_instance_contract normalize "$raw"
}

consumer_instance_default_id_for_checkout() {
  local root_dir="$1"
  consumer_instance_contract default-id --root "$root_dir"
}

consumer_instance_gateway_port() {
  local normalized="${1:-}"
  consumer_instance_identity_field gatewayPort "$normalized"
}

consumer_instance_app_name() {
  local normalized="${1:-}"
  if [[ -z "$normalized" ]]; then
    printf 'OpenClaw'
    return
  fi
  printf 'OpenClaw (%s)' "$normalized"
}

consumer_instance_stable_tcc_identity_enabled() {
  local raw="${OPENCLAW_CONSUMER_STABLE_TCC_IDENTITY:-}"
  case "${raw,,}" in
    1|true|yes|on)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

consumer_instance_display_name() {
  local normalized="${1:-}"
  # Screen Recording can pin dev builds to a stale TCC row when every worktree
  # gets its own bundle identity. Keep the runtime lane isolated, but allow the
  # packaged app identity to collapse back to the stable debug app when local QA
  # explicitly opts in to that mode.
  if consumer_instance_stable_tcc_identity_enabled; then
    printf 'OpenClaw'
    return
  fi
  consumer_instance_app_name "$normalized"
}

consumer_instance_bundle_id() {
  local normalized="${1:-}"
  if consumer_instance_stable_tcc_identity_enabled; then
    printf 'ai.openclaw.consumer.mac.debug'
    return
  fi
  if [[ -z "$normalized" ]]; then
    printf 'ai.openclaw.consumer.mac.debug'
    return
  fi
  printf 'ai.openclaw.consumer.mac.debug.%s' "$normalized"
}

consumer_instance_release_bundle_id() {
  local normalized="${1:-}"
  if [[ -z "$normalized" ]]; then
    printf 'ai.openclaw.consumer.mac'
    return
  fi
  printf 'ai.openclaw.consumer.mac.%s' "$normalized"
}

consumer_instance_app_path() {
  local root_dir="$1"
  local normalized="${2:-}"
  local app_name
  app_name="$(consumer_instance_app_name "$normalized")"
  printf '%s/dist/%s.app' "$root_dir" "$app_name"
}

consumer_instance_runtime_root() {
  consumer_instance_identity_field runtimeRoot "$@"
}

consumer_instance_state_dir() {
  consumer_instance_identity_field stateDir "$@"
}

consumer_instance_config_path() {
  consumer_instance_identity_field configPath "$@"
}

consumer_instance_workspace_path() {
  consumer_instance_identity_field workspacePath "$@"
}

consumer_instance_logs_path() {
  consumer_instance_identity_field logDir "$@"
}

consumer_instance_profile() {
  consumer_instance_identity_field profile "$1"
}

consumer_instance_launchd_label() {
  consumer_instance_identity_field launchdLabel "$1"
}

consumer_instance_gateway_launchd_label() {
  consumer_instance_identity_field gatewayLaunchdLabel "$1"
}

consumer_instance_apply_runtime_env() {
  local normalized="${1:-}"
  if [[ -z "$normalized" ]]; then
    return 0
  fi

  local state_dir
  state_dir="$(consumer_instance_state_dir "$normalized")"
  local runtime_root
  runtime_root="$(consumer_instance_runtime_root "$normalized")"

  # Consumer lanes must derive runtime ownership from the instance id alone.
  # If a caller leaves stale OPENCLAW_* overrides in the shell, commands like
  # `browser profiles` can drift onto the wrong gateway while status still
  # reports the LaunchAgent for this lane. Pin every runtime selector here so
  # the wrapper, service install, and status flow all share one source of truth.
  export OPENCLAW_CONSUMER_INSTANCE_ID="$normalized"
  export OPENCLAW_PROFILE="$(consumer_instance_profile "$normalized")"
  export OPENCLAW_HOME="$runtime_root"
  export OPENCLAW_STATE_DIR="$state_dir"
  export OPENCLAW_CONFIG_PATH="$(consumer_instance_config_path "$normalized")"
  export OPENCLAW_GATEWAY_PORT="$(consumer_instance_gateway_port "$normalized")"
  export OPENCLAW_GATEWAY_BIND="$(consumer_instance_identity_field gatewayBind "$normalized")"
  export OPENCLAW_LOG_DIR="$(consumer_instance_logs_path "$normalized")"
  export OPENCLAW_LAUNCHD_LABEL="$(consumer_instance_gateway_launchd_label "$normalized")"
}

consumer_instance_export_runtime_env() {
  consumer_instance_apply_runtime_env "$@"
}
