#!/usr/bin/env bash
set -euo pipefail

# Smart Jarvis public-release resume wrapper.
# It inspects dist receipts/manifests, chooses the next canonical package phase,
# then delegates execution to scripts/package-openclaw-mac-dist.sh.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Public-wrapper and delegated-package decisions must observe one release
# configuration snapshot. Ignore a stale "already loaded" marker, establish the
# canonical default repository before sourcing, then let the selected
# release.env override it once. The package child inherits this loaded snapshot
# and cannot silently switch destinations after authorization.
unset OPENCLAW_RELEASE_ENV_LOADED
GITHUB_RELEASE_REPO="artemgetmann/openclaw"
source "$ROOT_DIR/scripts/lib/release-env.sh"
source "$ROOT_DIR/scripts/lib/jarvis-release-orchestration.sh"
source "$ROOT_DIR/scripts/lib/macos-release-gates.sh"
source "$ROOT_DIR/scripts/lib/shared-resource-lock.sh"
source "$ROOT_DIR/scripts/lib/jarvis-release-lock.sh"
source "$ROOT_DIR/scripts/lib/jarvis-release-intent.sh"
source "$ROOT_DIR/scripts/lib/jarvis-release-checkpoint.sh"

PACKAGE_SCRIPT="$ROOT_DIR/scripts/package-openclaw-mac-dist.sh"
STATE_ROOT="${OPENCLAW_JARVIS_RELEASE_STATE_ROOT:-$ROOT_DIR}"
DIST_DIR="$STATE_ROOT/dist"
APP_NAME="${APP_NAME:-Jarvis}"
DRY_RUN=0
PUBLISH_RELEASE_ASSETS=0
VERIFY_PUBLIC_ASSETS=0
FORCED_PHASE="auto"
GITHUB_RELEASE_TAG=""
LATEST_RELEASE_TAG=0
GITHUB_RELEASE_REPO="${GITHUB_RELEASE_REPO:-artemgetmann/openclaw}"
export GITHUB_RELEASE_REPO
TIMING_REPORT="${OPENCLAW_JARVIS_RELEASE_TIMING_REPORT:-$ROOT_DIR/dist/jarvis-release-timing.tsv}"
SUMMARY_REPORT="${OPENCLAW_JARVIS_PUBLIC_RELEASE_SUMMARY:-$ROOT_DIR/dist/jarvis-public-release-summary.env}"
RUN_SIZE_REPORT=0
REQUESTED_APP_BUILD=""
PARALLEL_SAFE_LOCAL_ASSETS=0
RELEASE_CLASS="sparkle-update"
RELEASE_CLASS_REASON="routine-existing-user-update"
AUTHORIZE_RELEASE=0
RELEASE_INTENT_ID=""
RELEASE_INTENT_TTL_SECONDS=7200
RELEASE_INTENT_TTL_EXPLICIT=0
ORIGINAL_WRAPPER_ARGS=("$@")
WRAPPER_RECOVERY_EMITTED=0

