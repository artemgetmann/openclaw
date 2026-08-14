#!/usr/bin/env bash
set -euo pipefail

# Build the main-built OpenClaw product app, verify its preserved consumer
# runtime identity, then package it as zip + DMG for distribution.
# Notarization/stapling are opt-in by credentials; local smoke packaging can
# still run with SKIP_NOTARIZE=1.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_ROOT="$ROOT_DIR/apps/macos/.build"
PRODUCT="OpenClaw"
# The public wrapper computes this digest from parsed action flags. Preserve it
# across release.env loading so the credential/settings file cannot
# accidentally replace wrapper-to-package authorization context.
INHERITED_RELEASE_ACTION_FINGERPRINT="${OPENCLAW_JARVIS_RELEASE_INTENT_ACTION_FINGERPRINT:-}"
source "$ROOT_DIR/scripts/lib/release-env.sh"
export OPENCLAW_JARVIS_RELEASE_INTENT_ACTION_FINGERPRINT="$INHERITED_RELEASE_ACTION_FINGERPRINT"
source "$ROOT_DIR/scripts/lib/consumer-instance.sh"
source "$ROOT_DIR/scripts/lib/build-artifacts.sh"
source "$ROOT_DIR/scripts/lib/github-release-upload-preflight.sh"
source "$ROOT_DIR/scripts/lib/jarvis-release-disk-preflight.sh"
source "$ROOT_DIR/scripts/lib/jarvis-release-orchestration.sh"
source "$ROOT_DIR/scripts/lib/macos-release-gates.sh"
source "$ROOT_DIR/scripts/lib/shared-resource-lock.sh"
source "$ROOT_DIR/scripts/lib/jarvis-release-lock.sh"
source "$ROOT_DIR/scripts/lib/jarvis-release-intent.sh"
source "$ROOT_DIR/scripts/lib/jarvis-release-checkpoint.sh"

INSTANCE_ID="${OPENCLAW_CONSUMER_INSTANCE_ID:-}"
INSTANCE_EXPLICIT=0
PUBLISH_RELEASE_ASSETS=0
GITHUB_RELEASE_TAG=""
PACKAGE_PHASE="full"
RELEASE_RUN_ROOT=""
OPENCLAW_CONSUMER_FAST_PACKAGING="${OPENCLAW_CONSUMER_FAST_PACKAGING:-0}"
OPENCLAW_CONSUMER_CLEAN_GIT_RUNTIME_CACHE="${OPENCLAW_CONSUMER_CLEAN_GIT_RUNTIME_CACHE:-0}"
GITHUB_RELEASE_REPO="${GITHUB_RELEASE_REPO:-artemgetmann/openclaw}"
JARVIS_LATEST_RELEASE_DOWNLOAD_BASE="https://github.com/${GITHUB_RELEASE_REPO}/releases/latest/download"
JARVIS_DMG_PUBLIC_URL="${JARVIS_LATEST_RELEASE_DOWNLOAD_BASE}/Jarvis.dmg"
JARVIS_ZIP_PUBLIC_URL="${JARVIS_LATEST_RELEASE_DOWNLOAD_BASE}/Jarvis.zip"
JARVIS_APPCAST_PUBLIC_URL="${JARVIS_LATEST_RELEASE_DOWNLOAD_BASE}/jarvis-appcast.xml"
RELEASE_MANIFEST_PATH="${OPENCLAW_JARVIS_RELEASE_MANIFEST:-$ROOT_DIR/dist/jarvis-release-manifest.env}"
RELEASE_TIMING_REPORT_PATH="${OPENCLAW_JARVIS_RELEASE_TIMING_REPORT:-$ROOT_DIR/dist/jarvis-release-timing.tsv}"
RELEASE_INTENT_ID=""
ORIGINAL_PACKAGE_ARGS=("$@")

quote_package_command() {
  local arg
  printf 'bash %q ' "scripts/package-openclaw-mac-dist.sh"
  for arg in "${ORIGINAL_PACKAGE_ARGS[@]}"; do
    printf '%q ' "$arg"
  done
  printf '\n'
}

release_package_exit() {
  local status="$?"
  openclaw_jarvis_release_lock_release
  if [[ "$status" -ne 0 && "${OPENCLAW_JARVIS_RELEASE_RECOVERY_OWNER:-package}" != "wrapper" ]]; then
    case "${OPENCLAW_JARVIS_RELEASE_INTENT_FAILURE:-}" in
      missing|expired|replaced|commit|identity|schema|action|action-schema|tracked-state-drift|tracked-state-unavailable)
        echo "recovery_command=bash scripts/jarvis-public-release.sh --authorize" >&2
        ;;
      *)
        if [[ -n "${OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE:-}" ]]; then
          # A forced direct resume cannot repair a rejected checkpoint. Return
          # to automatic phase selection under the same still-valid intent.
          echo "recovery_command=bash scripts/jarvis-public-release.sh --release-intent $RELEASE_INTENT_ID" >&2
        else
          echo "recovery_command=$(quote_package_command)" >&2
        fi
        ;;
    esac
  fi
  exit "$status"
}

usage() {
  cat <<'EOF'
Usage: scripts/package-openclaw-mac-dist.sh [options]

Compatibility alias:
  scripts/package-consumer-mac-dist.sh

Options:
  --release-intent <id>
                      Required expiring authorization created by
                      jarvis-public-release.sh --authorize. Direct package
                      execution is not authorized by artifact existence.
  --publish-release-assets
                      Upload Jarvis.dmg, Jarvis.zip, and jarvis-appcast.xml to
                      the latest artemgetmann/openclaw GitHub release, then
                      verify the public Sparkle feed before declaring sendable.
  --github-release-tag <tag>
                      Required with --publish-release-assets. Must match the
                      repo's latest release because Sparkle checks the public
                      releases/latest/download appcast feed.
  --phase <full|local-proof|post-app-build|build-app-only|submit-app-notarization|poll-app-notarization|submit-dmg-notarization|poll-dmg-notarization|create-local-release-assets-only|publish-assets-only|verify-public-assets-only|publish-sparkle-assets-only|verify-sparkle-assets-only|trusted-ring-fast>
                      full is the default one-shot lane. post-app-build resumes
                      from an existing dist/Jarvis.app and runs the release tail.
                      local-proof builds and verifies dist/Jarvis.app, writes
                      the manifest/receipt, and stops before distribution work.
                      Narrow phases resume failed tails from saved artifacts,
                      receipts, and dist/jarvis-release-manifest.env.
                      create-local-release-assets-only creates Jarvis.zip and
                      jarvis-appcast.xml from an existing accepted Jarvis.app
                      without rebuilding, notarizing, stapling, uploading, or
                      verifying public URLs.
                      publish-sparkle-assets-only uploads and verifies only
                      Jarvis.zip plus jarvis-appcast.xml after accepted app
                      notarization. It intentionally does not upload Jarvis.dmg
                      or claim a fresh-install/sendable release.
  --resume-after-app-build
                      Alias for --phase post-app-build.
  --local-proof
                      Alias for --phase local-proof. Builds the signed Jarvis
                      app with local proof defaults, verifies the stable release
                      identity and bundled runtime version, records metadata,
                      then skips DMG, ZIP, appcast, notary, publish, install,
                      launchd, and shared runtime changes.
  --trusted-ring-fast
                      Alias for --phase trusted-ring-fast. Builds local trusted
                      tester artifacts and skips notarization, dSYM, publishing,
                      and public release verification.

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
  ALLOW_SLOW_RELEASE_UPLOAD=1
                      Allow an intentional slow/tunnel GitHub release upload
                      route after the preflight prints the risk
  ALLOW_COLD_RELEASE_LANE=1
                      Emergency-only bypass for the macOS prewarm proof gate.
                      Normal app-building phases must first run:
                      bash scripts/prewarm-worktree.sh --root "$PWD" --macos
                      This does not bypass the blessed release-worktree guard.
  ALLOW_NON_INCREMENTAL_SPARKLE_BUILD=1
                      Emergency-only bypass when the built marketing version
                      or CFBundleVersion fails comparison with
                      /Applications/Jarvis.app

OpenClaw release packaging is intentionally default-instance only.
Use scripts/package-consumer-mac-app.sh --instance <id> for isolated tester/debug lanes.
EOF
}

release_run_root() {
  if [[ -z "$RELEASE_RUN_ROOT" ]]; then
    RELEASE_RUN_ROOT="${OPENCLAW_RELEASE_ARTIFACT_RUN_ROOT:-$(openclaw_build_run_root "jarvis-release")}"
  fi
  printf '%s\n' "$RELEASE_RUN_ROOT"
}

release_staging_preflight_path() {
  if [[ -n "${OPENCLAW_RELEASE_ARTIFACT_RUN_ROOT:-}" ]]; then
    # An explicit run root may live on another volume. Probe the exact path the
    # operator selected without creating it before capacity is established.
    printf '%s\n' "$OPENCLAW_RELEASE_ARTIFACT_RUN_ROOT"
    return 0
  fi

  # openclaw_build_run_root creates its unique child below runs/. Probe that
  # parent now; calling release_run_root here would mutate the filesystem.
  printf '%s/runs\n' "$(openclaw_build_artifact_root)"
}

package_phase_creates_heavy_local_artifacts() {
  case "$1" in
    full|local-proof|post-app-build|build-app-only|submit-app-notarization|submit-dmg-notarization|create-local-release-assets-only|trusted-ring-fast)
      return 0
      ;;
    poll-app-notarization|poll-dmg-notarization|publish-assets-only|verify-public-assets-only|publish-sparkle-assets-only|verify-sparkle-assets-only)
      return 1
      ;;
    *)
      echo "ERROR: unknown package phase for disk preflight: $1" >&2
      return 2
      ;;
  esac
}

