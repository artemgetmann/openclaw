#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
source "$ROOT/scripts/lib/consumer-instance.sh"

INSTANCE_ARG="${OPENCLAW_CONSUMER_INSTANCE_ID:-}"
BOT_CHAT=""
VERIFY_ONLY=0
WINDOW_TIMEOUT_SECS=30
TELEGRAM_TIMEOUT_SECS=90
PREFLIGHT_RETRIES=8
PREFLIGHT_RETRY_SLEEP_SECS=2

usage() {
  cat <<'EOF'
Usage: bash scripts/consumer-packaged-onboarding-smoke.sh [--instance <id>] [--chat <@bot_username>] [--verify-only]

Runs a thin consumer backend-first smoke:
- consumer preflight
- package or verify the consumer app bundle
- open that exact bundle
- assert the app has at least one visible window
- optionally run the Telegram first-reply smoke when Telegram user creds are available
EOF
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

wait_for_visible_window() {
  local bundle_id="$1"
  local timeout_secs="$2"
  local elapsed=0
  local count=""

  while (( elapsed < timeout_secs )); do
    count="$(
      osascript -e "tell application \"System Events\" to tell (first process whose bundle identifier is \"${bundle_id}\") to count windows" 2>/dev/null || true
    )"
    if [[ "$count" =~ ^[0-9]+$ ]] && (( count > 0 )); then
      echo "window_visibility=ok"
      echo "window_count=${count}"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  fail "packaged app did not surface a visible window within ${timeout_secs}s for bundle ${bundle_id}"
}

run_consumer_preflight_with_retry() {
  local attempt=1
  local tmp_output
  tmp_output="$(mktemp -t consumer-packaged-onboarding-preflight.XXXXXX)"

  while (( attempt <= PREFLIGHT_RETRIES )); do
    if OPENCLAW_CONSUMER_INSTANCE_ID="$INSTANCE_ID" pnpm consumer:preflight >"$tmp_output" 2>&1; then
      cat "$tmp_output"
      rm -f "$tmp_output"
      return 0
    fi

    if (( attempt == PREFLIGHT_RETRIES )); then
      cat "$tmp_output"
      rm -f "$tmp_output"
      return 1
    fi

    echo "consumer_preflight_retry=${attempt}/${PREFLIGHT_RETRIES}" >&2
    sleep "$PREFLIGHT_RETRY_SLEEP_SECS"
    attempt=$((attempt + 1))
  done
}

run_bundle_step() {
  if (( VERIFY_ONLY )); then
    bash "$ROOT/scripts/verify-consumer-mac-app.sh" --instance "$INSTANCE_ID"
    return
  fi
  bash "$ROOT/scripts/package-consumer-mac-app.sh" --instance "$INSTANCE_ID"
}

run_telegram_smoke() {
  local chat="$1"
  if [[ -z "${TELEGRAM_API_ID:-}" || -z "${TELEGRAM_API_HASH:-}" ]]; then
    echo "telegram_smoke=skipped"
    echo "telegram_smoke_reason=missing TELEGRAM_API_ID/TELEGRAM_API_HASH"
    return 0
  fi
  if [[ -z "$chat" ]]; then
    echo "telegram_smoke=skipped"
    echo "telegram_smoke_reason=no --chat provided"
    return 0
  fi

  bash "$ROOT/scripts/telegram-e2e/run-consumer-first-reply-smoke.sh" \
    --chat "$chat" \
    --timeout "$TELEGRAM_TIMEOUT_SECS"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance)
      [[ $# -ge 2 ]] || fail "--instance requires a value"
      INSTANCE_ARG="$2"
      shift 2
      ;;
    --chat)
      [[ $# -ge 2 ]] || fail "--chat requires a value"
      BOT_CHAT="$2"
      shift 2
      ;;
    --verify-only)
      VERIFY_ONLY=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

INSTANCE_ID="$(consumer_instance_normalize_id "$INSTANCE_ARG")"
if [[ -z "$INSTANCE_ID" ]]; then
  INSTANCE_ID="$(consumer_instance_default_id_for_checkout "$ROOT")"
fi
[[ -n "$INSTANCE_ID" ]] || fail "could not derive a consumer instance id; pass --instance <id>"

APP_PATH="$(consumer_instance_app_path "$ROOT" "$INSTANCE_ID")"
BUNDLE_ID="$(consumer_instance_bundle_id "$INSTANCE_ID")"
DIST_INDEX="$ROOT/dist/index.js"

echo "instance_id=${INSTANCE_ID}"
echo "bundle_id=${BUNDLE_ID}"
echo "app_path=${APP_PATH}"
echo "verify_only=${VERIFY_ONLY}"

if [[ -f "$DIST_INDEX" ]]; then
  run_bundle_step
  echo "bundle_step=ok"
else
  echo "consumer_preflight_order=after_bundle_bootstrap"
  run_bundle_step
  echo "bundle_step=ok"
fi

bash "$ROOT/scripts/open-consumer-mac-app.sh" --instance "$INSTANCE_ID" --replace
run_consumer_preflight_with_retry
echo "consumer_preflight=ok"
wait_for_visible_window "$BUNDLE_ID" "$WINDOW_TIMEOUT_SECS"

run_telegram_smoke "$BOT_CHAT"

echo "consumer_packaged_onboarding_smoke=ok"
