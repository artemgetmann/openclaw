#!/usr/bin/env bash
set -euo pipefail

# Notarize a macOS artifact (zip/dmg/pkg) and optionally staple the app bundle.
#
# Usage:
#   STAPLE_APP_PATH=dist/OpenClaw.app scripts/notarize-mac-artifact.sh --submit-only --receipt dist/app.notary.env <artifact>
#   scripts/notarize-mac-artifact.sh --poll <submission-id> --artifact dist/OpenClaw.dmg
#   STAPLE_APP_PATH=dist/OpenClaw.app scripts/notarize-mac-artifact.sh <artifact>
#
# Auth (pick one):
#   NOTARYTOOL_KEY       path to App Store Connect API key (.p8)
#   NOTARYTOOL_KEY_ID    API key ID
#   NOTARYTOOL_ISSUER    API issuer ID
#   NOTARYTOOL_PROFILE   fallback keychain profile created via `xcrun notarytool store-credentials`

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/release-env.sh"

MODE="wait"
ARTIFACT=""
SUBMISSION_ID=""
RECEIPT_PATH=""
STAPLE_APP_PATH="${STAPLE_APP_PATH:-}"

usage() {
  cat <<'EOF'
Usage:
  scripts/notarize-mac-artifact.sh --submit-only [--receipt path] <artifact>
  scripts/notarize-mac-artifact.sh --poll <submission-id> --artifact <artifact> [--staple-app app]
  scripts/notarize-mac-artifact.sh <artifact>

Recommended release flow is async: --submit-only writes a receipt containing the
submission ID, then --poll checks one submission and staples only after Apple
reports Accepted. The plain artifact form remains for one-off blocking waits.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --submit-only)
      MODE="submit-only"
      shift
      ;;
    --poll)
      MODE="poll"
      if [[ $# -lt 2 ]]; then
        echo "Error: --poll requires a submission ID." >&2
        exit 1
      fi
      SUBMISSION_ID="$2"
      shift 2
      ;;
    --artifact)
      if [[ $# -lt 2 ]]; then
        echo "Error: --artifact requires a path." >&2
        exit 1
      fi
      ARTIFACT="$2"
      shift 2
      ;;
    --receipt)
      if [[ $# -lt 2 ]]; then
        echo "Error: --receipt requires a path." >&2
        exit 1
      fi
      RECEIPT_PATH="$2"
      shift 2
      ;;
    --staple-app)
      if [[ $# -lt 2 ]]; then
        echo "Error: --staple-app requires a path." >&2
        exit 1
      fi
      STAPLE_APP_PATH="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --*)
      echo "Error: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [[ -n "$ARTIFACT" ]]; then
        echo "Error: multiple artifacts supplied: $ARTIFACT and $1" >&2
        exit 1
      fi
      ARTIFACT="$1"
      shift
      ;;
  esac
done

if [[ "$MODE" != "poll" && -z "$ARTIFACT" ]]; then
  usage >&2
  exit 1
fi

if ! command -v xcrun >/dev/null 2>&1; then
  echo "Error: xcrun not found; install Xcode command line tools." >&2
  exit 1
fi

auth_args=()
if [[ -n "${NOTARYTOOL_KEY:-}" && -n "${NOTARYTOOL_KEY_ID:-}" && -n "${NOTARYTOOL_ISSUER:-}" ]]; then
  auth_args+=(--key "$NOTARYTOOL_KEY" --key-id "$NOTARYTOOL_KEY_ID" --issuer "$NOTARYTOOL_ISSUER")
elif [[ -n "${NOTARYTOOL_PROFILE:-}" ]]; then
  auth_args+=(--keychain-profile "$NOTARYTOOL_PROFILE")
else
  echo "Error: Notary auth missing. Set NOTARYTOOL_KEY/NOTARYTOOL_KEY_ID/NOTARYTOOL_ISSUER or fallback NOTARYTOOL_PROFILE." >&2
  echo >&2
  openclaw_release_env_hint >&2
  exit 1
fi

json_field() {
  local field="$1"
  /usr/bin/sed -n "s/.*\"$field\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" \
    | /usr/bin/head -n 1
}

notary_status() {
  json_field "status"
}

notary_id() {
  json_field "id"
}

print_submit_retry_hint() {
  cat >&2 <<EOF
Hint: if notarytool printed a submission ID before this error, poll it instead
of rebuilding:
  scripts/notarize-mac-artifact.sh --poll <submission-id> --artifact '$ARTIFACT'
If no submission ID was created, retry the same artifact after Apple/network
recovery. Receipts must contain only submission IDs, artifact paths, staple
targets, statuses, and timestamps; keep credentials in Keychain or local env.
EOF
}

staple_outputs() {
  case "$ARTIFACT" in
    *.dmg|*.pkg)
      if [[ ! -e "$ARTIFACT" ]]; then
        echo "Error: artifact not found for stapling: $ARTIFACT" >&2
        exit 1
      fi
      echo "📌 Stapling artifact: $ARTIFACT"
      xcrun stapler staple "$ARTIFACT"
      xcrun stapler validate "$ARTIFACT"
      ;;
    *)
      ;;
  esac

  if [[ -n "$STAPLE_APP_PATH" ]]; then
    if [[ -d "$STAPLE_APP_PATH" ]]; then
      echo "📌 Stapling app: $STAPLE_APP_PATH"
      xcrun stapler staple "$STAPLE_APP_PATH"
      xcrun stapler validate "$STAPLE_APP_PATH"
    else
      echo "Warn: STAPLE_APP_PATH not found: $STAPLE_APP_PATH" >&2
    fi
  fi
}

write_receipt() {
  local submission_id="$1"
  local receipt_path="${RECEIPT_PATH:-${ARTIFACT}.notary.env}"

  mkdir -p "$(dirname "$receipt_path")"
  {
    printf 'NOTARY_SUBMISSION_ID=%q\n' "$submission_id"
    printf 'NOTARY_ARTIFACT=%q\n' "$ARTIFACT"
    printf 'NOTARY_STAPLE_APP_PATH=%q\n' "$STAPLE_APP_PATH"
    printf 'NOTARY_CREATED_AT=%q\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  } >"$receipt_path"

  echo "🧾 Notary receipt: $receipt_path"
}

if [[ "$MODE" == "poll" ]]; then
  if [[ -z "$SUBMISSION_ID" ]]; then
    echo "Error: --poll requires a submission ID." >&2
    exit 1
  fi

  echo "🧾 Checking notarization: $SUBMISSION_ID"
  info_json="$(xcrun notarytool info "$SUBMISSION_ID" "${auth_args[@]}" --output-format json)"
  status="$(printf '%s\n' "$info_json" | notary_status)"

  if [[ -z "$status" ]]; then
    echo "$info_json" >&2
    echo "Error: could not parse notarization status." >&2
    exit 1
  fi

  echo "notary_status=$status"
  case "$status" in
    Accepted)
      staple_outputs
      echo "✅ Notarization accepted"
      exit 0
      ;;
    Invalid|Rejected)
      echo "$info_json" >&2
      echo "Error: notarization failed. Fetch the log with:" >&2
      echo "  xcrun notarytool log $SUBMISSION_ID <auth args>" >&2
      exit 1
      ;;
    *)
      echo "Notarization is still pending; rerun the poll command later." >&2
      exit 2
      ;;
  esac
fi

if [[ ! -e "$ARTIFACT" ]]; then
  echo "Error: artifact not found: $ARTIFACT" >&2
  exit 1
fi

echo "🧾 Notarizing: $ARTIFACT"
if [[ "$MODE" == "submit-only" ]]; then
  set +e
  submit_json="$(xcrun notarytool submit "$ARTIFACT" "${auth_args[@]}" --output-format json 2>&1)"
  submit_status=$?
  set -e
  if [[ $submit_status -ne 0 ]]; then
    echo "$submit_json" >&2
    print_submit_retry_hint
    exit "$submit_status"
  fi
  submission_id="$(printf '%s\n' "$submit_json" | notary_id)"
  if [[ -z "$submission_id" ]]; then
    echo "$submit_json" >&2
    echo "Error: could not parse notary submission ID." >&2
    exit 1
  fi

  echo "notary_submission_id=$submission_id"
  write_receipt "$submission_id"
  echo "Poll later with:"
  echo "  scripts/notarize-mac-artifact.sh --poll $submission_id --artifact '$ARTIFACT'"
  exit 0
fi

set +e
xcrun notarytool submit "$ARTIFACT" "${auth_args[@]}" --wait
submit_status=$?
set -e
if [[ $submit_status -ne 0 ]]; then
  print_submit_retry_hint
  exit "$submit_status"
fi
staple_outputs

echo "✅ Notarization complete"
