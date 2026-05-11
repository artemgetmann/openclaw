#!/usr/bin/env bash
set -euo pipefail

# Read-only release credential preflight for notarized Consumer Sparkle builds.
# This script intentionally reports only presence/missing state. It must never
# print certificate private material, notary secrets, or Sparkle key contents.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/release-env.sh"
DEFAULT_SPARKLE_KEY="AGCY8w5vHirVfGGDGc8Szc5iuOqupZSh9pMj/Qs67XI="
FAILED=0

mark_ok() {
  printf 'OK: %s\n' "$1"
}

mark_warn() {
  printf 'WARN: %s\n' "$1"
}

mark_missing() {
  printf 'MISSING: %s\n' "$1"
  FAILED=1
}

has_developer_id_application_cert() {
  /usr/bin/security find-identity -v -p codesigning 2>/dev/null \
    | /usr/bin/grep -q 'Developer ID Application'
}

sparkle_tool_path() {
  local name="$1"
  local built_tool="$ROOT_DIR/apps/macos/.build/artifacts/sparkle/Sparkle/bin/$name"
  local arch_tool="$ROOT_DIR/apps/macos/.build/arm64/artifacts/sparkle/Sparkle/bin/$name"

  if [[ -x "$built_tool" ]]; then
    printf '%s\n' "$built_tool"
    return 0
  fi

  if [[ -x "$arch_tool" ]]; then
    printf '%s\n' "$arch_tool"
    return 0
  fi

  command -v "$name" 2>/dev/null || true
}

check_developer_id() {
  if has_developer_id_application_cert; then
    mark_ok "Developer ID Application certificate is available in the keychain"
  else
    mark_missing "Developer ID Application certificate is not available in the keychain"
  fi
}

check_notary_tooling() {
  if command -v xcrun >/dev/null && xcrun notarytool --version >/dev/null 2>&1; then
    mark_ok "xcrun notarytool is available"
  else
    mark_missing "xcrun notarytool is not available"
  fi
}

check_notary_auth() {
  if [[ -n "${NOTARYTOOL_PROFILE:-}" ]]; then
    mark_ok "notary auth is configured through NOTARYTOOL_PROFILE"
    return
  fi

  if [[ -n "${NOTARYTOOL_KEY:-}" && -n "${NOTARYTOOL_KEY_ID:-}" && -n "${NOTARYTOOL_ISSUER:-}" ]]; then
    mark_ok "notary auth is configured through App Store Connect API key env vars"
    return
  fi

  mark_missing "notary auth is not configured; set NOTARYTOOL_PROFILE or NOTARYTOOL_KEY/NOTARYTOOL_KEY_ID/NOTARYTOOL_ISSUER"
}

check_sparkle_public_key() {
  if [[ -z "${SPARKLE_PUBLIC_ED_KEY:-}" ]]; then
    mark_missing "SPARKLE_PUBLIC_ED_KEY is not set"
    return
  fi

  if [[ "$SPARKLE_PUBLIC_ED_KEY" == "$DEFAULT_SPARKLE_KEY" ]]; then
    mark_missing "SPARKLE_PUBLIC_ED_KEY is still the generic development key"
    return
  fi

  mark_ok "SPARKLE_PUBLIC_ED_KEY is set to a non-default value"
}

check_sparkle_private_key() {
  if [[ -z "${SPARKLE_PRIVATE_KEY_FILE:-}" ]]; then
    mark_missing "SPARKLE_PRIVATE_KEY_FILE is not set"
    return
  fi

  if [[ ! -f "$SPARKLE_PRIVATE_KEY_FILE" ]]; then
    mark_missing "SPARKLE_PRIVATE_KEY_FILE is set but the key file does not exist"
    return
  fi

  if [[ ! -r "$SPARKLE_PRIVATE_KEY_FILE" ]]; then
    mark_missing "SPARKLE_PRIVATE_KEY_FILE exists but is not readable"
    return
  fi

  mark_ok "Sparkle private key file exists and is readable"
}

check_sparkle_feed() {
  if [[ -z "${SPARKLE_FEED_URL:-}" ]]; then
    mark_missing "SPARKLE_FEED_URL is not set"
    return
  fi

  if [[ "$SPARKLE_FEED_URL" == "https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml" ]]; then
    mark_missing "SPARKLE_FEED_URL points at the generic OpenClaw appcast"
    return
  fi

  mark_ok "SPARKLE_FEED_URL is set to a consumer-owned value"
}

check_sparkle_tools() {
  local appcast_tool
  local keys_tool
  appcast_tool="$(sparkle_tool_path generate_appcast)"
  keys_tool="$(sparkle_tool_path generate_keys)"

  if [[ -n "$appcast_tool" ]]; then
    mark_ok "Sparkle generate_appcast tool is available"
  else
    mark_missing "Sparkle generate_appcast tool is not available; build Sparkle tools via SwiftPM"
  fi

  if [[ -n "$keys_tool" ]]; then
    mark_ok "Sparkle generate_keys tool is available"
  else
    mark_warn "Sparkle generate_keys tool is not available locally; build Sparkle tools before generating release keys"
  fi
}

printf 'Consumer macOS release credential preflight\n'
printf 'No secret values will be printed.\n\n'
printf 'Release env file: %s\n\n' "$(openclaw_release_env_file)"

check_developer_id
check_notary_tooling
check_notary_auth
check_sparkle_feed
check_sparkle_public_key
check_sparkle_private_key
check_sparkle_tools

printf '\n'
if [[ "$FAILED" -eq 0 ]]; then
  printf 'Ready: required release credential inputs are present.\n'
else
  printf 'Not ready: fix the missing items above before notarized Consumer distribution.\n'
  printf '\n'
  openclaw_release_env_hint
fi

exit "$FAILED"
