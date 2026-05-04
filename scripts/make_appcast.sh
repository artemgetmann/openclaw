#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
ZIP=${1:?"Usage: $0 OpenClaw-<ver>.zip"}
APP_NAME=${SPARKLE_APP_NAME:-OpenClaw}
DEFAULT_FEED_URL="https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml"
FEED_URL=${SPARKLE_FEED_URL:-${2:-$DEFAULT_FEED_URL}}
PRIVATE_KEY_FILE=${SPARKLE_PRIVATE_KEY_FILE:-}
if [[ -z "$PRIVATE_KEY_FILE" ]]; then
  echo "Set SPARKLE_PRIVATE_KEY_FILE to your ed25519 private key (Sparkle)." >&2
  exit 1
fi
if [[ ! -f "$ZIP" ]]; then
  echo "Zip not found: $ZIP" >&2
  exit 1
fi

ZIP_DIR=$(cd "$(dirname "$ZIP")" && pwd)
ZIP_NAME=$(basename "$ZIP")
ZIP_BASE="${ZIP_NAME%.zip}"
VERSION=${SPARKLE_RELEASE_VERSION:-}
if [[ -z "$VERSION" ]]; then
  # Accept legacy calver suffixes like -1 and prerelease forms like -beta.1 / .beta.1.
  if [[ "$ZIP_NAME" =~ ^OpenClaw-([0-9]+(\.[0-9]+){1,2}([-.][0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?)\.zip$ ]]; then
    VERSION="${BASH_REMATCH[1]}"
  else
    echo "Could not infer version from $ZIP_NAME; set SPARKLE_RELEASE_VERSION." >&2
    exit 1
  fi
fi

TMP_DIR="$(mktemp -d)"
APPCAST_OUTPUT="${SPARKLE_APPCAST_OUTPUT:-}"
if [[ -z "$APPCAST_OUTPUT" ]]; then
  if [[ "$APP_NAME" == "OpenClaw" ]]; then
    APPCAST_OUTPUT="$ROOT/appcast.xml"
  else
    # Nonstandard artifact names depend on SPARKLE_RELEASE_VERSION. Keep the
    # generated appcast next to that artifact unless a release caller explicitly
    # targets the root appcast path.
    APPCAST_OUTPUT="$ZIP_DIR/appcast.xml"
  fi
fi
mkdir -p "$(dirname "$APPCAST_OUTPUT")"
APPCAST_OUTPUT_DIR=$(cd "$(dirname "$APPCAST_OUTPUT")" && pwd)
APPCAST_OUTPUT="$APPCAST_OUTPUT_DIR/$(basename "$APPCAST_OUTPUT")"
cleanup() {
  rm -rf "$TMP_DIR"
  if [[ "${KEEP_SPARKLE_NOTES:-0}" != "1" ]]; then
    rm -f "$NOTES_HTML"
  fi
}
trap cleanup EXIT
cp -f "$ZIP" "$TMP_DIR/$ZIP_NAME"
if [[ -f "$APPCAST_OUTPUT" ]]; then
  cp -f "$APPCAST_OUTPUT" "$TMP_DIR/appcast.xml"
fi

NOTES_HTML="${ZIP_DIR}/${ZIP_BASE}.html"
if [[ -x "$ROOT/scripts/changelog-to-html.sh" ]]; then
  "$ROOT/scripts/changelog-to-html.sh" "$VERSION" >"$NOTES_HTML"
else
  echo "Missing scripts/changelog-to-html.sh; cannot generate HTML release notes." >&2
  exit 1
fi
cp -f "$NOTES_HTML" "$TMP_DIR/${ZIP_BASE}.html"

DOWNLOAD_URL_PREFIX=${SPARKLE_DOWNLOAD_URL_PREFIX:-"https://github.com/openclaw/openclaw/releases/download/v${VERSION}/"}

export PATH="$ROOT/apps/macos/.build/artifacts/sparkle/Sparkle/bin:$PATH"
if ! command -v generate_appcast >/dev/null; then
  echo "generate_appcast not found in PATH. Build Sparkle tools via SwiftPM." >&2
  exit 1
fi

generate_appcast \
  --ed-key-file "$PRIVATE_KEY_FILE" \
  --download-url-prefix "$DOWNLOAD_URL_PREFIX" \
  --embed-release-notes \
  --link "$FEED_URL" \
  "$TMP_DIR"

GENERATED_APPCAST="$TMP_DIR/appcast.xml"
if [[ ! -f "$GENERATED_APPCAST" ]]; then
  GENERATED_APPCAST="$TMP_DIR/$(basename "$APPCAST_OUTPUT")"
fi
if [[ ! -f "$GENERATED_APPCAST" ]]; then
  echo "ERROR: Sparkle did not generate expected appcast output." >&2
  echo "Expected either:" >&2
  echo "  $TMP_DIR/appcast.xml" >&2
  echo "  $TMP_DIR/$(basename "$APPCAST_OUTPUT")" >&2
  exit 1
fi
cp -f "$GENERATED_APPCAST" "$APPCAST_OUTPUT"

echo "Appcast generated ($APPCAST_OUTPUT). Upload alongside $ZIP at $FEED_URL"