require_release_disk_preflight() {
  local post_write_floor_kib
  local expected_write_reserve_kib
  local staging_path
  local package_temp_path="${TMPDIR:-/tmp}"

  post_write_floor_kib="${JARVIS_RELEASE_DISK_POST_WRITE_FLOOR_KIB:-$(jarvis_release_disk_post_write_floor_kib)}"
  expected_write_reserve_kib="${JARVIS_RELEASE_DISK_EXPECTED_WRITE_RESERVE_KIB:-$(jarvis_release_disk_full_release_reserve_kib)}"
  staging_path="$(release_staging_preflight_path)"

  # Preserve the helper's complete multi-target report on stdout. Operators
  # need each target, filesystem, free-space, shortfall, and final status line.
  JARVIS_RELEASE_DISK_BEFORE_CLEANUP_FUNCTION=require_release_disk_cleanup_authorization \
    jarvis_release_disk_ensure_operation_capacity "$ROOT_DIR" \
    full-signed-notarized-release "$post_write_floor_kib" "$expected_write_reserve_kib" \
    release-output "$ROOT_DIR/dist" \
    release-staging "$staging_path" \
    package-temp "$package_temp_path" \
    dmg-temp /tmp
}

require_release_disk_cleanup_authorization() {
  # The initial intent check authorizes the read-only scan. Revalidate after
  # those probes and immediately before automatic cleanup mutates host caches.
  openclaw_require_jarvis_release_intent \
    "$ROOT_DIR" "$RELEASE_INTENT_ID" "release disk cleanup"
}

release_phase_now_ms() {
  /usr/bin/perl -MTime::HiRes=time -e 'printf "%d", time() * 1000'
}

release_phase_log_elapsed() {
  local started_ms="$1"
  local label="$2"
  local finished_ms
  local elapsed_ms
  local phase_status="${3:-ok}"

  if [[ "${PACKAGE_TIMING:-0}" != "1" && -z "${OPENCLAW_JARVIS_RELEASE_TIMING_REPORT:-}" ]]; then
    return 0
  fi

  finished_ms="$(release_phase_now_ms)"
  elapsed_ms=$((finished_ms - started_ms))
  printf '⏱  %s: %d.%03ds\n' "$label" "$((elapsed_ms / 1000))" "$((elapsed_ms % 1000))" >&2
  mkdir -p "$(dirname "$RELEASE_TIMING_REPORT_PATH")"
  if [[ ! -f "$RELEASE_TIMING_REPORT_PATH" ]]; then
    printf 'phase\tlabel\tstatus\tstarted_ms\tfinished_ms\telapsed_ms\n' >"$RELEASE_TIMING_REPORT_PATH"
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$PACKAGE_PHASE" "$label" "$phase_status" "$started_ms" "$finished_ms" "$elapsed_ms" \
    >>"$RELEASE_TIMING_REPORT_PATH"
}

