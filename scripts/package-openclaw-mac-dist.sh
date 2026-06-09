#!/usr/bin/env bash
set -euo pipefail

# Build the main-built OpenClaw product app, verify its preserved consumer
# runtime identity, then package it as zip + DMG for distribution.
# Notarization/stapling are opt-in by credentials; local smoke packaging can
# still run with SKIP_NOTARIZE=1.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_ROOT="$ROOT_DIR/apps/macos/.build"
PRODUCT="OpenClaw"
source "$ROOT_DIR/scripts/lib/release-env.sh"
source "$ROOT_DIR/scripts/lib/consumer-instance.sh"

INSTANCE_ID="${OPENCLAW_CONSUMER_INSTANCE_ID:-}"
INSTANCE_EXPLICIT=0
PUBLISH_RELEASE_ASSETS=0
GITHUB_RELEASE_TAG=""
GITHUB_RELEASE_REPO="${GITHUB_RELEASE_REPO:-artemgetmann/openclaw}"
JARVIS_LATEST_RELEASE_DOWNLOAD_BASE="https://github.com/${GITHUB_RELEASE_REPO}/releases/latest/download"
JARVIS_DMG_PUBLIC_URL="${JARVIS_LATEST_RELEASE_DOWNLOAD_BASE}/Jarvis.dmg"
JARVIS_ZIP_PUBLIC_URL="${JARVIS_LATEST_RELEASE_DOWNLOAD_BASE}/Jarvis.zip"
JARVIS_APPCAST_PUBLIC_URL="${JARVIS_LATEST_RELEASE_DOWNLOAD_BASE}/jarvis-appcast.xml"

usage() {
  cat <<'EOF'
Usage: scripts/package-openclaw-mac-dist.sh [options]

Compatibility alias:
  scripts/package-consumer-mac-dist.sh

Options:
  --publish-release-assets
                      Upload Jarvis.dmg, Jarvis.zip, and jarvis-appcast.xml to
                      the latest artemgetmann/openclaw GitHub release, then
                      verify the public Sparkle feed before declaring sendable.
  --github-release-tag <tag>
                      Required with --publish-release-assets. Must match the
                      repo's latest release because Sparkle checks the public
                      releases/latest/download appcast feed.

Env:
  SKIP_NOTARIZE=1     Build release zip + DMG without notarization/stapling
  NOTARYTOOL_KEY=...  App Store Connect API key path outside the repo
  NOTARYTOOL_KEY_ID=...
  NOTARYTOOL_ISSUER=...
                      Recommended notarization auth; avoids Apple ID, 2FA, and
                      brittle Keychain profile state in release lanes
  NOTARYTOOL_PROFILE=...
                      Fallback notarytool Keychain profile
  SKIP_DSYM=1         Skip dSYM zip generation
  APP_VERSION=...     Override CFBundleShortVersionString
  APP_BUILD=...       Override CFBundleVersion
  OPENCLAW_CONSUMER_DIST_HANDOFF_DIR=/path
                      Copy final distributable artifacts there after packaging.
                      Defaults to the main checkout's dist/consumer-handoff
                      directory when run from a temp worktree.
                      Set to 0 to disable the handoff copy.
  SPARKLE_FEED_URL=...        Consumer-owned Sparkle appcast URL for release
  SPARKLE_PUBLIC_ED_KEY=...   Consumer Sparkle public EdDSA key
  SPARKLE_PRIVATE_KEY_FILE=...
                      Consumer Sparkle private EdDSA key file for appcast
                      generation on notarized release builds
  ALLOW_DEFAULT_SPARKLE_KEY_FOR_CONSUMER_SMOKE=1
                      Allow the generic development Sparkle key when
                      notarization is skipped for local smoke packaging only
  VERSIONED_ARTIFACT_NAMES=1
                      Opt into versioned zip/dmg filenames instead of the
                      clean handoff defaults

OpenClaw release packaging is intentionally default-instance only.
Use scripts/package-consumer-mac-app.sh --instance <id> for isolated tester/debug lanes.
EOF
}

