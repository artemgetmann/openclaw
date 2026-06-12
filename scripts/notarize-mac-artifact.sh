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

notary_submit_timestamp() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

notary_artifact_size_bytes() {
  local artifact="$1"
  /usr/bin/stat -f%z "$artifact" 2>/dev/null || /usr/bin/stat -c%s "$artifact" 2>/dev/null || printf '%s\n' "unknown"
}

notary_submit_route_hosts() {
  printf '%s\n' appstoreconnect.apple.com api.appstoreconnect.apple.com
}

notary_submit_route_interface() {
  local host="$1"
  local output=""

  if [[ -n "${OPENCLAW_NOTARY_PREFLIGHT_ROUTE_STUB:-}" ]]; then
    output="$("$OPENCLAW_NOTARY_PREFLIGHT_ROUTE_STUB" "$host")"
  elif command -v route >/dev/null 2>&1; then
    output="$(route -n get "$host" 2>/dev/null || true)"
  elif command -v ip >/dev/null 2>&1; then
    output="$(ip route get "$host" 2>/dev/null || true)"
  else
    return 1
  fi

  if [[ -z "$output" ]]; then
    return 1
  fi

  local interface=""
  interface="$(
    printf '%s\n' "$output" \
      | awk '
          $1 == "interface:" { print $2; exit }
          {
            for (i = 1; i < NF; i++) {
              if ($i == "dev") {
                print $(i + 1)
                exit
              }
            }
          }
        '
  )"

  [[ -n "$interface" ]] || return 1
  printf '%s\n' "$interface"
}

notary_submit_is_tunnel_interface() {
  case "$1" in
    utun*|wg*|ppp*|ipsec*) return 0 ;;
    *) return 1 ;;
  esac
}

warn_notary_submit_routes() {
  local host interface

  while IFS= read -r host; do
    [[ -n "$host" ]] || continue

    if ! interface="$(notary_submit_route_interface "$host")"; then
      echo "WARN: could not determine network route for Apple notary host $host before submit." >&2
      echo "WARN: if upload stalls, switch off VPN/tunnel routing or change networks before retrying the same artifact." >&2
      continue
    fi

    echo "Apple notary preflight: route $host via $interface"
    if notary_submit_is_tunnel_interface "$interface"; then
      if [[ "${ALLOW_SLOW_NOTARY_UPLOAD:-0}" == "1" ]]; then
        echo "WARN: $host routes through tunnel interface $interface; continuing because ALLOW_SLOW_NOTARY_UPLOAD=1." >&2
      else
        echo "WARN: $host routes through tunnel/VPN interface $interface; Apple notarization upload may stall." >&2
        echo "WARN: turn off VPN/tunnel routing or rerun with ALLOW_SLOW_NOTARY_UPLOAD=1 if this path is intentional." >&2
      fi
    fi
  done < <(notary_submit_route_hosts)
}

notary_submit_heartbeat_interval() {
  local interval="${NOTARYTOOL_SUBMIT_HEARTBEAT_SECS:-30}"
  case "$interval" in
    ''|*[!0-9]*) interval=30 ;;
  esac
  if [[ "$interval" -lt 1 ]]; then
    interval=30
  fi
  printf '%s\n' "$interval"
}

notary_submit_heartbeat() {
  local started_epoch="$1"
  local parent_pid="${2:-}"
  local interval
  interval="$(notary_submit_heartbeat_interval)"

  while sleep "$interval"; do
    if [[ -n "$parent_pid" ]] && ! kill -0 "$parent_pid" >/dev/null 2>&1; then
      exit 0
    fi

    local now_epoch elapsed_secs
    now_epoch="$(date +%s)"
    elapsed_secs=$((now_epoch - started_epoch))
    echo "notarytool submit command is still running (elapsed ${elapsed_secs}s); notarytool does not expose reliable byte-level upload progress." >&2
  done
}

