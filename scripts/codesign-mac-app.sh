#!/usr/bin/env bash
set -euo pipefail

APP_BUNDLE="${1:-dist/OpenClaw.app}"
IDENTITY="${SIGN_IDENTITY:-}"
TIMESTAMP_MODE="${CODESIGN_TIMESTAMP:-auto}"
DISABLE_LIBRARY_VALIDATION="${DISABLE_LIBRARY_VALIDATION:-0}"
SKIP_TEAM_ID_CHECK="${SKIP_TEAM_ID_CHECK:-0}"
PACKAGE_TIMING="${PACKAGE_TIMING:-0}"
source "$(cd "$(dirname "$0")" && pwd)/lib/openclaw-runtime-payloads.sh"
ENT_TMP_BASE=$(mktemp -t openclaw-entitlements-base.XXXXXX)
ENT_TMP_APP_BASE=$(mktemp -t openclaw-entitlements-app-base.XXXXXX)
ENT_TMP_RUNTIME=$(mktemp -t openclaw-entitlements-runtime.XXXXXX)

if [[ "${APP_BUNDLE}" == "--help" || "${APP_BUNDLE}" == "-h" ]]; then
  cat <<'HELP'
Usage: scripts/codesign-mac-app.sh [app-bundle]

Env:
  SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"
  ALLOW_ADHOC_SIGNING=1
  CODESIGN_TIMESTAMP=auto|on|off
  DISABLE_LIBRARY_VALIDATION=1      # dev-only Sparkle Team ID workaround
  SKIP_TEAM_ID_CHECK=1              # bypass Team ID audit
HELP
  exit 0
fi

if [ ! -d "$APP_BUNDLE" ]; then
  echo "App bundle not found: $APP_BUNDLE" >&2
  exit 1
fi

phase_now_ms() {
  "${OPENCLAW_NODE_BIN:-node}" -e 'process.stdout.write(String(Date.now()))'
}

phase_log_elapsed() {
  local started_ms="$1"
  local label="$2"
  local finished_ms
  local elapsed_ms

  if [[ "$PACKAGE_TIMING" != "1" ]]; then
    return 0
  fi

  finished_ms="$(phase_now_ms)"
  elapsed_ms=$((finished_ms - started_ms))
  printf '⏱  %s: %d.%03ds\n' "$label" "$((elapsed_ms / 1000))" "$((elapsed_ms % 1000))" >&2
}

select_identity() {
  local preferred available first

  # Prefer a Developer ID Application cert.
  preferred="$(security find-identity -p codesigning -v 2>/dev/null \
    | awk -F'\"' '/Developer ID Application/ { print $2; exit }')"

  if [ -n "$preferred" ]; then
    echo "$preferred"
    return
  fi

  # Next, try Apple Distribution.
  preferred="$(security find-identity -p codesigning -v 2>/dev/null \
    | awk -F'\"' '/Apple Distribution/ { print $2; exit }')"
  if [ -n "$preferred" ]; then
    echo "$preferred"
    return
  fi

  # Then, try Apple Development.
  preferred="$(security find-identity -p codesigning -v 2>/dev/null \
    | awk -F'\"' '/Apple Development/ { print $2; exit }')"
  if [ -n "$preferred" ]; then
    echo "$preferred"
    return
  fi

  # Fallback to the first valid signing identity.
  available="$(security find-identity -p codesigning -v 2>/dev/null \
    | sed -n 's/.*\"\\(.*\\)\"/\\1/p')"

  if [ -n "$available" ]; then
    first="$(printf '%s\n' "$available" | head -n1)"
    echo "$first"
    return
  fi

  return 1
}

if [ -z "$IDENTITY" ]; then
  if ! IDENTITY="$(select_identity)"; then
    if [[ "${ALLOW_ADHOC_SIGNING:-}" == "1" ]]; then
      echo "WARN: No signing identity found. Falling back to ad-hoc signing (-)." >&2
      echo "      !!! WARNING: Ad-hoc signed apps do NOT persist TCC permissions (Accessibility, etc) !!!" >&2
      echo "      !!! You will need to re-grant permissions every time you restart the app.         !!!" >&2
      IDENTITY="-"
    else
      echo "ERROR: No signing identity found. Set SIGN_IDENTITY to a valid codesigning certificate." >&2
      echo "       Alternatively, set ALLOW_ADHOC_SIGNING=1 to fallback to ad-hoc signing (limitations apply)." >&2
      exit 1
    fi
  fi
fi

echo "Using signing identity: $IDENTITY"
if [[ "$IDENTITY" == "-" ]]; then
  cat <<'WARN' >&2

================================================================================
!!! AD-HOC SIGNING IN USE - PERMISSIONS WILL NOT STICK (macOS RESTRICTION) !!!