notary_auth_configured() {
  if [[ -n "${NOTARYTOOL_KEY:-}" && -n "${NOTARYTOOL_KEY_ID:-}" && -n "${NOTARYTOOL_ISSUER:-}" ]]; then
    return 0
  fi
  if [[ -n "${NOTARYTOOL_PROFILE:-}" ]]; then
    return 0
  fi
  return 1
}

require_sparkle_private_key_file() {
  if [[ -z "${SPARKLE_PRIVATE_KEY_FILE:-}" ]]; then
    echo "ERROR: notarized Jarvis release packaging requires SPARKLE_PRIVATE_KEY_FILE." >&2
    echo "The appcast must be signed before a release can be sent." >&2
    exit 1
  fi

  if [[ ! -f "$SPARKLE_PRIVATE_KEY_FILE" || ! -r "$SPARKLE_PRIVATE_KEY_FILE" ]]; then
    echo "ERROR: SPARKLE_PRIVATE_KEY_FILE is missing or unreadable: $SPARKLE_PRIVATE_KEY_FILE" >&2
    exit 1
  fi
}

bundle_signing_authority() {
  local bundle_path="$1"
  /usr/bin/codesign -dv --verbose=4 "$bundle_path" 2>&1 \
    | /usr/bin/sed -n 's/^Authority=//p' \
    | /usr/bin/head -n 1
}

github_latest_release_tag() {
  local latest_json latest_tag
  latest_json="$(gh release view --repo "$GITHUB_RELEASE_REPO" --json tagName,url)"
  latest_tag="$(
    printf '%s\n' "$latest_json" \
      | /usr/bin/sed -n 's/.*"tagName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
      | /usr/bin/head -n 1
  )"

  if [[ -z "$latest_tag" ]]; then
    echo "ERROR: could not resolve the latest GitHub release tag for $GITHUB_RELEASE_REPO." >&2
    echo "$latest_json" >&2
    exit 1
  fi

  printf '%s\n' "$latest_tag"
}

require_latest_release_tag() {
  local latest_tag
  latest_tag="$(github_latest_release_tag)"
  if [[ "$latest_tag" != "$GITHUB_RELEASE_TAG" ]]; then
    echo "ERROR: --github-release-tag must match the latest release." >&2
    echo "Provided: $GITHUB_RELEASE_TAG" >&2
    echo "Latest:   $latest_tag" >&2
    echo "The app's feed URL uses releases/latest/download/jarvis-appcast.xml, so publishing to an older tag would lie to Sparkle." >&2
    exit 1
  fi
}

jarvis_tagged_release_download_base() {
  if [[ -z "$GITHUB_RELEASE_TAG" ]]; then
    echo "ERROR: a tagged Jarvis release URL requires --github-release-tag." >&2
    exit 1
  fi
  printf 'https://github.com/%s/releases/download/%s\n' "$GITHUB_RELEASE_REPO" "$GITHUB_RELEASE_TAG"
}

jarvis_appcast_zip_public_url() {
  if [[ -n "$GITHUB_RELEASE_TAG" ]]; then
    printf '%s/Jarvis.zip\n' "$(jarvis_tagged_release_download_base)"
    return 0
  fi
  printf '%s\n' "$JARVIS_ZIP_PUBLIC_URL"
}

require_release_publish_prereqs() {
  if [[ "$PUBLISH_RELEASE_ASSETS" != "1" ]]; then
    return 0
  fi

  if [[ "$NOTARIZE" != "1" ]]; then
    echo "ERROR: --publish-release-assets requires notarization." >&2
    echo "SKIP_NOTARIZE=1 is local smoke/dev packaging and must not publish." >&2
    exit 1
  fi

  if [[ -z "$GITHUB_RELEASE_TAG" ]]; then
    echo "ERROR: --publish-release-assets requires --github-release-tag <tag>." >&2
    exit 1
  fi

  if ! command -v gh >/dev/null 2>&1; then
    echo "ERROR: --publish-release-assets requires the GitHub CLI (gh)." >&2
    exit 1
  fi

  if ! gh auth status --hostname github.com >/dev/null 2>&1; then
    echo "ERROR: GitHub CLI is not authenticated for github.com." >&2
    exit 1
  fi

  require_latest_release_tag
  require_sparkle_private_key_file
}