usage() {
  cat <<'EOF'
Usage: scripts/jarvis-public-release.sh [options]

Chooses the next Jarvis public-release package phase from existing dist
artifacts, notary receipts, and dist/jarvis-release-manifest.env.

Options:
  --authorize
      Create the latest expiring release intent for the current commit and bind
      it to clean tracked state, then print the one exact command that may
      execute it plus the exact persistent tmux transport command. Validated
      future execution flags may accompany authorization; they remain inert
      until that printed command runs. Authorization does not build, sign,
      notarize, upload, query GitHub, or inspect release artifacts.
  --release-intent <id>
      Required for every non-dry-run release execution. Only the latest
      unexpired intent created by --authorize is accepted.
  --intent-ttl-seconds <seconds>
      Authorization lifetime for --authorize (default 7200, maximum 14400).
  --dry-run
      Print the selected phase and command without building, notarizing,
      uploading, or verifying public URLs.
  --publish-release-assets
      When local notarized assets are ready, choose publish-assets-only and pass
      the publish flags through to package-openclaw-mac-dist.sh.
  --verify-public-assets
      Choose verify-public-assets-only once local notarized assets are ready.
      Real verification requires --github-release-tag or --latest-release-tag
      because the appcast ZIP enclosure is pinned to an immutable tagged
      release URL.
  --github-release-tag <tag>
      Required before any publish phase. Must be the latest release tag because
      Sparkle uses releases/latest/download/jarvis-appcast.xml.
  --latest-release-tag
      Resolve the latest release tag for GITHUB_RELEASE_REPO with GitHub CLI
      before building the package command. Mutually exclusive with
      --github-release-tag so publish intent stays unambiguous.
  --parallel-safe-local-assets
      Opt into the P2 safe overlap path. After app notarization is accepted and
      DMG notarization has a submitted receipt, create local Jarvis.zip/appcast
      before the separate resumable DMG polling step finishes.
  --release-class <sparkle-update|fresh-installer>
      Routine releases default to sparkle-update and never create or publish a
      DMG. fresh-installer keeps the sendable installer lane and requires an
      explicit --release-class-reason.
  --release-class-reason <reason>
      Required for fresh-installer: first-release, recovery, security,
      compatibility, installer-age, or manual-refresh.
  --urgent-sparkle
      Backward-compatible alias for --release-class sparkle-update. Once the
      app notarization is accepted and local Jarvis.zip/appcast exist, publish
      and verify only the Sparkle update assets. This does not publish Jarvis.dmg
      and must not be treated as a fresh-install/sendable DMG release.
  --phase <auto|full|post-app-build|submit-app-notarization|poll-app-notarization|submit-dmg-notarization|poll-dmg-notarization|create-local-release-assets-only|publish-assets-only|verify-public-assets-only|publish-sparkle-assets-only|verify-sparkle-assets-only>
      Override automatic phase selection. Use this only when the state report is
      correct but operator intent is narrower than the automatic next phase.
  --size-report
      Run scripts/report-jarvis-release-size.sh after a successful executed
      phase. This is read-only and never deletes bundle contents.
  --app-build <number>
      Use this Sparkle build number for the authorized release. This explicit
      argument overrides APP_BUILD from the canonical release.env and survives
      the durable release session.

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

quote_cmd_exact() {
  local separator=""
  local arg

  # Authorization output is an operator-facing executable contract. Build it
  # from parsed argv rather than interpolated shell text so tags and other
  # values remain one literal argument even when they contain shell syntax.
  for arg in "$@"; do
    printf '%s' "$separator"
    printf '%q' "$arg"
    separator=" "
  done
  printf '\n'
}

release_action_fingerprint() {
  # Bind only execution-shaping choices. Authorization mechanics, intent ID,
  # and dry-run are deliberately excluded. Fixed field order and separators
  # make the digest independent of the spelling/order of equivalent argv.
  if [[ "$PUBLISH_RELEASE_ASSETS" == "0" \
    && "$VERIFY_PUBLIC_ASSETS" == "0" \
    && "$FORCED_PHASE" == "auto" \
    && -z "$GITHUB_RELEASE_TAG" \
    && "$LATEST_RELEASE_TAG" == "0" \
    && "$PARALLEL_SAFE_LOCAL_ASSETS" == "0" \
    && "$RELEASE_CLASS" == "sparkle-update" \
    && "$RELEASE_CLASS_REASON" == "routine-existing-user-update" \
    && "$RUN_SIZE_REPORT" == "0" \
    && -z "$REQUESTED_APP_BUILD" ]]; then
    printf '\n'
    return 0
  fi

  {
    printf 'jarvis-public-release-action-v1\0'
    printf 'publish=%s\0' "$PUBLISH_RELEASE_ASSETS"
    printf 'verify=%s\0' "$VERIFY_PUBLIC_ASSETS"
    printf 'phase=%s\0' "$FORCED_PHASE"
    printf 'tag=%s\0' "$GITHUB_RELEASE_TAG"
    printf 'latest=%s\0' "$LATEST_RELEASE_TAG"
    printf 'github-repo=%s\0' "$GITHUB_RELEASE_REPO"
    printf 'parallel=%s\0' "$PARALLEL_SAFE_LOCAL_ASSETS"
    printf 'release-class=%s\0' "$RELEASE_CLASS"
    printf 'release-class-reason=%s\0' "$RELEASE_CLASS_REASON"
    printf 'size=%s\0' "$RUN_SIZE_REPORT"
    printf 'app-build=%s\0' "$REQUESTED_APP_BUILD"
  } | /usr/bin/shasum -a 256 | /usr/bin/awk '{ print $1 }'
}

original_wrapper_command() {
  quote_cmd bash scripts/jarvis-public-release.sh "${ORIGINAL_WRAPPER_ARGS[@]}"
}

release_wrapper_exit() {
  local status="$?"
  openclaw_jarvis_release_lock_release
  if [[ "$status" -ne 0 && "$WRAPPER_RECOVERY_EMITTED" != "1" ]]; then
    echo "recovery_command=$(original_wrapper_command)" >&2
  fi
  exit "$status"
}

resolve_latest_github_release_tag() {
  local latest_json=""
  local latest_tag=""
  local status=0

  if ! command -v gh >/dev/null 2>&1; then
    echo "ERROR: --latest-release-tag requires the GitHub CLI (gh)." >&2
    exit 1
  fi

  # Keep this wrapper read-only: it asks GitHub which release is latest, then
  # passes the resolved tag into the existing package-script safety gates. The
  # upload path still requires --publish-release-assets explicitly.
  set +e
  latest_json="$(
    jarvis_release_retry \
      "gh release view latest for $GITHUB_RELEASE_REPO" \
      gh release view --repo "$GITHUB_RELEASE_REPO" --json tagName
  )"
  status=$?
  set -e
  if [[ "$status" -ne 0 ]]; then
    echo "ERROR: could not resolve the latest GitHub release tag for $GITHUB_RELEASE_REPO." >&2
    printf '%s\n' "$latest_json" >&2
    exit "$status"
  fi

  latest_tag="$(
    printf '%s\n' "$latest_json" \
      | /usr/bin/sed -n 's/.*"tagName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
      | /usr/bin/head -n 1
  )"

  if [[ -z "$latest_tag" ]]; then
    echo "ERROR: no latest GitHub release tag found for $GITHUB_RELEASE_REPO." >&2
    printf '%s\n' "$latest_json" >&2
    exit 1
  fi

  printf '%s\n' "$latest_tag"
}

iso_now() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

