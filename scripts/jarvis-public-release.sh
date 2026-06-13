#!/usr/bin/env bash
set -euo pipefail

# Smart Jarvis public-release resume wrapper.
# It inspects dist receipts/manifests, chooses the next canonical package phase,
# then delegates execution to scripts/package-openclaw-mac-dist.sh.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/jarvis-release-orchestration.sh"

PACKAGE_SCRIPT="$ROOT_DIR/scripts/package-openclaw-mac-dist.sh"
STATE_ROOT="${OPENCLAW_JARVIS_RELEASE_STATE_ROOT:-$ROOT_DIR}"
DIST_DIR="$STATE_ROOT/dist"
APP_NAME="${APP_NAME:-Jarvis}"
DRY_RUN=0
PUBLISH_RELEASE_ASSETS=0
VERIFY_PUBLIC_ASSETS=0
FORCED_PHASE="auto"
GITHUB_RELEASE_TAG=""
GITHUB_RELEASE_REPO="${GITHUB_RELEASE_REPO:-artemgetmann/openclaw}"
TIMING_REPORT="${OPENCLAW_JARVIS_RELEASE_TIMING_REPORT:-$ROOT_DIR/dist/jarvis-release-timing.tsv}"
SUMMARY_REPORT="${OPENCLAW_JARVIS_PUBLIC_RELEASE_SUMMARY:-$ROOT_DIR/dist/jarvis-public-release-summary.env}"
RUN_SIZE_REPORT=0

usage() {
  cat <<'EOF'
Usage: scripts/jarvis-public-release.sh [options]

Chooses the next Jarvis public-release package phase from existing dist
artifacts, notary receipts, and dist/jarvis-release-manifest.env.

Options:
  --dry-run
      Print the selected phase and command without building, notarizing,
      uploading, or verifying public URLs.
  --publish-release-assets
      When local notarized assets are ready, choose publish-assets-only and pass
      the publish flags through to package-openclaw-mac-dist.sh.
  --verify-public-assets
      Choose verify-public-assets-only once local notarized assets are ready.
  --github-release-tag <tag>
      Required before any publish phase. Must be the latest release tag because
      Sparkle uses releases/latest/download/jarvis-appcast.xml.
  --phase <auto|full|post-app-build|submit-app-notarization|poll-app-notarization|submit-dmg-notarization|poll-dmg-notarization|create-local-release-assets-only|publish-assets-only|verify-public-assets-only>
      Override automatic phase selection. Use this only when the state report is
      correct but operator intent is narrower than the automatic next phase.
  --size-report
      Run scripts/report-jarvis-release-size.sh after a successful executed
      phase. This is read-only and never deletes bundle contents.

Env:
  OPENCLAW_JARVIS_RELEASE_STATE_ROOT=/path
      Test hook for --dry-run state inspection. Real executions still run the
      canonical package script from this checkout.
  OPENCLAW_GITHUB_RELEASE_RETRY_ATTEMPTS=3
  OPENCLAW_GITHUB_RELEASE_RETRY_SLEEP_SECS=5
EOF
}

quote_cmd() {
  local arg
  for arg in "$@"; do
    printf '%q ' "$arg"
  done
  printf '\n'
}

iso_now() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

write_summary_report() {
  local selected_phase="$1"
  local status="$2"
  local started_at="$3"
  local finished_at="$4"
  local elapsed_seconds="$5"
  local command_text="$6"

  mkdir -p "$(dirname "$SUMMARY_REPORT")"
  {
    printf 'JARVIS_PUBLIC_RELEASE_SUMMARY_VERSION=%q\n' "1"
    printf 'JARVIS_PUBLIC_RELEASE_PHASE=%q\n' "$selected_phase"
    printf 'JARVIS_PUBLIC_RELEASE_STATUS=%q\n' "$status"
    printf 'JARVIS_PUBLIC_RELEASE_STARTED_AT=%q\n' "$started_at"
    printf 'JARVIS_PUBLIC_RELEASE_FINISHED_AT=%q\n' "$finished_at"
    printf 'JARVIS_PUBLIC_RELEASE_ELAPSED_SECONDS=%q\n' "$elapsed_seconds"
    printf 'JARVIS_PUBLIC_RELEASE_COMMAND=%q\n' "$command_text"
    printf 'JARVIS_PUBLIC_RELEASE_STATE_ROOT=%q\n' "$STATE_ROOT"
    printf 'JARVIS_PUBLIC_RELEASE_MANIFEST=%q\n' "$(jarvis_release_manifest_path "$STATE_ROOT")"
    printf 'JARVIS_PUBLIC_RELEASE_TIMING_REPORT=%q\n' "$TIMING_REPORT"
  } >"$SUMMARY_REPORT"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --publish-release-assets)
      PUBLISH_RELEASE_ASSETS=1
      shift
      ;;
    --verify-public-assets)
      VERIFY_PUBLIC_ASSETS=1
      shift
      ;;
    --github-release-tag)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --github-release-tag requires a value." >&2
        exit 1
      fi
      GITHUB_RELEASE_TAG="$2"
      shift 2
      ;;
    --phase)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --phase requires a value." >&2
        exit 1
      fi
      FORCED_PHASE="$2"
      shift 2
      ;;
    --size-report)
      RUN_SIZE_REPORT=1
      shift
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