consumer_sparkle_release_gate() {
  local default_key="AGCY8w5vHirVfGGDGc8Szc5iuOqupZSh9pMj/Qs67XI="
  local feed_url="${SPARKLE_FEED_URL:-}"
  local public_key="${SPARKLE_PUBLIC_ED_KEY:-$default_key}"

  if [[ "$public_key" == "$default_key" && "${ALLOW_DEFAULT_SPARKLE_KEY_FOR_CONSUMER_SMOKE:-0}" != "1" ]]; then
    echo "ERROR: consumer packaging is using the generic Sparkle public key." >&2
    echo "Set SPARKLE_PUBLIC_ED_KEY to the consumer key for release packaging." >&2
    echo "For local smoke packaging only, set ALLOW_DEFAULT_SPARKLE_KEY_FOR_CONSUMER_SMOKE=1." >&2
    exit 1
  fi

  if [[ "$NOTARIZE" != "1" ]]; then
    if [[ "$public_key" == "$default_key" ]]; then
      echo "WARN: consumer smoke packaging is intentionally using the generic Sparkle public key." >&2
    fi
    return 0
  fi

  if [[ -z "$feed_url" ]]; then
    echo "ERROR: notarized consumer packaging requires SPARKLE_FEED_URL." >&2
    echo "Use a consumer-owned Sparkle appcast URL, or rerun with SKIP_NOTARIZE=1 for local smoke packaging." >&2
    exit 1
  fi

  if [[ "$feed_url" == "https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml" ]]; then
    echo "ERROR: consumer release packaging must not use the generic OpenClaw appcast." >&2
    echo "Set SPARKLE_FEED_URL to a consumer-owned feed." >&2
    exit 1
  fi

  if [[ "$feed_url" != "$JARVIS_APPCAST_PUBLIC_URL" ]]; then
    echo "ERROR: notarized Jarvis release packaging requires the public Jarvis appcast feed." >&2
    echo "Expected: $JARVIS_APPCAST_PUBLIC_URL" >&2
    echo "Actual:   $feed_url" >&2
    exit 1
  fi

  if [[ "$public_key" == "$default_key" ]]; then
    echo "ERROR: notarized consumer packaging requires a consumer Sparkle public key." >&2
    echo "Set SPARKLE_PUBLIC_ED_KEY to the production consumer key." >&2
    echo "The generic development key is only allowed for smoke packaging with SKIP_NOTARIZE=1." >&2
    exit 1
  fi
}

generate_jarvis_appcast() {
  if [[ "$NOTARIZE" != "1" ]]; then
    return 0
  fi

  require_sparkle_private_key_file

  local appcast="$ROOT_DIR/dist/jarvis-appcast.xml"
  local zip_download_base="$JARVIS_LATEST_RELEASE_DOWNLOAD_BASE"
  if [[ -n "$GITHUB_RELEASE_TAG" ]]; then
    # Sparkle signs the exact ZIP bytes listed in the appcast. The appcast
    # itself can live at latest/download, but the enclosure must be immutable;
    # otherwise a later release can make old appcasts validate the wrong ZIP.
    zip_download_base="$(jarvis_tagged_release_download_base)"
  fi
  echo "✨ Appcast: $appcast"
  SPARKLE_APP_NAME="$APP_NAME" \
  SPARKLE_RELEASE_VERSION="$VERSION" \
  SPARKLE_APPCAST_OUTPUT="$appcast" \
  SPARKLE_DOWNLOAD_URL_PREFIX="${zip_download_base}/" \
    "$ROOT_DIR/scripts/make_appcast.sh" "$ZIP" "$SPARKLE_FEED_URL"
}