ensure_timing_report() {
  # The package script creates this file lazily when a phase records a timed
  # section. Wrapper-only exits, preflight failures, and verify-only phases can
  # still write a summary, so initialize the report before summaries reference
  # it.
  mkdir -p "$(dirname "$TIMING_REPORT")"
  if [[ ! -f "$TIMING_REPORT" ]]; then
    printf 'phase\tlabel\tstatus\tstarted_ms\tfinished_ms\telapsed_ms\n' >"$TIMING_REPORT"
  fi
}

write_summary_report() {
  local selected_phase="$1"
  local status="$2"
  local started_at="$3"
  local finished_at="$4"
  local elapsed_seconds="$5"
  local command_text="$6"

  mkdir -p "$(dirname "$SUMMARY_REPORT")"
  ensure_timing_report
  {
    printf 'JARVIS_PUBLIC_RELEASE_SUMMARY_VERSION=%q\n' "1"
    printf 'JARVIS_PUBLIC_RELEASE_PHASE=%q\n' "$selected_phase"
    printf 'JARVIS_RELEASE_CLASS=%q\n' "$RELEASE_CLASS"
    printf 'JARVIS_RELEASE_CLASS_REASON=%q\n' "$RELEASE_CLASS_REASON"
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

tagged_zip_url() {
  local tag="$1"
  printf 'https://github.com/%s/releases/download/%s/Jarvis.zip\n' "$GITHUB_RELEASE_REPO" "$tag"
}

appcast_targets_tagged_zip() {
  local appcast="$DIST_DIR/jarvis-appcast.xml"
  local expected_url="$1"

  [[ -f "$appcast" ]] || return 1
  /usr/bin/grep -Fq "url=\"$expected_url\"" "$appcast" \
    || /usr/bin/grep -Fq "url='$expected_url'" "$appcast"
}

fail_before_execute() {
  local status="$1"
  shift
  local now
  now="$(iso_now)"

  local line
  for line in "$@"; do
    echo "$line" >&2
  done

  write_summary_report "$SELECTED_PHASE" "$status" "$now" "$now" "0" "$COMMAND_TEXT"
  echo "Jarvis public release summary:" >&2
  echo "  phase=$SELECTED_PHASE" >&2
  echo "  status=$status" >&2
  echo "  elapsed_seconds=0" >&2
  echo "  summary=$SUMMARY_REPORT" >&2
  echo "  timing_report=$TIMING_REPORT" >&2
  case "${OPENCLAW_JARVIS_RELEASE_INTENT_FAILURE:-}" in
    missing|expired|replaced|commit|identity|schema|action|action-schema|tracked-state-drift|tracked-state-unavailable)
      WRAPPER_RECOVERY_EMITTED=1
      echo "recovery_command=bash scripts/jarvis-public-release.sh --authorize" >&2
      ;;
    *)
      WRAPPER_RECOVERY_EMITTED=1
      echo "recovery_command=$RECOVERY_COMMAND" >&2
      ;;
  esac
  exit "$status"
}

checkpoint_valid() {
  openclaw_jarvis_release_checkpoint_validate "$ROOT_DIR" "$@" >/dev/null 2>&1
}

