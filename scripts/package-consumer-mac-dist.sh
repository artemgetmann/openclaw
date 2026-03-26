#!/usr/bin/env bash
set -euo pipefail

# Build a release-flavored consumer app, verify its consumer identity, then
# package it as zip + DMG for demo distribution. Notarization/stapling are
# opt-in by credentials; local smoke packaging can still run with SKIP_NOTARIZE=1.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_ROOT="$ROOT_DIR/apps/macos/.build"
PRODUCT="OpenClaw"
source "$ROOT_DIR/scripts/lib/consumer-instance.sh"

INSTANCE_ID="${OPENCLAW_CONSUMER_INSTANCE_ID:-}"

usage() {
  cat <<'EOF'
Usage: scripts/package-consumer-mac-dist.sh [--instance <id>]

Env:
  SKIP_NOTARIZE=1     Build release zip + DMG without notarization/stapling
  SKIP_DSYM=1         Skip dSYM zip generation
  APP_VERSION=...     Override CFBundleShortVersionString
  APP_BUILD=...       Override CFBundleVersion
EOF
}

notary_auth_configured() {
  if [[ -n "${NOTARYTOOL_PROFILE:-}" ]]; then
    return 0
  fi
  if [[ -n "${NOTARYTOOL_KEY:-}" && -n "${NOTARYTOOL_KEY_ID:-}" && -n "${NOTARYTOOL_ISSUER:-}" ]]; then
    return 0
  fi
  return 1
}

bundle_signing_authority() {
  local bundle_path="$1"
  /usr/bin/codesign -dv --verbose=4 "$bundle_path" 2>&1 \
    | /usr/bin/sed -n 's/^Authority=//p' \
    | /usr/bin/head -n 1
}

sign_dmg_if_possible() {
  local dmg_path="$1"
  local signing_authority="$2"
  if [[ -z "$signing_authority" ]]; then
    return 0
  fi

  local timestamp_arg="--timestamp=none"
  if [[ "$signing_authority" == Developer\ ID\ Application:* ]]; then
    timestamp_arg="--timestamp"
  fi

  echo "🔏 Signing DMG: $dmg_path"
  /usr/bin/codesign --force --sign "$signing_authority" "$timestamp_arg" "$dmg_path"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --instance requires a value" >&2
        exit 1
      fi
      INSTANCE_ID="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$INSTANCE_ID" ]]; then
  INSTANCE_ID="$(consumer_instance_default_id_for_checkout "$ROOT_DIR")"
fi

NORMALIZED_INSTANCE_ID="$(consumer_instance_normalize_id "$INSTANCE_ID")"
if [[ -z "$NORMALIZED_INSTANCE_ID" ]]; then
  CURRENT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  CANONICAL_CONSUMER_CHECKOUT="/Users/user/Programming_Projects/openclaw-consumer-openclaw-project"
  if [[ "$CURRENT_ROOT" != "$CANONICAL_CONSUMER_CHECKOUT" ]]; then
    echo "ERROR: default consumer distribution packaging is reserved for the main consumer checkout." >&2
    echo "Use --instance <id> from worktrees so you do not collide with the shared consumer runtime." >&2
    echo "Expected checkout: $CANONICAL_CONSUMER_CHECKOUT" >&2
    echo "Current checkout: ${CURRENT_ROOT:-unknown}" >&2
    exit 1
  fi
fi

APP_NAME="${APP_NAME:-$(consumer_instance_app_name "$NORMALIZED_INSTANCE_ID")}"
APP_BUNDLE_NAME="${APP_BUNDLE_NAME:-${APP_NAME}.app}"
APP_PATH="$ROOT_DIR/dist/${APP_BUNDLE_NAME}"
EXPECTED_BUNDLE_ID="${BUNDLE_ID:-$(consumer_instance_release_bundle_id "$NORMALIZED_INSTANCE_ID")}"
EXPECTED_VARIANT="consumer"
EXPECTED_URL_SCHEME="${URL_SCHEME:-openclaw-consumer}"
VERIFY_ARGS=()

BUILD_CONFIG="${BUILD_CONFIG:-release}"
BUILD_ARCHS="${BUILD_ARCHS:-all}"
SKIP_NOTARIZE="${SKIP_NOTARIZE:-0}"
SKIP_DSYM="${SKIP_DSYM:-0}"
NOTARIZE=1
if [[ "$SKIP_NOTARIZE" == "1" ]]; then
  NOTARIZE=0
fi

APP_NAME="$APP_NAME" \
APP_BUNDLE_NAME="$APP_BUNDLE_NAME" \
BUNDLE_ID="$EXPECTED_BUNDLE_ID" \
APP_VARIANT="$EXPECTED_VARIANT" \
APP_INSTANCE_ID="$NORMALIZED_INSTANCE_ID" \
URL_SCHEME="$EXPECTED_URL_SCHEME" \
BUILD_CONFIG="$BUILD_CONFIG" \
BUILD_ARCHS="$BUILD_ARCHS" \
"$ROOT_DIR/scripts/package-mac-app.sh"