verify_dmg_gatekeeper() {
  local dmg_path="$1"
  if [[ "$NOTARIZE" != "1" ]]; then
    return 0
  fi

  # `notarytool` proves Apple's service accepted the artifact; `spctl` proves
  # the exact local DMG now carries a Gatekeeper-accepted signature/staple.
  local spctl_output
  set +e
  spctl_output="$(
    /usr/sbin/spctl -a -vv -t open --context context:primary-signature "$dmg_path" 2>&1
  )"
  local spctl_status=$?
  set -e

  if [[ $spctl_status -ne 0 ]]; then
    echo "ERROR: release DMG failed Gatekeeper verification." >&2
    echo "spctl output: ${spctl_output//$'\n'/ | }" >&2
    exit 1
  fi

  echo "✅ DMG Gatekeeper accepted: ${spctl_output//$'\n'/ | }"
}

publish_release_assets() {
  if [[ "$PUBLISH_RELEASE_ASSETS" != "1" ]]; then
    return 0
  fi

  local appcast="$ROOT_DIR/dist/jarvis-appcast.xml"
  require_latest_release_tag

  for artifact in "$DMG" "$ZIP" "$appcast"; do
    if [[ ! -f "$artifact" ]]; then
      echo "ERROR: release asset missing before upload: $artifact" >&2
      exit 1
    fi
  done

  echo "🚀 Uploading Jarvis release assets to $GITHUB_RELEASE_REPO@$GITHUB_RELEASE_TAG"
  gh release upload "$GITHUB_RELEASE_TAG" "$DMG" "$ZIP" "$appcast" \
    --repo "$GITHUB_RELEASE_REPO" \
    --clobber

  "$ROOT_DIR/scripts/verify-jarvis-release-assets.mjs" \
    --app-path "$APP_PATH" \
    --zip-path "$ZIP" \
    --dmg-url "$JARVIS_DMG_PUBLIC_URL" \
    --zip-url "$(jarvis_appcast_zip_public_url)" \
    --appcast-url "$JARVIS_APPCAST_PUBLIC_URL"
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

canonical_checkout_root() {
  local common_dir
  common_dir="$(git -C "$ROOT_DIR" rev-parse --git-common-dir 2>/dev/null || true)"
  if [[ -n "$common_dir" ]]; then
    if [[ "$common_dir" != /* ]]; then
      common_dir="$ROOT_DIR/$common_dir"
    fi
    common_dir="$(cd "$common_dir" && pwd -P)"
    if [[ "$(basename "$common_dir")" == ".git" ]]; then
      dirname "$common_dir"
      return 0
    fi
  fi

  printf '%s\n' "$ROOT_DIR"
}

default_handoff_dir() {
  local checkout_root
  checkout_root="$(canonical_checkout_root)"
  printf '%s\n' "$checkout_root/dist/consumer-handoff"
}

copy_handoff_artifacts() {
  local handoff_dir
  if [[ -n "${OPENCLAW_CONSUMER_DIST_HANDOFF_DIR:-}" ]]; then
    handoff_dir="$OPENCLAW_CONSUMER_DIST_HANDOFF_DIR"
  else
    handoff_dir="$(default_handoff_dir)"
  fi

  if [[ "$handoff_dir" == "0" || "$handoff_dir" == "false" ]]; then
    echo "📤 Handoff artifacts: skipped"
    return 0
  fi

  mkdir -p "$handoff_dir"

  local copied=()
  local artifact
  for artifact in "$DMG" "$ZIP" "$DSYM_ZIP"; do
    if [[ -f "$artifact" ]]; then
      rm -f "$handoff_dir/$(basename "$artifact")"
      cp -f "$artifact" "$handoff_dir/"
      copied+=("$handoff_dir/$(basename "$artifact")")
    fi
  done

  echo "📤 Handoff artifacts:"
  if [[ "${#copied[@]}" -eq 0 ]]; then
    echo "  none copied"
  else
    printf '  %s\n' "${copied[@]}"
  fi
  echo "  app_bundle=$APP_PATH"
  echo "  app_bundle_handoff=not copied (use dmg/zip for distribution)"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --publish-release-assets)
      PUBLISH_RELEASE_ASSETS=1
      shift
      ;;
    --github-release-tag)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --github-release-tag requires a value" >&2
        exit 1
      fi
      GITHUB_RELEASE_TAG="$2"
      shift 2
      ;;
    --instance)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --instance requires a value" >&2
        exit 1
      fi
      INSTANCE_ID="$2"
      INSTANCE_EXPLICIT=1
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

NORMALIZED_INSTANCE_ID="$(consumer_instance_normalize_id "$INSTANCE_ID")"
# Release/demo artifacts must stay on the default consumer identity. Named
# instances are for parallel tester lanes and would leak worktree/debug slugs
# into the shipped bundle id plus runtime support paths.
if [[ -n "$NORMALIZED_INSTANCE_ID" ]]; then
  echo "ERROR: consumer distribution packaging must use the stable default release identity." >&2
  if [[ "$INSTANCE_EXPLICIT" == "1" ]]; then
      echo "Do not pass --instance to scripts/package-openclaw-mac-dist.sh." >&2
  else
    echo "Unset OPENCLAW_CONSUMER_INSTANCE_ID before running scripts/package-openclaw-mac-dist.sh." >&2
  fi
  echo "Use scripts/package-consumer-mac-app.sh --instance <id> for isolated tester/debug lanes." >&2
  echo "Leaking a worktree or lane slug into a release artifact would change bundle/runtime identity." >&2
  exit 1
fi

# Release packaging now ships the consumer product under the final visible
# product name while preserving the existing consumer bundle id/runtime identity.
# That lets replacement installs keep state and permissions continuity instead
# of turning a cosmetic rename into a new-app migration.
APP_NAME="${APP_NAME:-Jarvis}"
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

consumer_sparkle_release_gate
require_release_publish_prereqs
if [[ "$NOTARIZE" == "1" ]]; then
  require_sparkle_private_key_file
fi

# Stale release artifacts under dist/ can get copied into the bundled runtime
# before the fresh app is assembled. Remove only mac release outputs here; JS
# build outputs under dist/ are still needed by the packaged CLI/runtime.
rm -f \
  "$ROOT_DIR"/dist/"$APP_NAME"*.zip \
  "$ROOT_DIR"/dist/"$APP_NAME"*.dmg \
  "$ROOT_DIR"/dist/"$PRODUCT"*.dSYM.zip \
  "$ROOT_DIR"/dist/*appcast*.xml

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
APP_NAME="$APP_NAME" \
  "$ROOT_DIR/scripts/verify-consumer-mac-app.sh" "${VERIFY_ARGS[@]}" "$APP_PATH"

VERSION=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$APP_PATH/Contents/Info.plist" 2>/dev/null || echo "0.0.0")
ARTIFACT_BASENAME="${APP_NAME}"
if [[ "${VERSIONED_ARTIFACT_NAMES:-0}" == "1" ]]; then
  # Clean filenames are the default for human handoff because most consumer
  # drops are shared directly, not archived in a formal release bucket. Keep
  # the old versioned naming available for agents that explicitly want it.
  ARTIFACT_BASENAME="${APP_NAME}-${VERSION}"
fi

ZIP="$ROOT_DIR/dist/${ARTIFACT_BASENAME}.zip"
DMG="$ROOT_DIR/dist/${ARTIFACT_BASENAME}.dmg"
NOTARY_ZIP="$ROOT_DIR/dist/${APP_NAME}-${VERSION}.notary.zip"
DSYM_ZIP="$ROOT_DIR/dist/${PRODUCT}-${VERSION}.dSYM.zip"
SIGNING_AUTHORITY="$(bundle_signing_authority "$APP_PATH")"

# Remove stale artifacts before building new ones. DMG assembly temporarily
# needs a copied app bundle plus a writable image; keeping an old zip beside it
# is enough to trip low-disk developer machines.
rm -f "$ZIP" "$DMG" "${DMG%.dmg}-rw.dmg"

if [[ "$NOTARIZE" == "1" ]]; then
  if [[ "$SIGNING_AUTHORITY" != Developer\ ID\ Application:* ]]; then
    echo "ERROR: notarization requires a Developer ID Application signature." >&2
    echo "Current signing authority: ${SIGNING_AUTHORITY:-unknown}" >&2
    echo "Use a Developer ID Application certificate, or rerun with SKIP_NOTARIZE=1 for local smoke packaging." >&2
    exit 1
  fi
  if ! notary_auth_configured; then
    echo "ERROR: notary auth missing. Set NOTARYTOOL_KEY/NOTARYTOOL_KEY_ID/NOTARYTOOL_ISSUER or fallback NOTARYTOOL_PROFILE." >&2
    exit 1
  fi
fi

if [[ "$NOTARIZE" == "1" ]]; then
  echo "📦 Notary zip: $NOTARY_ZIP"
  rm -f "$NOTARY_ZIP"
  ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$NOTARY_ZIP"
  STAPLE_APP_PATH="$APP_PATH" "$ROOT_DIR/scripts/notarize-mac-artifact.sh" "$NOTARY_ZIP"
  rm -f "$NOTARY_ZIP"
  BUNDLE_ID="$EXPECTED_BUNDLE_ID" \
  APP_NAME="$APP_NAME" \
  OPENCLAW_CONSUMER_VERIFY_RELEASE=1 \
  SPARKLE_EXPECTED_PUBLIC_ED_KEY="${SPARKLE_PUBLIC_ED_KEY:-}" \
    "$ROOT_DIR/scripts/verify-consumer-mac-app.sh" "${VERIFY_ARGS[@]}" "$APP_PATH"
fi

echo "💿 DMG: $DMG"
"$ROOT_DIR/scripts/create-dmg.sh" "$APP_PATH" "$DMG"
sign_dmg_if_possible "$DMG" "$SIGNING_AUTHORITY"

if [[ "$NOTARIZE" == "1" ]]; then
  "$ROOT_DIR/scripts/notarize-mac-artifact.sh" "$DMG"
  verify_dmg_gatekeeper "$DMG"
fi

echo "📦 Zip: $ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$ZIP"
generate_jarvis_appcast

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

copy_handoff_artifacts
publish_release_assets

echo "OpenClaw distribution package ready:"
echo "  app=$APP_PATH"
echo "  zip=$ZIP"
echo "  dmg=$DMG"
if [[ -f "$ROOT_DIR/dist/jarvis-appcast.xml" ]]; then
  echo "  appcast=$ROOT_DIR/dist/jarvis-appcast.xml"
fi
echo "  handoff_dir=${OPENCLAW_CONSUMER_DIST_HANDOFF_DIR:-$(default_handoff_dir)}"
echo "  app_version=$VERSION"
echo "  signing_authority=${SIGNING_AUTHORITY:-unknown}"
if [[ "$NOTARIZE" == "1" ]]; then
  echo "  notarization=completed"
else
  echo "  notarization=skipped (set SKIP_NOTARIZE=0 with Developer ID + notary auth to submit/staple)"
fi
if [[ "$PUBLISH_RELEASE_ASSETS" == "1" ]]; then
  echo "release_sendable=true"
  echo "sparkle_update_live=true"
elif [[ "$NOTARIZE" == "1" ]]; then
  echo "release_sendable=false"
  echo "reason=Sparkle assets were generated locally but not uploaded/verified"
else
  echo "release_sendable=false"
  echo "reason=SKIP_NOTARIZE=1 is local smoke/dev packaging and does not publish"
fi