verify_app_bundle() {
  # macOS still ships old bash in places; under set -u, expanding an empty
  # array can abort the release lane. Keep default-instance verification free of
  # optional array expansion while preserving named-instance arguments.
  if ((${#VERIFY_ARGS[@]})); then
    BUNDLE_ID="$EXPECTED_BUNDLE_ID" \
    APP_NAME="$APP_NAME" \
      "$ROOT_DIR/scripts/verify-consumer-mac-app.sh" "${VERIFY_ARGS[@]}" "$APP_PATH"
  else
    BUNDLE_ID="$EXPECTED_BUNDLE_ID" \
    APP_NAME="$APP_NAME" \
      "$ROOT_DIR/scripts/verify-consumer-mac-app.sh" "$APP_PATH"
  fi
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
  latest_json="$(
    jarvis_release_retry \
      "gh release view latest for $GITHUB_RELEASE_REPO" \
      gh release view --repo "$GITHUB_RELEASE_REPO" --json tagName,url
  )"
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

require_latest_release_tag_for_appcast() {
  if [[ -z "$GITHUB_RELEASE_TAG" ]]; then
    echo "ERROR: creating Jarvis public Sparkle assets requires --github-release-tag <latest-tag>." >&2
    echo "The appcast must sign an immutable tagged Jarvis.zip URL before any public upload." >&2
    exit 1
  fi

  if ! command -v gh >/dev/null 2>&1; then
    echo "ERROR: validating the Jarvis appcast tag requires the GitHub CLI (gh)." >&2
    exit 1
  fi

  # A stale enclosure URL is worse than a missing appcast: Sparkle would see a
  # live feed that points at bytes from the wrong release. Validate before
  # signing local assets, then validate the generated XML again before upload.
  require_latest_release_tag
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

require_local_appcast_targets_current_tag() {
  local appcast="$ROOT_DIR/dist/jarvis-appcast.xml"
  local expected_zip_url

  if [[ -z "$GITHUB_RELEASE_TAG" ]]; then
    echo "ERROR: local appcast upload validation requires --github-release-tag <latest-tag>." >&2
    exit 1
  fi

  expected_zip_url="$(jarvis_appcast_zip_public_url)"
  if [[ ! -f "$appcast" ]]; then
    echo "ERROR: local Jarvis appcast is missing before upload: $appcast" >&2
    exit 1
  fi

  # The URL has no XML-sensitive characters, so a narrow attribute string check
  # is enough to prevent uploading an appcast generated for a stale tag.
  if ! /usr/bin/grep -Fq "url=\"$expected_zip_url\"" "$appcast" \
    && ! /usr/bin/grep -Fq "url='$expected_zip_url'" "$appcast"; then
    echo "ERROR: local Jarvis appcast does not target the current tagged ZIP URL." >&2
    echo "Expected enclosure URL: $expected_zip_url" >&2
    echo "Regenerate local release assets with --phase create-local-release-assets-only --github-release-tag $GITHUB_RELEASE_TAG before publishing." >&2
    exit 1
  fi
}

require_release_publish_prereqs() {
  if [[ "$PUBLISH_RELEASE_ASSETS" != "1" ]]; then
    return 0
  fi

  if [[ "$NOTARIZE" != "1" && "$PACKAGE_PHASE" != "publish-assets-only" && "$PACKAGE_PHASE" != "publish-sparkle-assets-only" ]]; then
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
  if [[ "$PACKAGE_PHASE" != "publish-assets-only" && "$PACKAGE_PHASE" != "publish-sparkle-assets-only" ]]; then
    require_sparkle_private_key_file
  fi
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

assert_sparkle_zip_has_no_macos_metadata() {
  local zip_path="$1"
  if ! command -v zipinfo >/dev/null; then
    echo "ERROR: zipinfo is required to verify the Sparkle ZIP contents." >&2
    exit 1
  fi

  # Sparkle validates the signed ZIP bytes and the expanded app. Resource-fork
  # sidecars from ditto --sequesterRsrc create __MACOSX/._* entries that are not
  # part of the app bundle and can make Sparkle reject an otherwise valid app.
  local metadata_entries
  metadata_entries="$(
    zipinfo -1 "$zip_path" | grep -E '(^__MACOSX/|/__MACOSX/|(^|/)\._[^/]+$|(^|/)\.DS_Store$)' || true
  )"
  if [[ -n "$metadata_entries" ]]; then
    echo "ERROR: Sparkle ZIP contains macOS metadata entries." >&2
    echo "Recreate it without resource forks, for example with: ditto -c -k --norsrc --keepParent" >&2
    printf '%s\n' "$metadata_entries" | sed -n '1,20p' >&2
    exit 1
  fi
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
    return 1
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
  require_local_appcast_targets_current_tag

  github_release_upload_preflight
  openclaw_require_jarvis_release_intent "$ROOT_DIR" "$RELEASE_INTENT_ID" "GitHub full release upload"

  echo "🚀 Uploading Jarvis release assets to $GITHUB_RELEASE_REPO@$GITHUB_RELEASE_TAG"
  jarvis_release_retry \
    "gh release upload Jarvis assets to $GITHUB_RELEASE_REPO@$GITHUB_RELEASE_TAG" \
    jarvis_release_upload_full_assets_attempt

  verify_public_release_assets
}

verify_public_release_assets() {
  local appcast="$ROOT_DIR/dist/jarvis-appcast.xml"
  for artifact in "$APP_PATH" "$ZIP" "$DMG" "$appcast"; do
    if [[ ! -e "$artifact" ]]; then
      echo "ERROR: release artifact missing before public verification: $artifact" >&2
      exit 1
    fi
  done

  jarvis_release_retry \
    "Jarvis public release asset verification" \
    "$ROOT_DIR/scripts/verify-jarvis-release-assets.mjs" \
      --app-path "$APP_PATH" \
      --zip-path "$ZIP" \
      --dmg-url "$JARVIS_DMG_PUBLIC_URL" \
      --zip-url "$(jarvis_appcast_zip_public_url)" \
      --appcast-url "$JARVIS_APPCAST_PUBLIC_URL"
}

verify_sparkle_public_release_assets() {
  local appcast="$ROOT_DIR/dist/jarvis-appcast.xml"
  for artifact in "$APP_PATH" "$ZIP" "$appcast"; do
    if [[ ! -e "$artifact" ]]; then
      echo "ERROR: Sparkle release artifact missing before public verification: $artifact" >&2
      exit 1
    fi
  done

  jarvis_release_retry \
    "Jarvis public Sparkle asset verification" \
    "$ROOT_DIR/scripts/verify-jarvis-release-assets.mjs" \
      --sparkle-only \
      --app-path "$APP_PATH" \
      --zip-path "$ZIP" \
      --zip-url "$(jarvis_appcast_zip_public_url)" \
      --appcast-url "$JARVIS_APPCAST_PUBLIC_URL"
}

publish_sparkle_release_assets() {
  if [[ "$PUBLISH_RELEASE_ASSETS" != "1" ]]; then
    return 0
  fi

  local appcast="$ROOT_DIR/dist/jarvis-appcast.xml"
  require_latest_release_tag

  for artifact in "$ZIP" "$appcast"; do
    if [[ ! -f "$artifact" ]]; then
      echo "ERROR: Sparkle release asset missing before upload: $artifact" >&2
      exit 1
    fi
  done
  require_local_appcast_targets_current_tag

  github_release_upload_preflight
  openclaw_require_jarvis_release_intent "$ROOT_DIR" "$RELEASE_INTENT_ID" "GitHub Sparkle release upload"

  # Existing users update through Sparkle using the ZIP and appcast. The DMG is
  # a separate fresh-install/sendable installer truth, so this urgent path keeps
  # the upload set narrow and refuses to imply the DMG is live.
  echo "🚀 Uploading Jarvis Sparkle update assets to $GITHUB_RELEASE_REPO@$GITHUB_RELEASE_TAG"
  jarvis_release_retry \
    "gh release upload Jarvis Sparkle assets to $GITHUB_RELEASE_REPO@$GITHUB_RELEASE_TAG" \
    jarvis_release_upload_sparkle_assets_attempt

  verify_sparkle_public_release_assets
}

# Retry boundaries re-check the short-lived operator authorization immediately
# before each mutating GitHub call. `jarvis_release_retry` deliberately disables
# errexit while it captures command output, so the explicit return preserves the
# guard: a replaced/expired intent must never fall through to `gh`.
jarvis_release_upload_full_assets_attempt() {
  openclaw_require_jarvis_release_intent \
    "$ROOT_DIR" "$RELEASE_INTENT_ID" "GitHub full release upload attempt" \
    || return $?
  gh release upload "$GITHUB_RELEASE_TAG" "$DMG" "$ZIP" "$appcast" \
    --repo "$GITHUB_RELEASE_REPO" \
    --clobber
}

jarvis_release_upload_sparkle_assets_attempt() {
  openclaw_require_jarvis_release_intent \
    "$ROOT_DIR" "$RELEASE_INTENT_ID" "GitHub Sparkle release upload attempt" \
    || return $?
  gh release upload "$GITHUB_RELEASE_TAG" "$ZIP" "$appcast" \
    --repo "$GITHUB_RELEASE_REPO" \
    --clobber
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

app_build_receipt_path() {
  printf '%s\n' "${OPENCLAW_CONSUMER_APP_BUILD_RECEIPT:-$ROOT_DIR/dist/${APP_NAME}.app.release.env}"
}

app_notary_receipt_path() {
  printf '%s\n' "$ROOT_DIR/dist/${APP_NAME}.app.notary.env"
}

dmg_notary_receipt_path() {
  printf '%s\n' "${DMG}.notary.env"
}

receipt_value() {
  local receipt_path="$1"
  local key="$2"

  /usr/bin/sed -n "s/^${key}=//p" "$receipt_path" | /usr/bin/head -n 1
}

artifact_size_bytes() {
  local artifact="$1"
  if [[ ! -e "$artifact" ]]; then
    printf '%s\n' ""
    return 0
  fi

  /usr/bin/stat -f%z "$artifact" 2>/dev/null || /usr/bin/stat -c%s "$artifact" 2>/dev/null || printf '%s\n' ""
}

artifact_sha256() {
  local artifact="$1"
  if [[ ! -f "$artifact" ]]; then
    printf '%s\n' ""
    return 0
  fi

  /usr/bin/shasum -a 256 "$artifact" | /usr/bin/awk '{ print $1 }'
}

manifest_value() {
  local key="$1"
  if [[ ! -f "$RELEASE_MANIFEST_PATH" ]]; then
    printf '%s\n' ""
    return 0
  fi

  receipt_value "$RELEASE_MANIFEST_PATH" "$key"
}

notary_receipt_status() {
  local receipt_path="$1"
  if [[ ! -f "$receipt_path" ]]; then
    printf '%s\n' ""
    return 0
  fi

  receipt_value "$receipt_path" "NOTARY_STATUS"
}

notary_receipt_submission_id() {
  local receipt_path="$1"
  if [[ ! -f "$receipt_path" ]]; then
    printf '%s\n' ""
    return 0
  fi

  receipt_value "$receipt_path" "NOTARY_SUBMISSION_ID"
}

notary_receipt_has_submitted_submission_id() {
  local receipt_path="$1"
  local submission_id

  submission_id="$(jarvis_release_normalize_optional_metadata_value "$(notary_receipt_submission_id "$receipt_path")")"
  [[ "$(notary_receipt_status "$receipt_path")" == "submitted" && -n "$submission_id" ]]
}

require_blocking_notary_result_intent() {
  local artifact_kind="$1"

  # Blocking submit --wait includes Apple's slow status wait and local staple.
  # Revalidate again in the package caller before any final manifest/checkpoint
  # mutation. A nonzero result with durable submitted proof is handled first by
  # the narrow exception that prevents duplicate submission.
  openclaw_require_jarvis_release_intent \
    "$ROOT_DIR" "$RELEASE_INTENT_ID" "$artifact_kind blocking notarization result"
}

write_release_manifest() {
  local appcast="$ROOT_DIR/dist/jarvis-appcast.xml"
  local build="unknown"
  local git_commit="unknown"
  local app_notary_receipt
  local dmg_notary_receipt
  local app_notary_id=""
  local dmg_notary_id=""
  local app_notary_status=""
  local dmg_notary_status=""

  if [[ -d "$APP_PATH" ]]; then
    build="$(/usr/libexec/PlistBuddy -c "Print CFBundleVersion" "$APP_PATH/Contents/Info.plist" 2>/dev/null || echo "unknown")"
    git_commit="$(/usr/libexec/PlistBuddy -c "Print OpenClawGitCommit" "$APP_PATH/Contents/Info.plist" 2>/dev/null || echo "unknown")"
  fi
  if [[ "$git_commit" == "unknown" ]]; then
    git_commit="$(git -C "$ROOT_DIR" rev-parse --short=12 HEAD 2>/dev/null || echo "unknown")"
  fi

  app_notary_receipt="$(app_notary_receipt_path)"
  dmg_notary_receipt="$(dmg_notary_receipt_path)"
  app_notary_id="$(notary_receipt_submission_id "$app_notary_receipt")"
  dmg_notary_id="$(notary_receipt_submission_id "$dmg_notary_receipt")"
  app_notary_status="$(notary_receipt_status "$app_notary_receipt")"
  dmg_notary_status="$(notary_receipt_status "$dmg_notary_receipt")"
  # Resume phases treat the manifest as durable operator metadata. If a later
  # local-assets or publish-only run lacks the original receipt files, preserve
  # the last recorded notary status instead of clobbering it with blanks.
  if [[ ! -f "$app_notary_receipt" ]]; then
    app_notary_id="$(manifest_value "JARVIS_APP_NOTARY_SUBMISSION_ID")"
    app_notary_status="$(manifest_value "JARVIS_APP_NOTARY_STATUS")"
  fi
  if [[ ! -f "$dmg_notary_receipt" ]]; then
    dmg_notary_id="$(manifest_value "JARVIS_DMG_NOTARY_SUBMISSION_ID")"
    dmg_notary_status="$(manifest_value "JARVIS_DMG_NOTARY_STATUS")"
  fi

  mkdir -p "$(dirname "$RELEASE_MANIFEST_PATH")"
  {
    printf 'JARVIS_RELEASE_MANIFEST_VERSION=%q\n' "1"
    printf 'JARVIS_PACKAGE_PHASE=%q\n' "$PACKAGE_PHASE"
    printf 'JARVIS_APP_PATH=%q\n' "$APP_PATH"
    printf 'JARVIS_DMG_PATH=%q\n' "$DMG"
    printf 'JARVIS_ZIP_PATH=%q\n' "$ZIP"
    printf 'JARVIS_APPCAST_PATH=%q\n' "$appcast"
    printf 'JARVIS_APP_VERSION=%q\n' "$VERSION"
    printf 'JARVIS_APP_BUILD=%q\n' "$build"
    printf 'JARVIS_GIT_COMMIT=%q\n' "$git_commit"
    printf 'JARVIS_APP_NOTARY_RECEIPT=%q\n' "$app_notary_receipt"
    printf 'JARVIS_DMG_NOTARY_RECEIPT=%q\n' "$dmg_notary_receipt"
    printf 'JARVIS_APP_NOTARY_SUBMISSION_ID=%q\n' "$app_notary_id"
    printf 'JARVIS_DMG_NOTARY_SUBMISSION_ID=%q\n' "$dmg_notary_id"
    printf 'JARVIS_APP_NOTARY_STATUS=%q\n' "$app_notary_status"
    printf 'JARVIS_DMG_NOTARY_STATUS=%q\n' "$dmg_notary_status"
    printf 'JARVIS_DMG_PUBLIC_URL=%q\n' "$JARVIS_DMG_PUBLIC_URL"
    printf 'JARVIS_ZIP_PUBLIC_URL=%q\n' "$(jarvis_appcast_zip_public_url)"
    printf 'JARVIS_APPCAST_PUBLIC_URL=%q\n' "$JARVIS_APPCAST_PUBLIC_URL"
    printf 'JARVIS_DMG_SHA256=%q\n' "$(artifact_sha256 "$DMG")"
    printf 'JARVIS_DMG_SIZE_BYTES=%q\n' "$(artifact_size_bytes "$DMG")"
    printf 'JARVIS_ZIP_SHA256=%q\n' "$(artifact_sha256 "$ZIP")"
    printf 'JARVIS_ZIP_SIZE_BYTES=%q\n' "$(artifact_size_bytes "$ZIP")"
    printf 'JARVIS_APPCAST_SHA256=%q\n' "$(artifact_sha256 "$appcast")"
    printf 'JARVIS_APPCAST_SIZE_BYTES=%q\n' "$(artifact_size_bytes "$appcast")"
    printf 'JARVIS_MANIFEST_UPDATED_AT=%q\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  } >"$RELEASE_MANIFEST_PATH"

  echo "🧾 Release manifest: $RELEASE_MANIFEST_PATH"
}

require_clean_git_for_release_build() {
  local dirty
  dirty="$(git -C "$ROOT_DIR" status --porcelain --untracked-files=no)"
  if [[ -n "$dirty" ]]; then
    echo "ERROR: release packaging requires a clean tracked worktree." >&2
    echo "$dirty" >&2
    echo "Commit or revert tracked changes before building a release artifact." >&2
    exit 1
  fi
}

require_notarized_manifest_before_publish() {
  local app_status
  local dmg_status
  app_status="$(manifest_value "JARVIS_APP_NOTARY_STATUS")"
  dmg_status="$(manifest_value "JARVIS_DMG_NOTARY_STATUS")"

  if [[ "$app_status" != "Accepted" || "$dmg_status" != "Accepted" ]]; then
    echo "ERROR: publish-only requires accepted app and DMG notarization in $RELEASE_MANIFEST_PATH." >&2
    echo "app_notary_status=${app_status:-missing}" >&2
    echo "dmg_notary_status=${dmg_status:-missing}" >&2
    echo "Poll the saved submissions before uploading public assets." >&2
    exit 1
  fi
}

require_sparkle_manifest_before_publish() {
  local app_status
  app_status="$(manifest_value "JARVIS_APP_NOTARY_STATUS")"

  if [[ "$app_status" != "Accepted" ]]; then
    echo "ERROR: Sparkle-only publish requires accepted app notarization in $RELEASE_MANIFEST_PATH." >&2
    echo "app_notary_status=${app_status:-missing}" >&2
    echo "Poll the app notarization receipt before uploading public Sparkle assets." >&2
    exit 1
  fi
}

require_sparkle_assets_before_publish() {
  local appcast="$ROOT_DIR/dist/jarvis-appcast.xml"
  local failed=0

  # Sparkle is the updater path for existing users. It only needs the accepted
  # app bundle, the ZIP made from that bundle, and the signed appcast pointing
  # at the immutable tagged ZIP URL. The DMG remains a separate fresh-install
  # artifact and is deliberately not part of this gate.
  if [[ ! -d "$APP_PATH" ]]; then
    echo "ERROR: Sparkle-only publish requires an existing app bundle: $APP_PATH" >&2
    failed=1
  fi
  if [[ ! -f "$ZIP" ]]; then
    echo "ERROR: Sparkle-only publish requires an existing ZIP: $ZIP" >&2
    failed=1
  fi
  if [[ ! -f "$appcast" ]]; then
    echo "ERROR: Sparkle-only publish requires an existing appcast: $appcast" >&2
    failed=1
  fi
  [[ "$failed" == "0" ]] || exit 1

  require_sparkle_manifest_before_publish
  require_local_appcast_targets_current_tag
}

require_local_release_asset_phase_inputs() {
  local app_status
  local failed=0

  if [[ ! -d "$APP_PATH" ]]; then
    echo "ERROR: --phase create-local-release-assets-only requires an existing app bundle: $APP_PATH" >&2
    echo "Run the default package lane once, or point APP_NAME/APP_BUNDLE_NAME at the already-built Jarvis app." >&2
    failed=1
  fi

  app_status="$(manifest_value "JARVIS_APP_NOTARY_STATUS")"
  if [[ "$app_status" != "Accepted" ]]; then
    echo "ERROR: create-local-release-assets-only requires accepted app notarization in $RELEASE_MANIFEST_PATH." >&2
    echo "app_notary_status=${app_status:-missing}" >&2
    echo "Poll the app notarization receipt before creating the local Sparkle ZIP/appcast." >&2
    failed=1
  fi

  [[ "$failed" == "0" ]] || exit 1
}

require_app_notarized_manifest() {
  local app_status
  app_status="$(manifest_value "JARVIS_APP_NOTARY_STATUS")"
  if [[ "$app_status" != "Accepted" ]]; then
    echo "ERROR: DMG notarization resume requires accepted app notarization in $RELEASE_MANIFEST_PATH." >&2
    echo "app_notary_status=${app_status:-missing}" >&2
    echo "Poll the app notarization receipt before creating/submitting the DMG." >&2
    exit 1
  fi
}

read_app_build_receipt() {
  local receipt_path
  receipt_path="$(app_build_receipt_path)"

  if [[ ! -f "$receipt_path" ]]; then
    echo "🧾 App build receipt: missing ($receipt_path); continuing from $APP_PATH"
    return 0
  fi

  # Receipt values are operator context only. Do not source this file: recovery
  # metadata must never become a shell execution surface.
  echo "🧾 App build receipt: $receipt_path"
  echo "  receipt_app_path=$(receipt_value "$receipt_path" "JARVIS_APP_PATH")"
  echo "  receipt_version=$(receipt_value "$receipt_path" "JARVIS_APP_VERSION")"
  echo "  receipt_build=$(receipt_value "$receipt_path" "JARVIS_APP_BUILD")"
  echo "  receipt_signing_authority=$(receipt_value "$receipt_path" "JARVIS_SIGNING_AUTHORITY")"
}

write_app_build_receipt() {
  local receipt_path
  receipt_path="$(app_build_receipt_path)"

  mkdir -p "$(dirname "$receipt_path")"
  {
    printf 'JARVIS_PACKAGE_PHASE=%q\n' "post-app-build"
    printf 'JARVIS_APP_PATH=%q\n' "$APP_PATH"
    printf 'JARVIS_APP_VERSION=%q\n' "$VERSION"
    printf 'JARVIS_APP_BUILD=%q\n' "$(/usr/libexec/PlistBuddy -c "Print CFBundleVersion" "$APP_PATH/Contents/Info.plist" 2>/dev/null || echo "unknown")"
    printf 'JARVIS_SIGNING_AUTHORITY=%q\n' "${SIGNING_AUTHORITY:-unknown}"
    printf 'JARVIS_GIT_COMMIT=%q\n' "$(/usr/libexec/PlistBuddy -c "Print OpenClawGitCommit" "$APP_PATH/Contents/Info.plist" 2>/dev/null || echo "unknown")"
    printf 'JARVIS_RECEIPT_CREATED_AT=%q\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  } >"$receipt_path"

  echo "🧾 App build receipt: $receipt_path"
}

verify_resume_app_bundle() {
  if [[ ! -d "$APP_PATH" ]]; then
    echo "ERROR: --phase $PACKAGE_PHASE requires an existing app bundle: $APP_PATH" >&2
    echo "Run the default package lane once, or point APP_NAME/APP_BUNDLE_NAME at the already-built Jarvis app." >&2
    exit 1
  fi

  read_app_build_receipt
  echo "🔁 Resuming release packaging from existing app bundle: $APP_PATH"
  verify_app_bundle
}

submit_app_notarization_only() {
  local notary_zip="$NOTARY_ZIP"
  local receipt_path
  local status=0

  receipt_path="$(app_notary_receipt_path)"
  echo "📦 Notary zip: $notary_zip"
  rm -f "$notary_zip"
  ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$notary_zip"
  set +e
  OPENCLAW_NOTARY_FINAL_SUBMIT_INTENT_ROOT="$ROOT_DIR" \
  OPENCLAW_NOTARY_FINAL_SUBMIT_INTENT_ID="$RELEASE_INTENT_ID" \
  STAPLE_APP_PATH="$APP_PATH" "$ROOT_DIR/scripts/notarize-mac-artifact.sh" \
    --submit-only \
    --receipt "$receipt_path" \
    "$notary_zip"
  status=$?
  set -e

  # Apple may have accepted the job even when the submit transport exits
  # nonzero. That receipt is irreversible external truth, so preserve a strict
  # submitted checkpoint without revalidating a now-expired/replaced intent;
  # otherwise wrapper recovery could mistakenly submit the same bytes again.
  if [[ $status -ne 0 ]] && notary_receipt_has_submitted_submission_id "$receipt_path"; then
    write_release_manifest
    write_app_checkpoint_from_receipt app-notary-submitted
    return "$status"
  fi

  # No durable Apple job exists to recover from this error. Preserve the
  # original failure without advancing the manifest to a guessed state.
  if [[ $status -ne 0 ]]; then
    return "$status"
  fi

  write_release_manifest
  return "$status"
}

poll_app_notarization_only() {
  local receipt_path
  local submission_id
  local artifact
  local staple_app
  local status

  receipt_path="$(app_notary_receipt_path)"
  if [[ -f "$receipt_path" ]]; then
    submission_id="$(receipt_value "$receipt_path" "NOTARY_SUBMISSION_ID")"
    submission_id="$(jarvis_release_normalize_optional_metadata_value "$submission_id")"
    artifact="$(receipt_value "$receipt_path" "NOTARY_ARTIFACT")"
    staple_app="$(receipt_value "$receipt_path" "NOTARY_STAPLE_APP_PATH")"
  else
    # The manifest is durable operator state and can outlive a receipt file.
    # Polling app notarization does not need the original upload zip, so recover
    # from the saved submission ID and rewrite the receipt after notarytool info.
    echo "🧾 App notarization receipt missing; recovering poll metadata from $RELEASE_MANIFEST_PATH"
    submission_id="$(manifest_value "JARVIS_APP_NOTARY_SUBMISSION_ID")"
    submission_id="$(jarvis_release_normalize_optional_metadata_value "$submission_id")"
    artifact="$NOTARY_ZIP"
    staple_app="$APP_PATH"
  fi
  if [[ -z "$submission_id" ]]; then
    echo "ERROR: app notarization receipt lacks NOTARY_SUBMISSION_ID: $receipt_path" >&2
    exit 1
  fi
  if [[ -z "$artifact" ]]; then
    artifact="$NOTARY_ZIP"
  fi
  if [[ -z "$staple_app" ]]; then
    staple_app="$APP_PATH"
  fi

  set +e
  OPENCLAW_NOTARY_FINAL_POLL_INTENT_ROOT="$ROOT_DIR" \
  OPENCLAW_NOTARY_FINAL_POLL_INTENT_ID="$RELEASE_INTENT_ID" \
    "$ROOT_DIR/scripts/notarize-mac-artifact.sh" \
    --poll "$submission_id" \
    --artifact "$artifact" \
    --receipt "$receipt_path" \
    --staple-app "$staple_app"
  status=$?
  set -e
  # The helper may return from a deliberately non-errexit poll capture. Do not
  # let an old intent write manifest/checkpoint state after that slow call.
  openclaw_require_jarvis_release_intent \
    "$ROOT_DIR" "$RELEASE_INTENT_ID" "app notarization poll result" \
    || return $?
  write_release_manifest
  if [[ $status -ne 0 ]]; then
    if [[ "$(notary_receipt_status "$receipt_path")" == "Accepted" ]]; then
      openclaw_require_jarvis_release_intent \
        "$ROOT_DIR" "$RELEASE_INTENT_ID" "app accepted notarization checkpoint" \
        || return $?
      write_app_checkpoint_from_receipt app-notary-accepted
    fi
    return "$status"
  fi

  set +e
  OPENCLAW_CONSUMER_VERIFY_RELEASE=1 \
  SPARKLE_EXPECTED_PUBLIC_ED_KEY="${SPARKLE_PUBLIC_ED_KEY:-}" \
    verify_app_bundle
  status=$?
  set -e
  if [[ $status -ne 0 ]]; then
    openclaw_require_jarvis_release_intent \
      "$ROOT_DIR" "$RELEASE_INTENT_ID" "app accepted notarization checkpoint" \
      || return $?
    write_app_checkpoint_from_receipt app-notary-accepted
    return "$status"
  fi
}

create_signed_dmg() {
  local dmg_started_ms
  local dmg_sign_started_ms

  echo "💿 DMG: $DMG"
  rm -f "$DMG" "${DMG%.dmg}-rw.dmg"
  dmg_started_ms="$(release_phase_now_ms)"
  "$ROOT_DIR/scripts/create-dmg.sh" "$APP_PATH" "$DMG"
  release_phase_log_elapsed "$dmg_started_ms" "DMG create/verify"
  dmg_sign_started_ms="$(release_phase_now_ms)"
  sign_dmg_if_possible "$DMG" "$SIGNING_AUTHORITY"
  release_phase_log_elapsed "$dmg_sign_started_ms" "DMG sign"
  if [[ -n "$SIGNING_AUTHORITY" ]]; then
    # An ad-hoc app has no Authority line, so sign_dmg_if_possible deliberately
    # leaves its local-smoke DMG unsigned. Do not mislabel those bytes as the
    # signed public-resume checkpoint consumed by the release wrapper.
    openclaw_jarvis_release_checkpoint_write "$ROOT_DIR" "$DMG" dmg dmg-signed not-required "" "$APP_PATH"
  fi
}

submit_dmg_notarization_only() {
  local receipt_path
  local status=0

  receipt_path="$(dmg_notary_receipt_path)"
  require_app_notarized_manifest
  create_signed_dmg
  set +e
  OPENCLAW_NOTARY_FINAL_SUBMIT_INTENT_ROOT="$ROOT_DIR" \
  OPENCLAW_NOTARY_FINAL_SUBMIT_INTENT_ID="$RELEASE_INTENT_ID" \
    "$ROOT_DIR/scripts/notarize-mac-artifact.sh" \
    --submit-only \
    --receipt "$receipt_path" \
    "$DMG"
  status=$?
  set -e

  if [[ $status -ne 0 ]] && notary_receipt_has_submitted_submission_id "$receipt_path"; then
    # Preserve Apple-side job recovery even if the operator authorization was
    # replaced during upload. The checkpoint is metadata, not a new submit.
    write_release_manifest
    write_dmg_checkpoint_from_receipt dmg-notary-submitted
    return "$status"
  fi

  if [[ $status -ne 0 ]]; then
    return "$status"
  fi

  write_release_manifest
  return "$status"
}

poll_dmg_notarization_only() {
  local receipt_path
  local submission_id
  local artifact
  local status

  receipt_path="$(dmg_notary_receipt_path)"
  if [[ -f "$receipt_path" ]]; then
    submission_id="$(receipt_value "$receipt_path" "NOTARY_SUBMISSION_ID")"
    submission_id="$(jarvis_release_normalize_optional_metadata_value "$submission_id")"
    artifact="$(receipt_value "$receipt_path" "NOTARY_ARTIFACT")"
  else
    # Unlike the app upload zip, the DMG itself must exist when Accepted so
    # stapler can attach and validate the ticket. Use the manifest submission ID
    # only when the local DMG artifact is still present.
    echo "🧾 DMG notarization receipt missing; recovering poll metadata from $RELEASE_MANIFEST_PATH"
    submission_id="$(manifest_value "JARVIS_DMG_NOTARY_SUBMISSION_ID")"
    submission_id="$(jarvis_release_normalize_optional_metadata_value "$submission_id")"
    artifact="$DMG"
  fi
  if [[ -z "$submission_id" ]]; then
    echo "ERROR: DMG notarization receipt lacks NOTARY_SUBMISSION_ID: $receipt_path" >&2
    exit 1
  fi
  if [[ -z "$artifact" ]]; then
    artifact="$DMG"
  fi

  set +e
  OPENCLAW_NOTARY_FINAL_POLL_INTENT_ROOT="$ROOT_DIR" \
  OPENCLAW_NOTARY_FINAL_POLL_INTENT_ID="$RELEASE_INTENT_ID" \
    "$ROOT_DIR/scripts/notarize-mac-artifact.sh" \
    --poll "$submission_id" \
    --artifact "$artifact" \
    --receipt "$receipt_path"
  status=$?
  set -e
  openclaw_require_jarvis_release_intent \
    "$ROOT_DIR" "$RELEASE_INTENT_ID" "DMG notarization poll result" \
    || return $?
  if [[ $status -eq 0 ]]; then
    set +e
    verify_dmg_gatekeeper "$DMG"
    status=$?
    set -e
  fi
  openclaw_require_jarvis_release_intent \
    "$ROOT_DIR" "$RELEASE_INTENT_ID" "DMG notarization poll manifest" \
    || return $?
  write_release_manifest
  if [[ $status -ne 0 ]]; then
    if [[ "$(notary_receipt_status "$receipt_path")" == "Accepted" ]]; then
      openclaw_require_jarvis_release_intent \
        "$ROOT_DIR" "$RELEASE_INTENT_ID" "DMG accepted notarization checkpoint" \
        || return $?
      write_dmg_checkpoint_from_receipt dmg-notary-accepted
    fi
    return "$status"
  fi
}

create_local_release_assets_only() {
  require_local_release_asset_phase_inputs
  if [[ "$NOTARIZE" != "1" ]]; then
    echo "ERROR: create-local-release-assets-only requires notarized release mode." >&2
    echo "Unset SKIP_NOTARIZE; this phase creates signed Sparkle release assets from an already accepted app." >&2
    exit 1
  fi
  require_sparkle_private_key_file

  echo "📦 Zip: $ZIP"
  # Recreate only the local Sparkle assets. The app and DMG receipts are inputs
  # here; this phase must not rebuild, staple, upload, or touch the DMG.
  rm -f "$ZIP" "$ROOT_DIR/dist/jarvis-appcast.xml"
  ditto -c -k --norsrc --keepParent "$APP_PATH" "$ZIP"
  assert_sparkle_zip_has_no_macos_metadata "$ZIP"
  generate_jarvis_appcast
  openclaw_jarvis_release_checkpoint_write "$ROOT_DIR" "$ZIP" zip sparkle-zip not-required "" "$APP_PATH"
  openclaw_jarvis_release_checkpoint_write "$ROOT_DIR" "$ROOT_DIR/dist/jarvis-appcast.xml" appcast sparkle-appcast not-required "" "$APP_PATH"
  write_release_manifest
}

report_local_release_assets_next_phase() {
  local dmg_receipt
  local next_phase="submit-dmg-notarization"

  dmg_receipt="$(dmg_notary_receipt_path)"
  if openclaw_jarvis_release_checkpoint_validate \
    "$ROOT_DIR" "$DMG" dmg dmg-notarized "$dmg_receipt" "$APP_PATH"; then
    next_phase="publish-assets-only"
  elif openclaw_jarvis_release_checkpoint_validate \
    "$ROOT_DIR" "$DMG" dmg dmg-notary-accepted "$dmg_receipt" "$APP_PATH" \
    || openclaw_jarvis_release_checkpoint_validate \
      "$ROOT_DIR" "$DMG" dmg dmg-notary-submitted "$dmg_receipt" "$APP_PATH"; then
    # Accepted-with-pending-staple and submitted proofs both resume the same
    # Apple job. Neither state is sendable or publishable yet.
    next_phase="poll-dmg-notarization"
  fi

  printf 'next_phase=%s\n' "$next_phase"
}

release_checkpoint_receipt_submission_id() {
  local receipt_path="$1"
  receipt_value "$receipt_path" "NOTARY_SUBMISSION_ID"
}

write_app_checkpoint_from_receipt() {
  local intended_phase="$1"
  local receipt_path
  local status
  local submission_id
  receipt_path="$(app_notary_receipt_path)"
  status="$(notary_receipt_status "$receipt_path")"
  submission_id="$(release_checkpoint_receipt_submission_id "$receipt_path")"
  openclaw_jarvis_release_checkpoint_write \
    "$ROOT_DIR" "$APP_PATH" app "$intended_phase" "$status" "$submission_id"
}

write_dmg_checkpoint_from_receipt() {
  local intended_phase="$1"
  local receipt_path
  local status
  local submission_id
  receipt_path="$(dmg_notary_receipt_path)"
  status="$(notary_receipt_status "$receipt_path")"
  submission_id="$(release_checkpoint_receipt_submission_id "$receipt_path")"
  openclaw_jarvis_release_checkpoint_write \
    "$ROOT_DIR" "$DMG" dmg "$intended_phase" "$status" "$submission_id" "$APP_PATH"
}

require_resume_checkpoints_for_phase() {
  local app_receipt
  local dmg_receipt
  local appcast="$ROOT_DIR/dist/jarvis-appcast.xml"
  app_receipt="$(app_notary_receipt_path)"
  dmg_receipt="$(dmg_notary_receipt_path)"

  case "$PACKAGE_PHASE" in
    post-app-build|submit-app-notarization)
      openclaw_require_jarvis_release_checkpoint "$ROOT_DIR" "$APP_PATH" app app-signed
      ;;
    poll-app-notarization)
      if ! openclaw_jarvis_release_checkpoint_validate "$ROOT_DIR" "$APP_PATH" app app-notary-accepted "$app_receipt"; then
        openclaw_require_jarvis_release_checkpoint "$ROOT_DIR" "$APP_PATH" app app-notary-submitted "$app_receipt"
      fi
      ;;
    submit-dmg-notarization|create-local-release-assets-only)
      openclaw_require_jarvis_release_checkpoint "$ROOT_DIR" "$APP_PATH" app app-notarized "$app_receipt"
      ;;
    poll-dmg-notarization)
      openclaw_require_jarvis_release_checkpoint "$ROOT_DIR" "$APP_PATH" app app-notarized "$app_receipt"
      if ! openclaw_jarvis_release_checkpoint_validate "$ROOT_DIR" "$DMG" dmg dmg-notary-accepted "$dmg_receipt" "$APP_PATH"; then
        openclaw_require_jarvis_release_checkpoint "$ROOT_DIR" "$DMG" dmg dmg-notary-submitted "$dmg_receipt" "$APP_PATH"
      fi
      ;;
    publish-assets-only|verify-public-assets-only)
      openclaw_require_jarvis_release_checkpoint "$ROOT_DIR" "$APP_PATH" app app-notarized "$app_receipt"
      openclaw_require_jarvis_release_checkpoint "$ROOT_DIR" "$DMG" dmg dmg-notarized "$dmg_receipt" "$APP_PATH"
      openclaw_require_jarvis_release_checkpoint "$ROOT_DIR" "$ZIP" zip sparkle-zip "" "$APP_PATH"
      openclaw_require_jarvis_release_checkpoint "$ROOT_DIR" "$appcast" appcast sparkle-appcast "" "$APP_PATH"
      ;;
    publish-sparkle-assets-only|verify-sparkle-assets-only)
      # Sparkle truth remains independent of DMG truth. Validate only the
      # notarized app plus its immutable ZIP/appcast pair here.
      openclaw_require_jarvis_release_checkpoint "$ROOT_DIR" "$APP_PATH" app app-notarized "$app_receipt"
      openclaw_require_jarvis_release_checkpoint "$ROOT_DIR" "$ZIP" zip sparkle-zip "" "$APP_PATH"
      openclaw_require_jarvis_release_checkpoint "$ROOT_DIR" "$appcast" appcast sparkle-appcast "" "$APP_PATH"
      ;;
  esac
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --publish-release-assets)
      PUBLISH_RELEASE_ASSETS=1
      shift
      ;;
    --release-intent)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --release-intent requires a value" >&2
        exit 1
      fi
      RELEASE_INTENT_ID="$2"
      shift 2
      ;;
    --github-release-tag)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --github-release-tag requires a value" >&2
        exit 1
      fi
      GITHUB_RELEASE_TAG="$2"
      shift 2
      ;;
    --phase)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --phase requires a value" >&2
        exit 1
      fi
      PACKAGE_PHASE="$2"
      shift 2
      ;;
    --resume-after-app-build)
      PACKAGE_PHASE="post-app-build"
      shift
      ;;
    --local-proof)
      PACKAGE_PHASE="local-proof"
      shift
      ;;
    --trusted-ring-fast)
      PACKAGE_PHASE="trusted-ring-fast"
      shift
      ;;
    --local-proof)
      PACKAGE_PHASE="local-proof"
      shift
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