select_checkpoint_safe_phase() {
  local app="$DIST_DIR/${APP_NAME}.app"
  local dmg="$DIST_DIR/${APP_NAME}.dmg"
  local zip="$DIST_DIR/${APP_NAME}.zip"
  local appcast="$DIST_DIR/jarvis-appcast.xml"
  local app_receipt="$DIST_DIR/${APP_NAME}.app.notary.env"
  local dmg_receipt="$DIST_DIR/${APP_NAME}.dmg.notary.env"
  local app_state=""
  local dmg_state=""

  # Resume state flows only from strict artifact checkpoints. The manifest is
  # intentionally absent from this decision: Accepted text plus file existence
  # is operator context, not proof that those bytes belong to this commit.
  if checkpoint_valid "$app" app app-notarized "$app_receipt"; then
    app_state="notarized"
  elif checkpoint_valid "$app" app app-notary-accepted "$app_receipt"; then
    app_state="accepted"
  elif checkpoint_valid "$app" app app-notary-submitted "$app_receipt"; then
    app_state="submitted"
  elif checkpoint_valid "$app" app app-signed; then
    app_state="signed"
  else
    if [[ "$RELEASE_CLASS" == "sparkle-update" ]]; then
      printf '%s\n' "sparkle-update"
    else
      printf '%s\n' "full"
    fi
    return 0
  fi

  if [[ "$app_state" == "signed" ]]; then
    printf '%s\n' "submit-app-notarization"
    return 0
  fi
  if [[ "$app_state" == "submitted" || "$app_state" == "accepted" ]]; then
    printf '%s\n' "poll-app-notarization"
    return 0
  fi

  if [[ "$RELEASE_CLASS" == "sparkle-update" ]]; then
    if ! checkpoint_valid "$zip" zip sparkle-zip "" "$app" || ! checkpoint_valid "$appcast" appcast sparkle-appcast "" "$app"; then
      printf '%s\n' "create-local-release-assets-only"
    elif [[ "$VERIFY_PUBLIC_ASSETS" == "1" ]]; then
      printf '%s\n' "verify-sparkle-assets-only"
    elif [[ "$PUBLISH_RELEASE_ASSETS" == "1" ]]; then
      printf '%s\n' "publish-sparkle-assets-only"
    else
      printf '%s\n' "ready-sparkle-local-assets"
    fi
    return 0
  fi

  if checkpoint_valid "$dmg" dmg dmg-notarized "$dmg_receipt" "$app"; then
    dmg_state="notarized"
  elif checkpoint_valid "$dmg" dmg dmg-notary-accepted "$dmg_receipt" "$app"; then
    dmg_state="accepted"
  elif checkpoint_valid "$dmg" dmg dmg-notary-submitted "$dmg_receipt" "$app"; then
    dmg_state="submitted"
  elif checkpoint_valid "$dmg" dmg dmg-signed "" "$app"; then
    dmg_state="signed"
  fi

  case "$dmg_state" in
    notarized)
      if ! checkpoint_valid "$zip" zip sparkle-zip "" "$app" || ! checkpoint_valid "$appcast" appcast sparkle-appcast "" "$app"; then
        printf '%s\n' "create-local-release-assets-only"
      elif [[ "$VERIFY_PUBLIC_ASSETS" == "1" ]]; then
        printf '%s\n' "verify-public-assets-only"
      elif [[ "$PUBLISH_RELEASE_ASSETS" == "1" ]]; then
        printf '%s\n' "publish-assets-only"
      else
        printf '%s\n' "ready-local-assets"
      fi
      ;;
    submitted|accepted)
      if [[ "$PARALLEL_SAFE_LOCAL_ASSETS" == "1" ]] \
        && { ! checkpoint_valid "$zip" zip sparkle-zip "" "$app" || ! checkpoint_valid "$appcast" appcast sparkle-appcast "" "$app"; }; then
        printf '%s\n' "create-local-release-assets-only"
      else
        printf '%s\n' "poll-dmg-notarization"
      fi
      ;;
    signed|"")
      printf '%s\n' "submit-dmg-notarization"
      ;;
  esac
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --authorize)
      AUTHORIZE_RELEASE=1
      shift
      ;;
    --release-intent)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --release-intent requires a value." >&2
        exit 1
      fi
      RELEASE_INTENT_ID="$2"
      shift 2
      ;;
    --intent-ttl-seconds)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --intent-ttl-seconds requires a value." >&2
        exit 1
      fi
      RELEASE_INTENT_TTL_SECONDS="$2"
      RELEASE_INTENT_TTL_EXPLICIT=1
      shift 2
      ;;
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
    --latest-release-tag)
      LATEST_RELEASE_TAG=1
      shift
      ;;
    --phase)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --phase requires a value." >&2
        exit 1
      fi
      FORCED_PHASE="$2"
      shift 2
      ;;
    --parallel-safe-local-assets)
      PARALLEL_SAFE_LOCAL_ASSETS=1
      shift
      ;;
    --release-class)
      [[ $# -ge 2 ]] || { echo "ERROR: --release-class requires a value." >&2; exit 1; }
      RELEASE_CLASS="$2"
      shift 2
      ;;
    --release-class-reason)
      [[ $# -ge 2 ]] || { echo "ERROR: --release-class-reason requires a value." >&2; exit 1; }
      RELEASE_CLASS_REASON="$2"
      shift 2
      ;;
    --urgent-sparkle|--sparkle-update-only)
      RELEASE_CLASS="sparkle-update"
      RELEASE_CLASS_REASON="routine-existing-user-update"
      shift
      ;;
    --size-report)
      RUN_SIZE_REPORT=1
      shift
      ;;
    --app-build)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --app-build requires a numeric value." >&2
        exit 1
      fi
      REQUESTED_APP_BUILD="$2"
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

case "$RELEASE_CLASS" in
  sparkle-update)
    if [[ "$RELEASE_CLASS_REASON" != "routine-existing-user-update" ]]; then
      echo "ERROR: sparkle-update uses the fixed reason routine-existing-user-update." >&2
      exit 1
    fi
    ;;
  fresh-installer)
    case "$RELEASE_CLASS_REASON" in
      first-release|recovery|security|compatibility|installer-age|manual-refresh) ;;
      *)
        echo "ERROR: fresh-installer requires --release-class-reason first-release|recovery|security|compatibility|installer-age|manual-refresh." >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "ERROR: --release-class must be sparkle-update or fresh-installer." >&2
    exit 1
    ;;
esac

if [[ -n "$REQUESTED_APP_BUILD" && ! "$REQUESTED_APP_BUILD" =~ ^[0-9]+$ ]]; then
  echo "ERROR: --app-build must be numeric for Sparkle compare (CFBundleVersion). Got: $REQUESTED_APP_BUILD" >&2
  exit 1
fi

if [[ "$PUBLISH_RELEASE_ASSETS" == "1" && "$VERIFY_PUBLIC_ASSETS" == "1" ]]; then
  echo "ERROR: choose --publish-release-assets or --verify-public-assets, not both." >&2
  exit 1
fi

if [[ "$LATEST_RELEASE_TAG" == "1" && -n "$GITHUB_RELEASE_TAG" ]]; then
  echo "ERROR: choose --latest-release-tag or --github-release-tag <tag>, not both." >&2
  echo "The release wrapper refuses ambiguous tag intent before publish/verify commands." >&2
  exit 1
fi