if [[ -n "$NORMALIZED_INSTANCE_ID" ]]; then
  VERIFY_ARGS+=(--instance "$NORMALIZED_INSTANCE_ID")
fi

BUNDLE_ID="$EXPECTED_BUNDLE_ID" \
  "$ROOT_DIR/scripts/verify-consumer-mac-app.sh" "${VERIFY_ARGS[@]}" "$APP_PATH"

VERSION=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$APP_PATH/Contents/Info.plist" 2>/dev/null || echo "0.0.0")
ZIP="$ROOT_DIR/dist/${APP_NAME}-${VERSION}.zip"
DMG="$ROOT_DIR/dist/${APP_NAME}-${VERSION}.dmg"
NOTARY_ZIP="$ROOT_DIR/dist/${APP_NAME}-${VERSION}.notary.zip"
DSYM_ZIP="$ROOT_DIR/dist/${PRODUCT}-${VERSION}.dSYM.zip"
SIGNING_AUTHORITY="$(bundle_signing_authority "$APP_PATH")"

if [[ "$NOTARIZE" == "1" ]]; then
  if [[ "$SIGNING_AUTHORITY" != Developer\ ID\ Application:* ]]; then
    echo "ERROR: notarization requires a Developer ID Application signature." >&2
    echo "Current signing authority: ${SIGNING_AUTHORITY:-unknown}" >&2
    echo "Use a Developer ID Application certificate, or rerun with SKIP_NOTARIZE=1 for local smoke packaging." >&2
    exit 1
  fi
  if ! notary_auth_configured; then
    echo "ERROR: notary auth missing. Set NOTARYTOOL_PROFILE or NOTARYTOOL_KEY/NOTARYTOOL_KEY_ID/NOTARYTOOL_ISSUER." >&2
    exit 1
  fi
fi

if [[ "$NOTARIZE" == "1" ]]; then
  echo "📦 Notary zip: $NOTARY_ZIP"
  rm -f "$NOTARY_ZIP"
  ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$NOTARY_ZIP"
  STAPLE_APP_PATH="$APP_PATH" "$ROOT_DIR/scripts/notarize-mac-artifact.sh" "$NOTARY_ZIP"
  rm -f "$NOTARY_ZIP"
fi

echo "📦 Zip: $ZIP"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$ZIP"

echo "💿 DMG: $DMG"
"$ROOT_DIR/scripts/create-dmg.sh" "$APP_PATH" "$DMG"
sign_dmg_if_possible "$DMG" "$SIGNING_AUTHORITY"

if [[ "$NOTARIZE" == "1" ]]; then
  "$ROOT_DIR/scripts/notarize-mac-artifact.sh" "$DMG"
fi

if [[ "$SKIP_DSYM" != "1" ]]; then
  DSYM_ARM64="$(find "$BUILD_ROOT/arm64" -type d -path "*/$BUILD_CONFIG/$PRODUCT.dSYM" -print -quit)"
  DSYM_X86="$(find "$BUILD_ROOT/x86_64" -type d -path "*/$BUILD_CONFIG/$PRODUCT.dSYM" -print -quit)"
  if [[ -n "$DSYM_ARM64" || -n "$DSYM_X86" ]]; then
    TMP_DSYM="$ROOT_DIR/dist/$PRODUCT.dSYM"
    rm -rf "$TMP_DSYM"
    if [[ -n "$DSYM_ARM64" && -n "$DSYM_X86" ]]; then
      cp -R "$DSYM_ARM64" "$TMP_DSYM"
      DWARF_OUT="$TMP_DSYM/Contents/Resources/DWARF/$PRODUCT"
      DWARF_ARM="$DSYM_ARM64/Contents/Resources/DWARF/$PRODUCT"
      DWARF_X86="$DSYM_X86/Contents/Resources/DWARF/$PRODUCT"
      if [[ -f "$DWARF_ARM" && -f "$DWARF_X86" ]]; then
        /usr/bin/lipo -create "$DWARF_ARM" "$DWARF_X86" -output "$DWARF_OUT"
      else
        echo "WARN: Missing DWARF binaries for dSYM merge (continuing)" >&2
      fi
    else
      cp -R "${DSYM_ARM64:-$DSYM_X86}" "$TMP_DSYM"
    fi
    echo "🧩 dSYM: $DSYM_ZIP"
    rm -f "$DSYM_ZIP"
    ditto -c -k --keepParent "$TMP_DSYM" "$DSYM_ZIP"
    rm -rf "$TMP_DSYM"
  else
    echo "WARN: dSYM not found; skipping zip (set SKIP_DSYM=1 to silence)" >&2
  fi
fi

echo "Consumer distribution package ready:"
echo "  app=$APP_PATH"
echo "  zip=$ZIP"
echo "  dmg=$DMG"
echo "  signing_authority=${SIGNING_AUTHORITY:-unknown}"
if [[ "$NOTARIZE" == "1" ]]; then
  echo "  notarization=completed"
else
  echo "  notarization=skipped (set SKIP_NOTARIZE=0 with Developer ID + notary auth to submit/staple)"
fi