macOS ties permissions to the code signature, bundle ID, and app path.
Ad-hoc signing generates a new signature every build, so macOS treats the app
as a different binary and will forget permissions (prompts may vanish).

For correct permission behavior you MUST sign with a real Apple Development or
Developer ID certificate.

If prompts disappear: remove the app entry in System Settings -> Privacy & Security,
relaunch the app, and re-grant. Some permissions only reappear after a full
macOS restart.
================================================================================

WARN
fi

timestamp_arg="--timestamp=none"
case "$TIMESTAMP_MODE" in
  1|on|yes|true)
    timestamp_arg="--timestamp"
    ;;
  0|off|no|false)
    timestamp_arg="--timestamp=none"
    ;;
  auto)
    if [[ "$IDENTITY" == *"Developer ID Application"* ]]; then
      timestamp_arg="--timestamp"
    fi
    ;;
  *)
    echo "ERROR: Unknown CODESIGN_TIMESTAMP value: $TIMESTAMP_MODE (use auto|on|off)" >&2
    exit 1
    ;;
esac
if [[ "$IDENTITY" == "-" ]]; then
  timestamp_arg="--timestamp=none"
fi

options_args=()
if [[ "$IDENTITY" != "-" ]]; then
  options_args=("--options" "runtime")
fi
timestamp_args=("$timestamp_arg")

cat > "$ENT_TMP_BASE" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.automation.apple-events</key>
    <true/>
    <key>com.apple.security.device.audio-input</key>
    <true/>
    <key>com.apple.security.device.camera</key>
    <true/>
</dict>
</plist>
PLIST

cat > "$ENT_TMP_APP_BASE" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.automation.apple-events</key>
    <true/>
    <key>com.apple.security.device.audio-input</key>
    <true/>
    <key>com.apple.security.device.camera</key>
    <true/>
    <key>com.apple.security.personal-information.location</key>
    <true/>
</dict>
</plist>
PLIST

cat > "$ENT_TMP_RUNTIME" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
</dict>
</plist>
PLIST

if [[ "$DISABLE_LIBRARY_VALIDATION" == "1" ]]; then
  /usr/libexec/PlistBuddy -c "Add :com.apple.security.cs.disable-library-validation bool true" "$ENT_TMP_APP_BASE" >/dev/null 2>&1 || \
    /usr/libexec/PlistBuddy -c "Set :com.apple.security.cs.disable-library-validation true" "$ENT_TMP_APP_BASE"
  echo "Note: disable-library-validation entitlement enabled (DISABLE_LIBRARY_VALIDATION=1)."
fi

APP_ENTITLEMENTS="$ENT_TMP_APP_BASE"

# clear extended attributes to avoid stale signatures
xattr -cr "$APP_BUNDLE" 2>/dev/null || true

sign_item() {
  local target="$1"
  local entitlements="$2"
  codesign --force ${options_args+"${options_args[@]}"} "${timestamp_args[@]}" --entitlements "$entitlements" --sign "$IDENTITY" "$target"
}

sign_plain_item() {
  local target="$1"
  codesign --force ${options_args+"${options_args[@]}"} "${timestamp_args[@]}" --sign "$IDENTITY" "$target"
}

sign_runtime_node_item() {
  local target="$1"
  codesign --force ${options_args+"${options_args[@]}"} "${timestamp_args[@]}" --entitlements "$ENT_TMP_RUNTIME" --sign "$IDENTITY" "$target"
}

team_id_for() {
  codesign -dv --verbose=4 "$1" 2>&1 | awk -F= '/^TeamIdentifier=/{print $2; exit}'
}

verify_team_ids() {
  if [[ "$SKIP_TEAM_ID_CHECK" == "1" ]]; then
    echo "Note: skipping Team ID audit (SKIP_TEAM_ID_CHECK=1)."
    return 0
  fi

  local expected
  expected="$(team_id_for "$APP_BUNDLE" || true)"
  if [[ -z "$expected" ]]; then
    echo "WARN: TeamIdentifier missing on app bundle; skipping Team ID audit."
    return 0
  fi

  local mismatches=()
  while IFS= read -r -d '' f; do
    if /usr/bin/file "$f" | /usr/bin/grep -q "Mach-O"; then
      local team
      team="$(team_id_for "$f" || true)"
      if [[ -z "$team" ]]; then
        team="not set"
      fi
      if [[ "$expected" == "not set" ]]; then
        if [[ "$team" != "not set" ]]; then
          mismatches+=("$f (TeamIdentifier=$team)")
        fi
      elif [[ "$team" != "$expected" ]]; then
        mismatches+=("$f (TeamIdentifier=$team)")
      fi
    fi
  done < <(find "$APP_BUNDLE" -type f -print0)

  if [[ "${#mismatches[@]}" -gt 0 ]]; then
    echo "ERROR: Team ID mismatch detected (expected: $expected)"
    for entry in "${mismatches[@]}"; do
      echo " - $entry"
    done
    echo "Hint: re-sign embedded frameworks or set DISABLE_LIBRARY_VALIDATION=1 for dev builds."
    exit 1
  fi
}