case "$FORCED_PHASE" in
  auto|sparkle-update|full|post-app-build|submit-app-notarization|poll-app-notarization|submit-dmg-notarization|poll-dmg-notarization|create-local-release-assets-only|publish-assets-only|verify-public-assets-only|publish-sparkle-assets-only|verify-sparkle-assets-only)
    ;;
  *)
    echo "ERROR: unsupported --phase value for public-release wrapper: $FORCED_PHASE" >&2
    exit 1
    ;;
esac

# A release class is a durable statement about external effects, not a label.
# Reject forced phases that contradict it before authorization or state access.
case "$RELEASE_CLASS:$FORCED_PHASE" in
  sparkle-update:submit-dmg-notarization|sparkle-update:poll-dmg-notarization|sparkle-update:publish-assets-only|sparkle-update:verify-public-assets-only)
    echo "ERROR: --release-class sparkle-update cannot execute DMG/full-public phase $FORCED_PHASE." >&2
    exit 1
    ;;
  fresh-installer:sparkle-update|fresh-installer:publish-sparkle-assets-only|fresh-installer:verify-sparkle-assets-only)
    echo "ERROR: --release-class fresh-installer cannot execute Sparkle-only phase $FORCED_PHASE." >&2
    exit 1
    ;;
esac
if [[ "$RELEASE_CLASS" == "sparkle-update" && "$PARALLEL_SAFE_LOCAL_ASSETS" == "1" ]]; then
  echo "ERROR: --parallel-safe-local-assets is a fresh-installer DMG overlap mode." >&2
  exit 1
fi

case "$FORCED_PHASE" in
  publish-assets-only|publish-sparkle-assets-only)
    if [[ "$PUBLISH_RELEASE_ASSETS" != "1" || "$VERIFY_PUBLIC_ASSETS" == "1" ]]; then
      echo "ERROR: --phase $FORCED_PHASE requires --publish-release-assets and cannot be combined with --verify-public-assets." >&2
      exit 1
    fi
    ;;
  verify-public-assets-only|verify-sparkle-assets-only)
    if [[ "$PUBLISH_RELEASE_ASSETS" == "1" ]]; then
      echo "ERROR: --phase $FORCED_PHASE cannot be combined with --publish-release-assets." >&2
      exit 1
    fi
    ;;
esac

if [[ "$AUTHORIZE_RELEASE" == "1" ]]; then
  if [[ "$DRY_RUN" == "1" || -n "$RELEASE_INTENT_ID" ]]; then
    echo "ERROR: --authorize cannot be combined with --dry-run or --release-intent." >&2
    exit 1
  fi
  if [[ ( "$PUBLISH_RELEASE_ASSETS" == "1" || "$VERIFY_PUBLIC_ASSETS" == "1" || "$FORCED_PHASE" == "create-local-release-assets-only" || "$FORCED_PHASE" == "publish-assets-only" || "$FORCED_PHASE" == "verify-public-assets-only" || "$FORCED_PHASE" == "publish-sparkle-assets-only" || "$FORCED_PHASE" == "verify-sparkle-assets-only" ) && "$LATEST_RELEASE_TAG" != "1" && -z "$GITHUB_RELEASE_TAG" ]]; then
    echo "ERROR: the authorized future command requires --latest-release-tag or --github-release-tag <tag>." >&2
    echo "Authorization was not created because next_command would be incomplete." >&2
    exit 1
  fi
  openclaw_require_jarvis_release_worktree "$ROOT_DIR"
  RELEASE_ACTION_FINGERPRINT="$(release_action_fingerprint)"
  if ! RELEASE_INTENT_ID="$(openclaw_jarvis_release_intent_authorize "$ROOT_DIR" "$RELEASE_INTENT_TTL_SECONDS" "$RELEASE_ACTION_FINGERPRINT")"; then
    echo "recovery_command=bash scripts/jarvis-public-release.sh --authorize" >&2
    exit 2
  fi
  echo "jarvis_release_intent=authorized"
  echo "jarvis_release_intent_id=$RELEASE_INTENT_ID"

  # Future execution flags are inert during authorization. Preserve only the
  # already-parsed allowlist in a canonical argv order; notably,
  # --latest-release-tag stays unresolved until the authorized command runs.
  AUTHORIZED_ARGS=(--release-intent "$RELEASE_INTENT_ID")
  [[ "$PUBLISH_RELEASE_ASSETS" != "1" ]] || AUTHORIZED_ARGS+=(--publish-release-assets)
  [[ "$VERIFY_PUBLIC_ASSETS" != "1" ]] || AUTHORIZED_ARGS+=(--verify-public-assets)
  [[ -z "$GITHUB_RELEASE_TAG" ]] || AUTHORIZED_ARGS+=(--github-release-tag "$GITHUB_RELEASE_TAG")
  [[ "$LATEST_RELEASE_TAG" != "1" ]] || AUTHORIZED_ARGS+=(--latest-release-tag)
  [[ "$PARALLEL_SAFE_LOCAL_ASSETS" != "1" ]] || AUTHORIZED_ARGS+=(--parallel-safe-local-assets)
  AUTHORIZED_ARGS+=(--release-class "$RELEASE_CLASS")
  [[ "$RELEASE_CLASS" != "fresh-installer" ]] || AUTHORIZED_ARGS+=(--release-class-reason "$RELEASE_CLASS_REASON")
  [[ "$FORCED_PHASE" == "auto" ]] || AUTHORIZED_ARGS+=(--phase "$FORCED_PHASE")
  [[ "$RUN_SIZE_REPORT" != "1" ]] || AUTHORIZED_ARGS+=(--size-report)
  [[ -z "$REQUESTED_APP_BUILD" ]] || AUTHORIZED_ARGS+=(--app-build "$REQUESTED_APP_BUILD")

  printf 'next_command='
  quote_cmd_exact bash scripts/jarvis-public-release.sh "${AUTHORIZED_ARGS[@]}"
  printf 'persistent_command='
  quote_cmd_exact \
    bash scripts/jarvis-public-release-session.sh start -- "${AUTHORIZED_ARGS[@]}"
  exit 0
