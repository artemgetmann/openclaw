#!/usr/bin/env bash

# Shared runtime-payload helpers for consumer macOS signing and verification.
# Keep this tiny so the packager and verifier walk the same tree without
# duplicating path logic.

openclaw_runtime_payload_root() {
  local app_bundle="$1"

  printf '%s\n' "$app_bundle/Contents/Resources/OpenClawRuntime"
}

openclaw_runtime_payload_files() {
  local app_bundle="$1"
  local runtime_root

  runtime_root="$(openclaw_runtime_payload_root "$app_bundle")"
  [[ -d "$runtime_root" ]] || return 0

  find "$runtime_root" -type f -print0
}

openclaw_file_is_macho() {
  local file_path="$1"

  /usr/bin/file "$file_path" | /usr/bin/grep -q "Mach-O"
}