case "$PACKAGE_PHASE" in
  full|local-proof|post-app-build|build-app-only|submit-app-notarization|poll-app-notarization|submit-dmg-notarization|poll-dmg-notarization|create-local-release-assets-only|publish-assets-only|verify-public-assets-only|publish-sparkle-assets-only|verify-sparkle-assets-only|trusted-ring-fast)
    ;;
  *)
    echo "ERROR: unknown --phase value: $PACKAGE_PHASE" >&2
    echo "Use --phase full, local-proof, post-app-build, build-app-only, submit-app-notarization, poll-app-notarization, submit-dmg-notarization, poll-dmg-notarization, create-local-release-assets-only, publish-assets-only, verify-public-assets-only, publish-sparkle-assets-only, verify-sparkle-assets-only, or trusted-ring-fast." >&2
    exit 1
    ;;
esac

# release-jarvis is intentionally outside and before the package mutex. A
# direct package command re-execs through the same named resource wrapper.
openclaw_shared_resource_lock_require_or_reexec \
  release-jarvis \
  "package-openclaw-mac-dist:${PACKAGE_PHASE}" \
  "$ROOT_DIR" \
  "$ROOT_DIR/scripts/package-openclaw-mac-dist.sh" \
  "${ORIGINAL_PACKAGE_ARGS[@]}"