fi

if [[ "$RELEASE_INTENT_TTL_EXPLICIT" == "1" ]]; then
  echo "ERROR: --intent-ttl-seconds is valid only with standalone --authorize." >&2
  exit 1
fi

if [[ "$DRY_RUN" != "1" ]]; then
  # Authorization and dry-run intentionally remain lightweight. Executed
  # release orchestration acquires release-jarvis before intent/state work.
  openclaw_shared_resource_lock_require_or_reexec \
    release-jarvis \
    "jarvis-public-release:${FORCED_PHASE}" \
    "$ROOT_DIR" \
    "$ROOT_DIR/scripts/jarvis-public-release.sh" \
    "${ORIGINAL_WRAPPER_ARGS[@]}"
fi

# Recompute action binding from parsed values before any lock, report, release
# state, GitHub, or package activity. Bound intents cannot be repurposed by
# changing verify into publish (or any other execution-shaping flag). Exporting
# the digest lets the unchanged package/notary intent gates enforce the same
# lease; direct package use of a bound wrapper intent has no digest and fails.
RELEASE_ACTION_FINGERPRINT="$(release_action_fingerprint)"
export OPENCLAW_JARVIS_RELEASE_INTENT_ACTION_FINGERPRINT="$RELEASE_ACTION_FINGERPRINT"
RELEASE_INTENT_ACTION_BOUND=0
if [[ "$DRY_RUN" != "1" ]]; then
  if openclaw_jarvis_release_intent_validate "$ROOT_DIR" "$RELEASE_INTENT_ID"; then
    if [[ -n "$OPENCLAW_JARVIS_RELEASE_INTENT_VALIDATED_ACTION_FINGERPRINT" ]]; then
      RELEASE_INTENT_ACTION_BOUND=1
    fi
  elif [[ "$OPENCLAW_JARVIS_RELEASE_INTENT_FAILURE" == "action" ]]; then
    echo "ERROR: release intent action does not match this wrapper command; refusing before release mutation." >&2
    echo "recovery_command=bash scripts/jarvis-public-release.sh --authorize" >&2
    exit 2
  fi
fi

# Apply the authorized build before checkpoint discovery. Resume validation and
# the delegated package child must compare artifacts against the same build;
# otherwise a stale release.env can turn a safe resume into a needless rebuild.
if [[ -n "$REQUESTED_APP_BUILD" ]]; then
  export APP_BUILD="$REQUESTED_APP_BUILD"
fi

if [[ "$LATEST_RELEASE_TAG" == "1" ]]; then
  GITHUB_RELEASE_TAG="$(resolve_latest_github_release_tag)"
fi

if [[ "$DRY_RUN" != "1" ]]; then
  # Own the state snapshot and delegated package execution as one operation.
  # Locking only the package child leaves a race where two wrappers choose the
  # same stale next phase before either child starts.
  trap release_wrapper_exit EXIT
  openclaw_require_jarvis_release_worktree "$ROOT_DIR"
  if openclaw_jarvis_release_lock_acquire "$ROOT_DIR" "public-release-orchestration"; then
    :
  else
    lock_status=$?
    trap release_wrapper_exit EXIT
    exit "$lock_status"
  fi
  trap release_wrapper_exit EXIT
  SELECTED_PHASE="authorization"
  COMMAND_TEXT="bash scripts/jarvis-public-release.sh"
  RECOVERY_COMMAND="bash scripts/jarvis-public-release.sh --authorize"
  if ! openclaw_require_jarvis_release_intent "$ROOT_DIR" "$RELEASE_INTENT_ID" "release phase selection"; then
    fail_before_execute 2 "ERROR: release execution is not authorized."
  fi
fi

if [[ "$FORCED_PHASE" == "auto" ]]; then
  SELECTED_PHASE="$(select_checkpoint_safe_phase)"
else
  SELECTED_PHASE="$FORCED_PHASE"
fi

if [[ "$FORCED_PHASE" == "auto" && ( "$SELECTED_PHASE" == "publish-assets-only" || "$SELECTED_PHASE" == "publish-sparkle-assets-only" ) && -n "$GITHUB_RELEASE_TAG" ]]; then
  # Old successful local-asset runs could leave an appcast that points at
  # releases/latest/download/Jarvis.zip. That file exists, but it is not safe to
  # upload because Sparkle appcasts must sign an immutable tagged ZIP URL.
  if ! appcast_targets_tagged_zip "$(tagged_zip_url "$GITHUB_RELEASE_TAG")"; then
    SELECTED_PHASE="create-local-release-assets-only"
  fi
fi

