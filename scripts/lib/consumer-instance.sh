#!/usr/bin/env bash

# Shared consumer-instance derivation for local packaging/launch scripts.
# Keep this logic aligned with apps/macos/Sources/OpenClaw/ConsumerInstance.swift.

consumer_instance_normalize_id() {
  local raw="${1:-}"
  node -e '
    const raw = (process.argv[1] ?? "").trim().toLowerCase();
    if (!raw) process.exit(0);
    const normalized = raw
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (normalized) process.stdout.write(normalized);
  ' -- "$raw"
}

consumer_instance_default_id_for_checkout() {
  local root_dir="$1"
  local absolute_git_dir=""
  local inferred=""

  absolute_git_dir="$(git -C "$root_dir" rev-parse --absolute-git-dir 2>/dev/null || true)"
  if [[ "$absolute_git_dir" == *"/worktrees/"* ]]; then
    inferred="$(basename "$root_dir")"
    consumer_instance_normalize_id "$inferred"
    return
  fi

  printf ''
}

consumer_instance_gateway_port() {
  local normalized="${1:-}"
  if [[ -z "$normalized" ]]; then
    printf '19001'
    return
  fi

  node -e '
    const text = process.argv[1];
    let hash = 0x811c9dc5;
    for (const byte of Buffer.from(text, "utf8")) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    process.stdout.write(String(20000 + (hash % 20000)));
  ' -- "$normalized"
}

consumer_instance_app_name() {
  local normalized="${1:-}"
  if [[ -z "$normalized" ]]; then
    printf 'OpenClaw Consumer'
    return
  fi
  printf 'OpenClaw Consumer (%s)' "$normalized"
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
    printf 'OpenClaw Consumer'
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
  local home_dir="${HOME}"
  local normalized=""

  # Accept both the legacy single-argument form and the new explicit-home
  # form so older call sites keep working while the verifier can inspect
  # a specific user's runtime tree.
  if [[ $# -ge 2 ]]; then
    home_dir="${1:-$HOME}"
    normalized="${2:-}"
  else
    normalized="${1:-}"
  fi

  local runtime_root="${home_dir}/Library/Application Support/OpenClaw Consumer"
  if [[ -z "$normalized" ]]; then
    printf '%s' "$runtime_root"
    return
  fi
  printf '%s/instances/%s' "$runtime_root" "$normalized"
}

consumer_instance_state_dir() {
  local home_dir="${HOME}"
  local normalized=""
  if [[ $# -ge 2 ]]; then
    home_dir="${1:-$HOME}"
    normalized="${2:-}"
  else
    normalized="${1:-}"
  fi
  printf '%s/.openclaw' "$(consumer_instance_runtime_root "$home_dir" "$normalized")"
}

consumer_instance_config_path() {
  local home_dir="${HOME}"
  local normalized=""
  if [[ $# -ge 2 ]]; then
    home_dir="${1:-$HOME}"
    normalized="${2:-}"
  else
    normalized="${1:-}"
  fi
  printf '%s/openclaw.json' "$(consumer_instance_state_dir "$home_dir" "$normalized")"
}

consumer_instance_workspace_path() {
  local home_dir="${HOME}"
  local normalized=""
  if [[ $# -ge 2 ]]; then
    home_dir="${1:-$HOME}"
    normalized="${2:-}"
  else
    normalized="${1:-}"
  fi
  printf '%s/workspace' "$(consumer_instance_state_dir "$home_dir" "$normalized")"
}

consumer_instance_logs_path() {
  local home_dir="${HOME}"
  local normalized=""
  if [[ $# -ge 2 ]]; then
    home_dir="${1:-$HOME}"
    normalized="${2:-}"
  else
    normalized="${1:-}"
  fi
  printf '%s/logs' "$(consumer_instance_state_dir "$home_dir" "$normalized")"
}

consumer_instance_profile() {
  local normalized="${1:-}"
  if [[ -z "$normalized" ]]; then
    printf 'consumer'
    return
  fi
  printf 'consumer-%s' "$normalized"
}

consumer_instance_launchd_label() {
  local normalized="${1:-}"
  if [[ -z "$normalized" ]]; then
    printf 'ai.openclaw.consumer'
    return
  fi
  printf 'ai.openclaw.consumer.%s' "$normalized"
}

consumer_instance_gateway_launchd_label() {
  local normalized="${1:-}"
  if [[ -z "$normalized" ]]; then
    printf 'ai.openclaw.consumer.gateway'
    return
  fi
  printf 'ai.openclaw.consumer.%s.gateway' "$normalized"
}

consumer_instance_apply_runtime_env() {
  local normalized="${1:-}"
  if [[ -z "$normalized" ]]; then
    return 0
  fi

  local runtime_root
  local state_dir
  runtime_root="$(consumer_instance_runtime_root "$normalized")"
  state_dir="$(consumer_instance_state_dir "$normalized")"

  # Consumer lanes must derive runtime ownership from the instance id alone.
  # OPENCLAW_HOME is the lane runtime root. The nested ".openclaw" payload
  # inside it owns config/workspace/logs. Pointing HOME at the state dir itself
  # creates poisoned defaults like ".openclaw/.openclaw/workspace-*", which is
  # how browser/skills checks drift onto fake nested state.
  export OPENCLAW_CONSUMER_INSTANCE_ID="$normalized"
  export OPENCLAW_PROFILE="$(consumer_instance_profile "$normalized")"
  export OPENCLAW_HOME="$runtime_root"
  export OPENCLAW_STATE_DIR="$state_dir"
  export OPENCLAW_CONFIG_PATH="$(consumer_instance_config_path "$normalized")"
  export OPENCLAW_GATEWAY_PORT="$(consumer_instance_gateway_port "$normalized")"
  export OPENCLAW_GATEWAY_BIND="loopback"
  export OPENCLAW_LOG_DIR="${state_dir}/logs"
  export OPENCLAW_LAUNCHD_LABEL="$(consumer_instance_gateway_launchd_label "$normalized")"
}

consumer_instance_export_runtime_env() {
  consumer_instance_apply_runtime_env "$@"
}