trap release_package_exit EXIT

openclaw_require_jarvis_release_worktree "$ROOT_DIR"

# Every package phase can update release receipts or the manifest, including
# public verification. Keep one owner across the whole delegated package run.
# The lock helper temporarily owns signal/exit cleanup while acquiring. Restore
# the package-level recovery contract on both success and ordinary contention.
if openclaw_jarvis_release_lock_acquire "$ROOT_DIR" "package-phase:$PACKAGE_PHASE"; then
  :
else
  lock_status=$?
  trap release_package_exit EXIT
  exit "$lock_status"
fi
trap release_package_exit EXIT

# Direct callers and delegated wrapper children share the same authorization
# contract. This check happens only after verified lock acquisition/transfer,
# so no stale process can consume a phase snapshot selected by another owner.
openclaw_require_jarvis_release_intent "$ROOT_DIR" "$RELEASE_INTENT_ID" "package phase $PACKAGE_PHASE"

if [[ "$PACKAGE_PHASE" == "local-proof" ]]; then
  SKIP_NOTARIZE=1
  SKIP_DSYM="${SKIP_DSYM:-1}"
  PUBLISH_RELEASE_ASSETS=0
  ALLOW_DEFAULT_SPARKLE_KEY_FOR_CONSUMER_SMOKE="${ALLOW_DEFAULT_SPARKLE_KEY_FOR_CONSUMER_SMOKE:-1}"
  # Local proof is about the signed app bundle plus release identity verifier,
  # not distribution artifacts. Reuse the runtime cache so repeated local
  # iterations do not restage Node, uv, and production node_modules.
  OPENCLAW_CONSUMER_FAST_PACKAGING=1
  OPENCLAW_CONSUMER_CLEAN_GIT_RUNTIME_CACHE=1