NOTARY_SUBMIT_OUTPUT=""
run_notary_submit() {
  local started_at finished_at started_epoch finished_epoch elapsed_secs
  local heartbeat_pid submit_status

  started_at="$(notary_submit_timestamp)"
  started_epoch="$(date +%s)"
  echo "notary_submit_started_at=$started_at"
  echo "notary_artifact=$ARTIFACT"
  echo "notary_artifact_size_bytes=$(notary_artifact_size_bytes "$ARTIFACT")"
  warn_notary_submit_routes
  notary_submit_heartbeat "$started_epoch" "$$" &
  heartbeat_pid=$!

  set +e
  NOTARY_SUBMIT_OUTPUT="$(xcrun notarytool submit "$ARTIFACT" "${auth_args[@]}" "$@" --output-format json 2>&1)"
  submit_status=$?
  set -e

  kill "$heartbeat_pid" >/dev/null 2>&1 || true
  wait "$heartbeat_pid" >/dev/null 2>&1 || true

  finished_at="$(notary_submit_timestamp)"
  finished_epoch="$(date +%s)"
  elapsed_secs=$((finished_epoch - started_epoch))
  echo "notary_submit_finished_at=$finished_at"
  echo "notary_submit_elapsed_seconds=$elapsed_secs"
  echo "notary_submit_exit_status=$submit_status"
  return "$submit_status"
}

print_submit_retry_hint() {
  local submission_id="${1:-}"

  if [[ -n "$submission_id" ]]; then
    cat >&2 <<EOF
Hint: notarytool returned submission ID $submission_id before this error.
Do not resubmit the same artifact; poll that submission instead:
  scripts/notarize-mac-artifact.sh --poll $submission_id --artifact '$ARTIFACT'
EOF
    return
  fi

  cat >&2 <<EOF
Hint: no notary submission ID was returned, so there is no Apple-side job to
poll from this output. After Apple/network recovery, retry the same artifact:
  scripts/notarize-mac-artifact.sh --submit-only --receipt '${RECEIPT_PATH:-${ARTIFACT}.notary.env}' '$ARTIFACT'
Receipts must contain only submission IDs, artifact paths, staple targets,
statuses, and timestamps; keep credentials in Keychain or local env.
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
  local status="${2:-submitted}"
  local receipt_path="${RECEIPT_PATH:-${ARTIFACT}.notary.env}"

  mkdir -p "$(dirname "$receipt_path")"
  {
    printf 'NOTARY_SUBMISSION_ID=%q\n' "$submission_id"
    printf 'NOTARY_ARTIFACT=%q\n' "$ARTIFACT"
    printf 'NOTARY_STAPLE_APP_PATH=%q\n' "$STAPLE_APP_PATH"
    printf 'NOTARY_STATUS=%q\n' "$status"
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
  write_receipt "$SUBMISSION_ID" "$status"
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
  submit_status=0
  run_notary_submit || submit_status=$?
  submit_json="$NOTARY_SUBMIT_OUTPUT"
  if [[ $submit_status -ne 0 ]]; then
    submission_id="$(printf '%s\n' "$submit_json" | notary_id)"
    echo "$submit_json" >&2
    if [[ -n "$submission_id" ]]; then
      write_receipt "$submission_id" "submitted"
    fi
    print_submit_retry_hint "$submission_id"
    exit "$submit_status"
  fi
  submission_id="$(printf '%s\n' "$submit_json" | notary_id)"
  if [[ -z "$submission_id" ]]; then
    echo "$submit_json" >&2
    echo "Error: could not parse notary submission ID." >&2
    exit 1
  fi

  echo "notary_submission_id=$submission_id"
  write_receipt "$submission_id" "submitted"
  echo "Poll later with:"
  echo "  scripts/notarize-mac-artifact.sh --poll $submission_id --artifact '$ARTIFACT'"
  exit 0
fi

submit_status=0
run_notary_submit --wait || submit_status=$?
submit_json="$NOTARY_SUBMIT_OUTPUT"
if [[ $submit_status -ne 0 ]]; then
  submission_id="$(printf '%s\n' "$submit_json" | notary_id)"
  echo "$submit_json" >&2
  if [[ -n "$submission_id" ]]; then
    write_receipt "$submission_id" "submitted"
  fi
  print_submit_retry_hint "$submission_id"
  exit "$submit_status"
fi
submission_id="$(printf '%s\n' "$submit_json" | notary_id)"
status="$(printf '%s\n' "$submit_json" | notary_status)"
if [[ -n "$submission_id" ]]; then
  write_receipt "$submission_id" "${status:-Accepted}"
fi
staple_outputs

echo "✅ Notarization complete"
