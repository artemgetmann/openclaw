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

consumer_instance_bundle_id() {
  local normalized="${1:-}"
  if [[ -z "$normalized" ]]; then
    printf 'ai.openclaw.consumer.mac.debug'
    return
  fi
  printf 'ai.openclaw.consumer.mac.debug.%s' "$normalized"
}

consumer_instance_app_path() {
  local root_dir="$1"
  local normalized="${2:-}"
  local app_name
  app_name="$(consumer_instance_app_name "$normalized")"
  printf '%s/dist/%s.app' "$root_dir" "$app_name"
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