fi

if [[ "$PACKAGE_PHASE" == "trusted-ring-fast" ]]; then
  SKIP_NOTARIZE=1
  SKIP_DSYM="${SKIP_DSYM:-1}"
  PUBLISH_RELEASE_ASSETS=0
  ALLOW_DEFAULT_SPARKLE_KEY_FOR_CONSUMER_SMOKE="${ALLOW_DEFAULT_SPARKLE_KEY_FOR_CONSUMER_SMOKE:-1}"
  # Trusted-ring packages are local proof artifacts, not public release assets.
  # Reuse the package-mac fast path so repeat runs skip the CLI archive and
  # consume the runtime cache from a clean tracked release-lane commit.
  OPENCLAW_CONSUMER_FAST_PACKAGING=1
  OPENCLAW_CONSUMER_CLEAN_GIT_RUNTIME_CACHE=1
fi

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

# Release packaging ships the broad-public product under the Jarvis name and
# bundle id. Runtime state paths and the gateway label remain unchanged here;
# moving those is a separate migration/clean-start decision, not a packaging
# default.
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

# Derive canonical paths before any resume gate. These reads are safe; the
# first mutation remains below the intent and checkpoint validation barriers.
VERSION=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$APP_PATH/Contents/Info.plist" 2>/dev/null || echo "0.0.0")
ARTIFACT_BASENAME="${APP_NAME}"
if [[ "${VERSIONED_ARTIFACT_NAMES:-0}" == "1" ]]; then
  ARTIFACT_BASENAME="${APP_NAME}-${VERSION}"
fi
ZIP="$ROOT_DIR/dist/${ARTIFACT_BASENAME}.zip"
DMG="$ROOT_DIR/dist/${ARTIFACT_BASENAME}.dmg"

case "$PACKAGE_PHASE" in
  create-local-release-assets-only)
    require_local_release_asset_phase_inputs
    require_latest_release_tag_for_appcast
    ;;
  publish-assets-only)
    require_notarized_manifest_before_publish
    ;;
  publish-sparkle-assets-only|verify-sparkle-assets-only)
    require_sparkle_manifest_before_publish
    ;;
esac

case "$PACKAGE_PHASE" in
  full|local-proof|build-app-only|post-app-build|trusted-ring-fast|submit-app-notarization|poll-app-notarization|create-local-release-assets-only)
    consumer_sparkle_release_gate
    ;;
esac

case "$PACKAGE_PHASE" in
  full|post-app-build|local-proof)
    require_release_publish_prereqs
    if [[ "$NOTARIZE" == "1" ]]; then
      require_sparkle_private_key_file
    fi
    ;;
  publish-assets-only)
    require_notarized_manifest_before_publish
    if [[ "$PUBLISH_RELEASE_ASSETS" != "1" ]]; then
      echo "ERROR: --phase publish-assets-only requires --publish-release-assets." >&2
      exit 1
    fi
    require_release_publish_prereqs
    ;;
  publish-sparkle-assets-only)
    require_sparkle_manifest_before_publish
    if [[ "$PUBLISH_RELEASE_ASSETS" != "1" ]]; then
      echo "ERROR: --phase publish-sparkle-assets-only requires --publish-release-assets." >&2
      exit 1
    fi
    require_release_publish_prereqs
    ;;
  verify-public-assets-only)
    if [[ -n "$GITHUB_RELEASE_TAG" ]]; then
      require_latest_release_tag
    fi
    ;;
  verify-sparkle-assets-only)
    require_sparkle_manifest_before_publish
    if [[ -n "$GITHUB_RELEASE_TAG" ]]; then
      require_latest_release_tag
    fi
    ;;
esac

# Argument/auth/tool checks above are read-only. Artifact reuse is still gated
# here before verification writes receipts or any release mutation begins.
require_resume_checkpoints_for_phase

