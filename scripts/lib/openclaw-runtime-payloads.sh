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

  # Keep packaging/verification focused on native-code candidates instead of
  # every file in the deployed runtime tree. Walking JS/assets one-by-one turns
  # a useful audit into a glacial no-op on large consumer bundles.
  find "$runtime_root" -type f \( \
    -name '*.node' -o \
    -name '*.dylib' -o \
    -name '*.so' -o \
    -perm -111 \
  \) ! -path '*/bin/node' -print0
}

openclaw_runtime_node_binary_files() {
  local app_bundle="$1"
  local runtime_root

  runtime_root="$(openclaw_runtime_payload_root "$app_bundle")"
  [[ -d "$runtime_root" ]] || return 0

  # The bundled Node runtime needs the full runtime/JIT entitlement set so the
  # V8 engine can start and execute native code inside the signed bundle.
  find "$runtime_root" -type f -path '*/bin/node' -print0
}

openclaw_file_is_macho() {
  local file_path="$1"

  /usr/bin/file "$file_path" | /usr/bin/grep -q "Mach-O"
}

openclaw_runtime_node_should_be_macho() {
  local file_path="$1"

  case "$file_path" in
    *.node)
      ;;
    *)
      return 1
      ;;
  esac

  # The bundled runtime can include cross-platform package payloads from the
  # deployed node_modules tree. Only macOS-targeted addons should be treated as
  # executable bundle code that must be Mach-O.
  case "$file_path" in
    *darwin*|*universal*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}
