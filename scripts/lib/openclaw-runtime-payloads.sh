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

openclaw_runtime_nested_app_bundles() {
  local app_bundle="$1"
  local runtime_root

  runtime_root="$(openclaw_runtime_payload_root "$app_bundle")"
  [[ -d "$runtime_root" ]] || return 0

  # Nested apps under Resources are code bundles in their own right. Their
  # executables are signed first by openclaw_runtime_payload_files; emit the
  # enclosing bundles afterward so their CodeResources seal matches.
  find "$runtime_root" -type d -name '*.app' -print0
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

openclaw_runtime_payload_is_vendor_signed_gog() {
  local file_path="$1"

  # Gog stores OAuth tokens in Keychain. Keychain ACLs bind to the executable's
  # designated requirement, so replacing Gog's upstream signature with the
  # Jarvis signature causes repeated prompts. Keep this exception path-specific:
  # no other runtime executable may bypass the normal Jarvis signing sweep.
  case "$file_path" in
    */openclaw/tools/gog/darwin-arm64/gog|*/openclaw/tools/gog/darwin-x86_64/gog)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

openclaw_verify_vendor_signed_gog() {
  local file_path="$1"
  local codesign_bin="${2:-/usr/bin/codesign}"
  local lipo_bin="${3:-/usr/bin/lipo}"
  local expected_arch=""
  local actual_archs=""
  local details=""
  local identifier=""
  local team_identifier=""

  case "$file_path" in
    */darwin-arm64/gog)
      expected_arch="arm64"
      ;;
    */darwin-x86_64/gog)
      expected_arch="x86_64"
      ;;
    *)
      echo "ERROR: refusing unrecognized vendor-signed Gog path: $file_path" >&2
      return 1
      ;;
  esac

  if ! "$codesign_bin" --verify --strict "$file_path" >/dev/null 2>&1; then
    echo "ERROR: bundled Gog failed strict vendor signature verification: $file_path" >&2
    return 1
  fi
  if ! details="$("$codesign_bin" -dv --verbose=4 "$file_path" 2>&1)"; then
    echo "ERROR: bundled Gog signature details are unreadable: $file_path" >&2
    return 1
  fi

  identifier="$(printf '%s\n' "$details" | sed -n 's/^Identifier=//p' | head -n 1)"
  team_identifier="$(printf '%s\n' "$details" | sed -n 's/^TeamIdentifier=//p' | head -n 1)"
  if [[ "$identifier" != "com.steipete.gogcli.gog" || "$team_identifier" != "Y5PE65HELJ" ]]; then
    echo "ERROR: bundled Gog has an unexpected signing identity: $file_path" >&2
    echo "Expected: Identifier=com.steipete.gogcli.gog TeamIdentifier=Y5PE65HELJ" >&2
    echo "Actual: Identifier=${identifier:-<missing>} TeamIdentifier=${team_identifier:-<missing>}" >&2
    return 1
  fi

  actual_archs="$("$lipo_bin" -archs "$file_path" 2>/dev/null || true)"
  if [[ "$actual_archs" != "$expected_arch" ]]; then
    echo "ERROR: bundled Gog architecture mismatch: $file_path" >&2
    echo "Expected: $expected_arch" >&2
    echo "Actual: ${actual_archs:-<missing>}" >&2
    return 1
  fi
}