if [[ "$PUBLISH_RELEASE_ASSETS" == "1" && "$VERIFY_PUBLIC_ASSETS" == "1" ]]; then
  echo "ERROR: choose --publish-release-assets or --verify-public-assets, not both." >&2
  exit 1
fi

if [[ "$PUBLISH_RELEASE_ASSETS" == "1" && -z "$GITHUB_RELEASE_TAG" ]]; then
  echo "ERROR: --publish-release-assets requires --github-release-tag <latest-tag>." >&2
  exit 1
fi

case "$FORCED_PHASE" in
  auto|full|post-app-build|submit-app-notarization|poll-app-notarization|submit-dmg-notarization|poll-dmg-notarization|create-local-release-assets-only|publish-assets-only|verify-public-assets-only)
    ;;
  *)
    echo "ERROR: unsupported --phase value for public-release wrapper: $FORCED_PHASE" >&2
    exit 1
    ;;
esac

if [[ "$FORCED_PHASE" == "auto" ]]; then
  SELECTED_PHASE="$(
    jarvis_release_next_phase "$STATE_ROOT" "$PUBLISH_RELEASE_ASSETS" "$VERIFY_PUBLIC_ASSETS" "$APP_NAME"
  )"
else
  SELECTED_PHASE="$FORCED_PHASE"
fi

if [[ "$SELECTED_PHASE" == "ready-local-assets" ]]; then
  echo "Jarvis public release local assets are ready, but no public action was requested."
  echo "  state_root=$STATE_ROOT"
  echo "  manifest=$(jarvis_release_manifest_path "$STATE_ROOT")"
  echo "  next_publish_command=bash scripts/jarvis-public-release.sh --publish-release-assets --github-release-tag <latest-tag>"
  echo "  appcast_upload_remains_last=true"
  exit 0
fi

CMD=(bash "$PACKAGE_SCRIPT" --phase "$SELECTED_PHASE")
case "$SELECTED_PHASE" in
  full|post-app-build)
    if [[ "$PUBLISH_RELEASE_ASSETS" == "1" ]]; then
      CMD+=(--publish-release-assets --github-release-tag "$GITHUB_RELEASE_TAG")
    fi
    ;;
  publish-assets-only)
    CMD+=(--publish-release-assets --github-release-tag "$GITHUB_RELEASE_TAG")
    ;;
  verify-public-assets-only)
    if [[ -n "$GITHUB_RELEASE_TAG" ]]; then
      CMD+=(--github-release-tag "$GITHUB_RELEASE_TAG")
    fi
    ;;
esac

COMMAND_TEXT="$(quote_cmd "${CMD[@]}")"
echo "Jarvis public release orchestration:"
echo "  selected_phase=$SELECTED_PHASE"
echo "  state_root=$STATE_ROOT"
echo "  manifest=$(jarvis_release_manifest_path "$STATE_ROOT")"
echo "  command=$COMMAND_TEXT"
echo "  appcast_upload_remains_last=true"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "dry_run=true"
  exit 0
fi

started_at="$(iso_now)"
started_epoch="$(date +%s)"
set +e
PACKAGE_TIMING=1 \
OPENCLAW_JARVIS_RELEASE_TIMING_REPORT="$TIMING_REPORT" \
  "${CMD[@]}"
status=$?
set -e
finished_at="$(iso_now)"
finished_epoch="$(date +%s)"
elapsed_seconds="$((finished_epoch - started_epoch))"

if [[ "$status" -eq 0 && "$RUN_SIZE_REPORT" == "1" ]]; then
  bash "$ROOT_DIR/scripts/report-jarvis-release-size.sh" --app "$ROOT_DIR/dist/${APP_NAME}.app"
fi

write_summary_report "$SELECTED_PHASE" "$status" "$started_at" "$finished_at" "$elapsed_seconds" "$COMMAND_TEXT"

echo "Jarvis public release summary:"
echo "  phase=$SELECTED_PHASE"
echo "  status=$status"
echo "  elapsed_seconds=$elapsed_seconds"
echo "  summary=$SUMMARY_REPORT"
echo "  timing_report=$TIMING_REPORT"

exit "$status"