if [[ "$SELECTED_PHASE" == "ready-local-assets" ]]; then
  echo "Jarvis public release local assets are ready, but no public action was requested."
  echo "  state_root=$STATE_ROOT"
  echo "  manifest=$(jarvis_release_manifest_path "$STATE_ROOT")"
  if [[ "$RELEASE_INTENT_ACTION_BOUND" == "1" ]]; then
    # Adding publish/tag flags is a different bound action. Reusing this intent
    # would print a command guaranteed to fail its fingerprint check.
    echo "  next_publish_command=bash scripts/jarvis-public-release.sh --authorize"
  elif [[ -n "$RELEASE_INTENT_ID" ]]; then
    printf '  next_publish_command=bash scripts/jarvis-public-release.sh --release-intent %q --publish-release-assets --latest-release-tag\n' "$RELEASE_INTENT_ID"
  else
    # A dry-run has no executable authorization to preserve. Point the operator
    # at the standalone authorization step instead of printing a doomed command.
    echo "  next_publish_command=bash scripts/jarvis-public-release.sh --authorize"
  fi
  echo "  appcast_upload_remains_last=true"
  exit 0
fi

if [[ "$SELECTED_PHASE" == "ready-sparkle-local-assets" ]]; then
  echo "Jarvis Sparkle update assets are ready, but no public action was requested."
  echo "  selected_phase=$SELECTED_PHASE"
  echo "  state_root=$STATE_ROOT"
  echo "  manifest=$(jarvis_release_manifest_path "$STATE_ROOT")"
  if [[ "$RELEASE_INTENT_ACTION_BOUND" == "1" ]]; then
    echo "  next_publish_command=bash scripts/jarvis-public-release.sh --authorize"
  elif [[ -n "$RELEASE_INTENT_ID" ]]; then
    printf '  next_publish_command=bash scripts/jarvis-public-release.sh --release-intent %q --release-class sparkle-update --publish-release-assets --latest-release-tag\n' "$RELEASE_INTENT_ID"
  else
    echo "  next_publish_command=bash scripts/jarvis-public-release.sh --authorize"
  fi
  echo "  appcast_upload_remains_last_for_sparkle=true"
  echo "  fresh_install_sendable=false"
  echo "  dmg_update_live=false"
  exit 0
fi

CMD=(bash "$PACKAGE_SCRIPT" --phase "$SELECTED_PHASE" --release-class "$RELEASE_CLASS" --release-class-reason "$RELEASE_CLASS_REASON")
if [[ -n "$RELEASE_INTENT_ID" ]]; then
  CMD+=(--release-intent "$RELEASE_INTENT_ID")
fi
case "$SELECTED_PHASE" in
  sparkle-update|full|post-app-build)
    if [[ "$PUBLISH_RELEASE_ASSETS" == "1" ]]; then
      CMD+=(--publish-release-assets --github-release-tag "$GITHUB_RELEASE_TAG")
    fi
    ;;
  create-local-release-assets-only)
    CMD+=(--github-release-tag "$GITHUB_RELEASE_TAG")
    ;;
  publish-assets-only|publish-sparkle-assets-only)
    CMD+=(--publish-release-assets --github-release-tag "$GITHUB_RELEASE_TAG")
    ;;
  verify-public-assets-only|verify-sparkle-assets-only)
    if [[ -n "$GITHUB_RELEASE_TAG" ]]; then
      CMD+=(--github-release-tag "$GITHUB_RELEASE_TAG")
    fi
    ;;
esac

COMMAND_TEXT="$(quote_cmd "${CMD[@]}")"
if [[ "$RELEASE_INTENT_ACTION_BOUND" == "1" ]]; then
  # A bound intent is executable only through the wrapper action that
  # recomputes its fingerprint. A direct package command would fail in a fresh
  # shell because wrapper-to-package action context is intentionally absent.
  RECOVERY_COMMAND="$(original_wrapper_command)"
else
  RECOVERY_COMMAND="$COMMAND_TEXT"
fi
if [[ "$FORCED_PHASE" != "auto" ]]; then
  if [[ "$RELEASE_INTENT_ACTION_BOUND" == "1" ]]; then
    # Automatic recovery removes the forced phase and can replace
    # --latest-release-tag with its resolved tag. Both changes are a new
    # operator action, so the existing bound lease must not authorize them.
    RECOVERY_COMMAND="bash scripts/jarvis-public-release.sh --authorize"
  else
    # Legacy/plain intents are intentionally unbound. Keep their established
    # automatic-selector recovery while preserving publish/verify intent.
    AUTO_RECOVERY_CMD=(bash scripts/jarvis-public-release.sh --release-intent "$RELEASE_INTENT_ID")
    [[ "$PARALLEL_SAFE_LOCAL_ASSETS" != "1" ]] || AUTO_RECOVERY_CMD+=(--parallel-safe-local-assets)
    AUTO_RECOVERY_CMD+=(--release-class "$RELEASE_CLASS")
    [[ "$RELEASE_CLASS" != "fresh-installer" ]] || AUTO_RECOVERY_CMD+=(--release-class-reason "$RELEASE_CLASS_REASON")
    [[ "$PUBLISH_RELEASE_ASSETS" != "1" ]] || AUTO_RECOVERY_CMD+=(--publish-release-assets)
    [[ "$VERIFY_PUBLIC_ASSETS" != "1" ]] || AUTO_RECOVERY_CMD+=(--verify-public-assets)
    [[ -z "$GITHUB_RELEASE_TAG" ]] || AUTO_RECOVERY_CMD+=(--github-release-tag "$GITHUB_RELEASE_TAG")
    [[ "$RUN_SIZE_REPORT" != "1" ]] || AUTO_RECOVERY_CMD+=(--size-report)
    RECOVERY_COMMAND="$(quote_cmd "${AUTO_RECOVERY_CMD[@]}")"
  fi