case "$PACKAGE_PHASE" in
  full|local-proof|build-app-only|trusted-ring-fast)
    openclaw_require_macos_prewarm_proof "$ROOT_DIR"
    require_clean_git_for_release_build
    ;;
esac

# All argument, checkpoint, prewarm, and clean-tree gates above are read-only.
# Validate authorization around the potentially slow filesystem probes, then
# proceed immediately to the heavy-artifact path. The post-probe validation
# closes replacement races before run-root creation, stale deletion, or package
# invocation. Poll/publish/verify phases skip this gate.
if package_phase_creates_heavy_local_artifacts "$PACKAGE_PHASE"; then
  openclaw_require_jarvis_release_intent "$ROOT_DIR" "$RELEASE_INTENT_ID" "release disk preflight"
  require_release_disk_preflight
  export OPENCLAW_RELEASE_DISK_ADMISSION_VERIFIED=1
  openclaw_require_jarvis_release_intent "$ROOT_DIR" "$RELEASE_INTENT_ID" "release artifact mutation"
fi

if [[ -n "$NORMALIZED_INSTANCE_ID" ]]; then
  VERIFY_ARGS+=(--instance "$NORMALIZED_INSTANCE_ID")
fi

if [[ "$PACKAGE_PHASE" == "full" || "$PACKAGE_PHASE" == "local-proof" || "$PACKAGE_PHASE" == "build-app-only" || "$PACKAGE_PHASE" == "trusted-ring-fast" ]]; then
  # Stale release artifacts under dist/ can get copied into the bundled runtime
  # before the fresh app is assembled. Remove only mac release outputs here; JS
  # build outputs under dist/ are still needed by the packaged CLI/runtime.
  rm -f \
    "$ROOT_DIR"/dist/"$APP_NAME"*.zip \
    "$ROOT_DIR"/dist/"$APP_NAME"*.dmg \
    "$ROOT_DIR"/dist/"$PRODUCT"*.dSYM.zip \
    "$ROOT_DIR"/dist/*appcast*.xml

  app_package_started_ms="$(release_phase_now_ms)"
  APP_NAME="$APP_NAME" \
  APP_BUNDLE_NAME="$APP_BUNDLE_NAME" \
  BUNDLE_ID="$EXPECTED_BUNDLE_ID" \
  APP_VARIANT="$EXPECTED_VARIANT" \
  APP_INSTANCE_ID="$NORMALIZED_INSTANCE_ID" \
  URL_SCHEME="$EXPECTED_URL_SCHEME" \
  BUILD_CONFIG="$BUILD_CONFIG" \
  BUILD_ARCHS="$BUILD_ARCHS" \
  OPENCLAW_CONSUMER_FAST_PACKAGING="$OPENCLAW_CONSUMER_FAST_PACKAGING" \
  OPENCLAW_CONSUMER_CLEAN_GIT_RUNTIME_CACHE="$OPENCLAW_CONSUMER_CLEAN_GIT_RUNTIME_CACHE" \
  "$ROOT_DIR/scripts/package-mac-app.sh"
  release_phase_log_elapsed "$app_package_started_ms" "Jarvis app package"

  app_verify_started_ms="$(release_phase_now_ms)"
  verify_app_bundle
  release_phase_log_elapsed "$app_verify_started_ms" "Jarvis app verify"
else
  verify_resume_app_bundle
fi

VERSION=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$APP_PATH/Contents/Info.plist" 2>/dev/null || echo "0.0.0")
if openclaw_macos_release_phase_requires_version_gate "$PACKAGE_PHASE"; then
  # Resume phases can notarize or publish a previously built app without ever
  # entering the fresh-build branch above. Gate the shared app artifact before
  # any phase writes release receipts or advances it toward public delivery.
  openclaw_require_incremental_sparkle_build "$APP_PATH"
fi
ARTIFACT_BASENAME="${APP_NAME}"
if [[ "${VERSIONED_ARTIFACT_NAMES:-0}" == "1" ]]; then
  # Clean filenames are the default for human handoff because most consumer
  # drops are shared directly, not archived in a formal release bucket. Keep
  # the old versioned naming available for agents that explicitly want it.
  ARTIFACT_BASENAME="${APP_NAME}-${VERSION}"
fi

ZIP="$ROOT_DIR/dist/${ARTIFACT_BASENAME}.zip"
DMG="$ROOT_DIR/dist/${ARTIFACT_BASENAME}.dmg"
NOTARY_ZIP=""
case "$PACKAGE_PHASE" in
  submit-app-notarization)
    NOTARY_ZIP="$(release_run_root)/${APP_NAME}-${VERSION}.notary.zip"
    ;;
  full|post-app-build)
    if [[ "$NOTARIZE" == "1" ]]; then
      NOTARY_ZIP="$(release_run_root)/${APP_NAME}-${VERSION}.notary.zip"
    fi
    ;;
esac
DSYM_ZIP="$ROOT_DIR/dist/${PRODUCT}-${VERSION}.dSYM.zip"
SIGNING_AUTHORITY="$(bundle_signing_authority "$APP_PATH")"
write_app_build_receipt
case "$PACKAGE_PHASE" in
  full|build-app-only)
    openclaw_jarvis_release_checkpoint_write "$ROOT_DIR" "$APP_PATH" app app-signed
    ;;
  local-proof)
    # Local proof may use development/ad-hoc signing and must never become a
    # resumable public notarization input merely because its signature verifies.
    openclaw_jarvis_release_checkpoint_write "$ROOT_DIR" "$APP_PATH" app app-local-proof
    ;;
  trusted-ring-fast)
    # Trusted-ring output is intentionally non-public and cannot authorize a
    # later public app-notary phase.
    openclaw_jarvis_release_checkpoint_write "$ROOT_DIR" "$APP_PATH" app app-trusted-ring
    ;;
esac
write_release_manifest

case "$PACKAGE_PHASE" in
  local-proof)
    echo "Jarvis local proof app bundle ready:"
    echo "  phase=$PACKAGE_PHASE"
    echo "  app=$APP_PATH"
    echo "  manifest=$RELEASE_MANIFEST_PATH"
    echo "  app_build_receipt=$(app_build_receipt_path)"
    echo "  app_version=$VERSION"
    echo "  signing_authority=${SIGNING_AUTHORITY:-unknown}"
    echo "release_sendable=false"
    echo "reason=local-proof stops before notarization, DMG, ZIP, appcast, publish, install, launchd, and shared runtime changes"
    exit 0
    ;;
  build-app-only)
    echo "OpenClaw app bundle ready:"
    echo "  phase=$PACKAGE_PHASE"
    echo "  app=$APP_PATH"
    echo "  manifest=$RELEASE_MANIFEST_PATH"
    echo "  app_version=$VERSION"
    echo "  signing_authority=${SIGNING_AUTHORITY:-unknown}"
    echo "release_sendable=false"
    echo "reason=build-app-only stops before notarization, DMG, ZIP, appcast, and publish"
    exit 0
    ;;
  submit-app-notarization)
    ;;
  poll-app-notarization)
    ;;
  submit-dmg-notarization)
    ;;
  poll-dmg-notarization)
    ;;
  create-local-release-assets-only)
    openclaw_require_jarvis_release_intent "$ROOT_DIR" "$RELEASE_INTENT_ID" "local Sparkle asset creation"
    create_local_release_assets_only
    echo "release_sendable=false"
    echo "reason=local Sparkle ZIP/appcast were generated but not uploaded/verified"
    report_local_release_assets_next_phase
    exit 0
    ;;
  publish-assets-only)
    require_notarized_manifest_before_publish
    openclaw_require_jarvis_release_intent "$ROOT_DIR" "$RELEASE_INTENT_ID" "full public release publication"
    publish_release_assets
    write_release_manifest
    echo "release_sendable=true"
    echo "sparkle_update_live=true"
    exit 0
    ;;
  publish-sparkle-assets-only)
    require_sparkle_assets_before_publish
    openclaw_require_jarvis_release_intent "$ROOT_DIR" "$RELEASE_INTENT_ID" "Sparkle-only publication"
    publish_sparkle_release_assets
    write_release_manifest
    echo "sparkle_update_live=true"
    echo "release_sendable=false"
    echo "fresh_install_sendable=false"
    echo "dmg_update_live=false"
    echo "reason=Sparkle update is live for existing users; DMG/fresh-install package was not published by this phase"
    exit 0
    ;;
  verify-public-assets-only)
    openclaw_require_jarvis_release_intent "$ROOT_DIR" "$RELEASE_INTENT_ID" "full public release verification"
    verify_public_release_assets
    write_release_manifest
    echo "release_sendable=true"
    echo "sparkle_update_live=true"
    exit 0
    ;;
  verify-sparkle-assets-only)
    require_sparkle_assets_before_publish
    openclaw_require_jarvis_release_intent "$ROOT_DIR" "$RELEASE_INTENT_ID" "Sparkle-only public verification"
    verify_sparkle_public_release_assets
    write_release_manifest
    echo "sparkle_update_live=true"
    echo "release_sendable=false"
    echo "fresh_install_sendable=false"
    echo "dmg_update_live=false"
    echo "reason=Sparkle update assets are public; DMG/fresh-install package was not verified by this phase"
    exit 0
    ;;
esac

case "$PACKAGE_PHASE" in
  full|local-proof|post-app-build|trusted-ring-fast)
    # Remove stale final artifacts only when this run is about to recreate them.
    # Narrow resume phases must preserve the artifacts they are explicitly
    # resuming from.
    rm -f "$ZIP" "$DMG" "${DMG%.dmg}-rw.dmg"
    ;;
esac

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

case "$PACKAGE_PHASE" in
  submit-app-notarization)
    openclaw_require_jarvis_release_intent "$ROOT_DIR" "$RELEASE_INTENT_ID" "app notarization submission"
    # Keep the original submit status after the helper has persisted a
    # submitted receipt/checkpoint for any ambiguous Apple-side handoff.
    phase_status=0
    set +e
    submit_app_notarization_only
    phase_status=$?
    set -e
    if [[ $phase_status -ne 0 ]]; then
      exit "$phase_status"
    fi
    write_app_checkpoint_from_receipt app-notary-submitted
    echo "release_sendable=false"
    echo "reason=app notarization was submitted; poll the saved receipt before continuing"
    exit 0
    ;;
  poll-app-notarization)
    # Polling can rewrite the receipt and staple the app. Revalidate immediately
    # before that mutation so a replaced intent cannot finish an old release.
    openclaw_require_jarvis_release_intent "$ROOT_DIR" "$RELEASE_INTENT_ID" "app notarization poll"
    poll_app_notarization_only
    openclaw_require_jarvis_release_intent \
      "$ROOT_DIR" "$RELEASE_INTENT_ID" "app notarized checkpoint"
    write_app_checkpoint_from_receipt app-notarized
    echo "release_sendable=false"
    echo "reason=app notarization accepted; continue with --phase submit-dmg-notarization"
    exit 0
    ;;
  submit-dmg-notarization)
    openclaw_require_jarvis_release_intent "$ROOT_DIR" "$RELEASE_INTENT_ID" "DMG creation and notarization submission"
    phase_status=0
    set +e
    submit_dmg_notarization_only
    phase_status=$?
    set -e
    if [[ $phase_status -ne 0 ]]; then
      exit "$phase_status"
    fi
    write_dmg_checkpoint_from_receipt dmg-notary-submitted
    echo "release_sendable=false"
    echo "reason=DMG notarization was submitted; poll the saved receipt before continuing"
    exit 0
    ;;
  poll-dmg-notarization)
    # The accepted path staples the DMG and rewrites its receipt, so bind this
    # external poll to the still-current operator intent at the mutation seam.
    openclaw_require_jarvis_release_intent "$ROOT_DIR" "$RELEASE_INTENT_ID" "DMG notarization poll"
    poll_dmg_notarization_only
    openclaw_require_jarvis_release_intent \
      "$ROOT_DIR" "$RELEASE_INTENT_ID" "DMG notarized checkpoint"
    write_dmg_checkpoint_from_receipt dmg-notarized
    echo "release_sendable=false"
    if [[ ! -f "$ZIP" || ! -f "$ROOT_DIR/dist/jarvis-appcast.xml" ]]; then
      echo "reason=DMG notarization accepted; continue with --phase create-local-release-assets-only to create missing ZIP/appcast"
    else
      echo "reason=DMG notarization accepted; local ZIP/appcast exist, continue with --phase publish-assets-only --publish-release-assets --github-release-tag <latest-tag>"
    fi
    exit 0
    ;;
esac

if [[ "$NOTARIZE" == "1" ]]; then
  openclaw_require_jarvis_release_intent "$ROOT_DIR" "$RELEASE_INTENT_ID" "app notarization"
  echo "📦 Notary zip: $NOTARY_ZIP"
  rm -f "$NOTARY_ZIP"
  ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$NOTARY_ZIP"
  phase_status=0
  set +e
  OPENCLAW_NOTARY_FINAL_SUBMIT_INTENT_ROOT="$ROOT_DIR" \
  OPENCLAW_NOTARY_FINAL_SUBMIT_INTENT_ID="$RELEASE_INTENT_ID" \
  OPENCLAW_NOTARY_FINAL_POLL_INTENT_ROOT="$ROOT_DIR" \
  OPENCLAW_NOTARY_FINAL_POLL_INTENT_ID="$RELEASE_INTENT_ID" \
  STAPLE_APP_PATH="$APP_PATH" "$ROOT_DIR/scripts/notarize-mac-artifact.sh" \
    --receipt "$(app_notary_receipt_path)" \
    "$NOTARY_ZIP"
  phase_status=$?
  set -e
  if [[ $phase_status -ne 0 ]] && notary_receipt_has_submitted_submission_id "$(app_notary_receipt_path)"; then
    # Apple-side recovery must survive a transport error even if the intent
    # expired during the upload; this preserves facts, not a new mutation of
    # Apple's submission state.
    write_release_manifest
    write_app_checkpoint_from_receipt app-notary-submitted
    rm -f "$NOTARY_ZIP"
    exit "$phase_status"
  fi

  require_blocking_notary_result_intent app
  rm -f "$NOTARY_ZIP"
  require_blocking_notary_result_intent app
  write_release_manifest
  if [[ "$phase_status" -eq 0 ]]; then
    set +e
    OPENCLAW_CONSUMER_VERIFY_RELEASE=1 \
    SPARKLE_EXPECTED_PUBLIC_ED_KEY="${SPARKLE_PUBLIC_ED_KEY:-}" \
      verify_app_bundle
    phase_status=$?
    set -e
  fi
  if [[ "$phase_status" -ne 0 ]]; then
    if [[ "$(notary_receipt_status "$(app_notary_receipt_path)")" == "Accepted" ]]; then
      require_blocking_notary_result_intent app
      write_app_checkpoint_from_receipt app-notary-accepted
    fi
    exit "$phase_status"
  fi
  # Only make the accepted app resumable after the stricter release verifier
  # proves Gatekeeper plus the embedded production Sparkle identity.
  require_blocking_notary_result_intent app
  write_app_checkpoint_from_receipt app-notarized
fi

openclaw_require_jarvis_release_intent "$ROOT_DIR" "$RELEASE_INTENT_ID" "DMG creation"
create_signed_dmg

if [[ "$NOTARIZE" == "1" ]]; then
  openclaw_require_jarvis_release_intent "$ROOT_DIR" "$RELEASE_INTENT_ID" "DMG notarization"
  phase_status=0
  set +e
  OPENCLAW_NOTARY_FINAL_SUBMIT_INTENT_ROOT="$ROOT_DIR" \
  OPENCLAW_NOTARY_FINAL_SUBMIT_INTENT_ID="$RELEASE_INTENT_ID" \
  OPENCLAW_NOTARY_FINAL_POLL_INTENT_ROOT="$ROOT_DIR" \
  OPENCLAW_NOTARY_FINAL_POLL_INTENT_ID="$RELEASE_INTENT_ID" \
    "$ROOT_DIR/scripts/notarize-mac-artifact.sh" \
    --receipt "$(dmg_notary_receipt_path)" \
    "$DMG"
  phase_status=$?
  set -e
  if [[ $phase_status -ne 0 ]] && notary_receipt_has_submitted_submission_id "$(dmg_notary_receipt_path)"; then
    write_release_manifest
    write_dmg_checkpoint_from_receipt dmg-notary-submitted
    exit "$phase_status"
  fi

  require_blocking_notary_result_intent dmg
  set +e
  if [[ "$phase_status" -eq 0 ]]; then
    verify_dmg_gatekeeper "$DMG"
    phase_status=$?
  fi
  set -e
  require_blocking_notary_result_intent dmg
  write_release_manifest
  if [[ "$phase_status" -ne 0 ]]; then
    if [[ "$(notary_receipt_status "$(dmg_notary_receipt_path)")" == "Accepted" ]]; then
      require_blocking_notary_result_intent dmg
      write_dmg_checkpoint_from_receipt dmg-notary-accepted
    fi
    exit "$phase_status"
  fi
  require_blocking_notary_result_intent dmg
  write_dmg_checkpoint_from_receipt dmg-notarized
fi

echo "📦 Zip: $ZIP"
# Sparkle's ZIP must not include AppleDouble/resource-fork sidecars. The notary
# upload ZIP above still uses --sequesterRsrc; this user-download ZIP is the
# artifact Sparkle expands and validates during self-update.
zip_started_ms="$(release_phase_now_ms)"
ditto -c -k --norsrc --keepParent "$APP_PATH" "$ZIP"
assert_sparkle_zip_has_no_macos_metadata "$ZIP"
release_phase_log_elapsed "$zip_started_ms" "Sparkle ZIP create/verify"
appcast_started_ms="$(release_phase_now_ms)"
generate_jarvis_appcast
openclaw_jarvis_release_checkpoint_write "$ROOT_DIR" "$ZIP" zip sparkle-zip not-required "" "$APP_PATH"
if [[ "$NOTARIZE" == "1" ]]; then
  # Local smoke packaging intentionally skips appcast generation because it has
  # no production Sparkle signature. Only checkpoint a file created this run.
  openclaw_jarvis_release_checkpoint_write "$ROOT_DIR" "$ROOT_DIR/dist/jarvis-appcast.xml" appcast sparkle-appcast not-required "" "$APP_PATH"
fi
release_phase_log_elapsed "$appcast_started_ms" "Jarvis appcast"
write_release_manifest

if [[ "$SKIP_DSYM" != "1" ]]; then
  dsym_started_ms="$(release_phase_now_ms)"
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
  release_phase_log_elapsed "$dsym_started_ms" "dSYM package"
fi

# Notarization and dSYM assembly can be long enough for an operator to replace
# or let the lease expire. Revalidate at the final distribution seam so a
# canceled run cannot overwrite artifacts that humans may send to customers.
openclaw_require_jarvis_release_intent "$ROOT_DIR" "$RELEASE_INTENT_ID" "handoff artifact copy"
handoff_started_ms="$(release_phase_now_ms)"
copy_handoff_artifacts
release_phase_log_elapsed "$handoff_started_ms" "Handoff artifact copy"
if [[ "$PUBLISH_RELEASE_ASSETS" == "1" ]]; then
  require_notarized_manifest_before_publish
fi
openclaw_require_jarvis_release_intent "$ROOT_DIR" "$RELEASE_INTENT_ID" "public release publication"
publish_started_ms="$(release_phase_now_ms)"
publish_release_assets
release_phase_log_elapsed "$publish_started_ms" "Release asset publish/verify"
write_release_manifest

echo "OpenClaw distribution package ready:"
echo "  phase=$PACKAGE_PHASE"
echo "  app=$APP_PATH"
echo "  zip=$ZIP"
echo "  dmg=$DMG"
echo "  manifest=$RELEASE_MANIFEST_PATH"
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