# Sign main binary
main_binary_started_ms="$(phase_now_ms)"
if [ -f "$APP_BUNDLE/Contents/MacOS/OpenClaw" ]; then
  echo "Signing main binary"; sign_item "$APP_BUNDLE/Contents/MacOS/OpenClaw" "$APP_ENTITLEMENTS"
fi
phase_log_elapsed "$main_binary_started_ms" "Sign main binary"

# Sign Sparkle deeply if present
SPARKLE="$APP_BUNDLE/Contents/Frameworks/Sparkle.framework"
sparkle_started_ms="$(phase_now_ms)"
if [ -d "$SPARKLE" ]; then
  echo "Signing Sparkle framework and helpers"
  find "$SPARKLE" -type f -print0 | while IFS= read -r -d '' f; do
    if /usr/bin/file "$f" | /usr/bin/grep -q "Mach-O"; then
      sign_plain_item "$f"
    fi
  done
  sign_plain_item "$SPARKLE/Versions/B/Sparkle"
  sign_plain_item "$SPARKLE/Versions/B/Autoupdate"
  sign_plain_item "$SPARKLE/Versions/B/Updater.app/Contents/MacOS/Updater"
  sign_plain_item "$SPARKLE/Versions/B/Updater.app"
  sign_plain_item "$SPARKLE/Versions/B/XPCServices/Downloader.xpc/Contents/MacOS/Downloader"
  sign_plain_item "$SPARKLE/Versions/B/XPCServices/Downloader.xpc"
  sign_plain_item "$SPARKLE/Versions/B/XPCServices/Installer.xpc/Contents/MacOS/Installer"
  sign_plain_item "$SPARKLE/Versions/B/XPCServices/Installer.xpc"
  sign_plain_item "$SPARKLE/Versions/B"
  sign_plain_item "$SPARKLE"
fi
phase_log_elapsed "$sparkle_started_ms" "Sign Sparkle"

# Sign any other embedded frameworks/dylibs
frameworks_started_ms="$(phase_now_ms)"
if [ -d "$APP_BUNDLE/Contents/Frameworks" ]; then
  find "$APP_BUNDLE/Contents/Frameworks" \( -name "*.framework" -o -name "*.dylib" \) ! -path "*Sparkle.framework*" -print0 | while IFS= read -r -d '' f; do
    echo "Signing framework: $f"; sign_plain_item "$f"
  done
fi
phase_log_elapsed "$frameworks_started_ms" "Sign embedded frameworks"

# Sign the bundled Node runtime with JIT entitlements before the outer bundle
# signature lands. The runtime lives under Resources, so codesign does not
# reach these binaries unless we walk the tree explicitly.
runtime_node_started_ms="$(phase_now_ms)"
while IFS= read -r -d '' runtime_node; do
  if openclaw_file_is_macho "$runtime_node"; then
    echo "Signing runtime node binary with JIT entitlements: $runtime_node"
    sign_runtime_node_item "$runtime_node"
  fi
done < <(openclaw_runtime_node_binary_files "$APP_BUNDLE")
phase_log_elapsed "$runtime_node_started_ms" "Sign runtime node binaries"

# Sign the rest of the executable runtime payloads before the outer bundle
# signature lands. The runtime lives under Resources, so codesign does not
# reach these binaries unless we walk the tree explicitly.
runtime_payload_started_ms="$(phase_now_ms)"
while IFS= read -r -d '' runtime_file; do
  if openclaw_file_is_macho "$runtime_file"; then
    echo "Signing runtime payload: $runtime_file"
    sign_plain_item "$runtime_file"
  fi
done < <(openclaw_runtime_payload_files "$APP_BUNDLE")
phase_log_elapsed "$runtime_payload_started_ms" "Sign runtime payloads"

# Finally sign the bundle
bundle_sign_started_ms="$(phase_now_ms)"
sign_item "$APP_BUNDLE" "$APP_ENTITLEMENTS"
phase_log_elapsed "$bundle_sign_started_ms" "Sign app bundle"

team_audit_started_ms="$(phase_now_ms)"
verify_team_ids
phase_log_elapsed "$team_audit_started_ms" "Team ID audit"

rm -f "$ENT_TMP_BASE" "$ENT_TMP_APP_BASE" "$ENT_TMP_RUNTIME"
echo "Codesign complete for $APP_BUNDLE"