fi

if [[ "$DRY_RUN" != "1" && "$SELECTED_PHASE" == "create-local-release-assets-only" && -z "$GITHUB_RELEASE_TAG" ]]; then
  fail_before_execute 2 \
    "ERROR: create-local-release-assets-only requires --github-release-tag <latest-tag>." \
    "The Sparkle appcast must sign an immutable tagged Jarvis.zip URL before any public upload."
fi

if [[ "$DRY_RUN" != "1" && ( "$SELECTED_PHASE" == "verify-public-assets-only" || "$SELECTED_PHASE" == "verify-sparkle-assets-only" ) && -z "$GITHUB_RELEASE_TAG" ]]; then
  fail_before_execute 2 \
    "ERROR: $SELECTED_PHASE requires --github-release-tag <latest-tag>." \
    "The public verifier must compare the appcast enclosure against the immutable tagged Jarvis.zip URL."
fi

if [[ "$DRY_RUN" != "1" && "$PUBLISH_RELEASE_ASSETS" == "1" && -z "$GITHUB_RELEASE_TAG" ]]; then
  fail_before_execute 2 \
    "ERROR: --publish-release-assets requires --github-release-tag <latest-tag>."
fi

echo "Jarvis public release orchestration:"
echo "  selected_phase=$SELECTED_PHASE"
echo "  release_class=$RELEASE_CLASS"
echo "  release_class_reason=$RELEASE_CLASS_REASON"
echo "  parallel_safe_local_assets=$PARALLEL_SAFE_LOCAL_ASSETS"
echo "  urgent_sparkle_only=$([[ "$RELEASE_CLASS" == "sparkle-update" ]] && echo 1 || echo 0)"
echo "  state_root=$STATE_ROOT"
echo "  app_build=${APP_BUILD:-auto}"
echo "  manifest=$(jarvis_release_manifest_path "$STATE_ROOT")"
echo "  command=$COMMAND_TEXT"
if [[ "$RELEASE_CLASS" == "sparkle-update" || "$SELECTED_PHASE" == "publish-sparkle-assets-only" || "$SELECTED_PHASE" == "verify-sparkle-assets-only" ]]; then
  echo "  appcast_upload_remains_last_for_sparkle=true"
  echo "  fresh_install_sendable=false"
  echo "  dmg_update_live=false"
else
  echo "  appcast_upload_remains_last=true"
fi
if [[ "$LATEST_RELEASE_TAG" == "1" ]]; then
  echo "  latest_release_tag=true"
  echo "  resolved_github_release_tag=$GITHUB_RELEASE_TAG"
fi
if [[ "$DRY_RUN" == "1" && "$SELECTED_PHASE" == "create-local-release-assets-only" && -z "$GITHUB_RELEASE_TAG" ]]; then
  echo "  required_before_execute=--github-release-tag <latest-tag>"
fi
if [[ "$DRY_RUN" == "1" && ( "$SELECTED_PHASE" == "verify-public-assets-only" || "$SELECTED_PHASE" == "verify-sparkle-assets-only" ) && -z "$GITHUB_RELEASE_TAG" ]]; then
  echo "  required_before_execute=--github-release-tag <latest-tag>"
fi
if [[ "$DRY_RUN" == "1" && "$PUBLISH_RELEASE_ASSETS" == "1" && -z "$GITHUB_RELEASE_TAG" ]]; then
  echo "  required_before_execute=--github-release-tag <latest-tag>"
fi
if [[ "$DRY_RUN" == "1" && -z "$RELEASE_INTENT_ID" ]]; then
  echo "  required_before_execute=bash scripts/jarvis-public-release.sh --authorize"
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo "dry_run=true"
  exit 0
fi

ensure_timing_report
# A newer operator authorization may have replaced this run after phase
# selection. Revalidate immediately before delegated execution; the package
# child repeats this after verified lock ownership transfer.
if ! openclaw_require_jarvis_release_intent "$ROOT_DIR" "$RELEASE_INTENT_ID" "delegated package execution"; then
  fail_before_execute 2 "ERROR: release intent changed after phase selection."
fi
started_at="$(iso_now)"
started_epoch="$(date +%s)"
set +e
PACKAGE_TIMING=1 \
OPENCLAW_JARVIS_RELEASE_TIMING_REPORT="$TIMING_REPORT" \
OPENCLAW_JARVIS_RELEASE_RECOVERY_OWNER=wrapper \
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

if [[ "$status" -ne 0 ]]; then
  # Child shell state cannot propagate its failure reason back to this wrapper.
  # Re-read the durable lease before choosing the sole recovery command.
  if ! openclaw_jarvis_release_intent_validate "$ROOT_DIR" "$RELEASE_INTENT_ID"; then
    WRAPPER_RECOVERY_EMITTED=1
    echo "recovery_command=bash scripts/jarvis-public-release.sh --authorize"
  else
    WRAPPER_RECOVERY_EMITTED=1
    echo "recovery_command=$RECOVERY_COMMAND"
  fi
fi

exit "$status"
