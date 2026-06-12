#!/usr/bin/env bash
set -euo pipefail

# Read-only release credential preflight for notarized Consumer Sparkle builds.
# This script intentionally reports only presence/missing state. It must never
# print certificate private material, notary secrets, or Sparkle key contents.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/release-env.sh"
DEFAULT_SPARKLE_KEY="AGCY8w5vHirVfGGDGc8Szc5iuOqupZSh9pMj/Qs67XI="
FAILED=0
ASC_MISSING_VARS=()
ASC_READY=0
FALLBACK_PROFILE_STATE="missing"
FALLBACK_PROFILE_READY=0
NOTARYTOOL_READY=0
SPARKLE_APPCAST_READY=0

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
  local sparkle_tool_dirs=(
    "$ROOT_DIR/apps/macos/.build/artifacts/sparkle/Sparkle/bin"
    "$ROOT_DIR/apps/macos/.build/arm64/artifacts/sparkle/Sparkle/bin"
    "$ROOT_DIR/apps/macos/.build/x86_64/artifacts/sparkle/Sparkle/bin"
  )
  local sparkle_tool_dir
  local sparkle_tool

  for sparkle_tool_dir in "${sparkle_tool_dirs[@]}"; do
    # Mirror make_appcast.sh so preflight reports the same tool that release
    # generation will actually execute.
    sparkle_tool="$sparkle_tool_dir/$name"
    if [[ -x "$sparkle_tool" ]]; then
      printf '%s\n' "$sparkle_tool"
      return 0
    fi
  done

  command -v "$name" 2>/dev/null || true
}

print_asc_operator_action() {
  local env_file
  env_file="$(openclaw_release_env_file)"

  if [[ "$env_file" == "0" || "$env_file" == "false" ]]; then
    printf 'Next operator action: re-enable the release env, add %s to the release env, keep the .p8 file outside the repo, then rerun this preflight.\n' "${ASC_MISSING_VARS[*]}"
    return
  fi

  printf 'Next operator action: add %s to %s, with the .p8 file stored outside the repo, then rerun this preflight.\n' "${ASC_MISSING_VARS[*]}" "$env_file"
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
    NOTARYTOOL_READY=1
    mark_ok "xcrun notarytool is available"
  else
    NOTARYTOOL_READY=0
    mark_missing "xcrun notarytool is not available"
  fi
}

check_notary_profile() {
  local profile="$1"

  if [[ "$NOTARYTOOL_READY" -ne 1 ]]; then
    FALLBACK_PROFILE_STATE="present-unverified"
    mark_warn "NOTARYTOOL_PROFILE is present, but xcrun notarytool is unavailable so the Keychain profile was not verified"
    return
  fi

  # `history` is read-only and verifies that the Keychain profile can
  # authenticate with Apple's notary service without printing credentials.
  if xcrun notarytool history --keychain-profile "$profile" >/dev/null 2>&1; then
    FALLBACK_PROFILE_STATE="present-working"
    FALLBACK_PROFILE_READY=1
    mark_ok "NOTARYTOOL_PROFILE Keychain profile is present and works"
  else
    FALLBACK_PROFILE_STATE="present-not-working"
    FALLBACK_PROFILE_READY=0
    mark_warn "NOTARYTOOL_PROFILE is present, but notarytool could not authenticate with that Keychain profile"
  fi
}

check_notary_auth() {
  ASC_MISSING_VARS=()
  ASC_READY=0
  FALLBACK_PROFILE_STATE="missing"
  FALLBACK_PROFILE_READY=0

  if [[ -n "${NOTARYTOOL_KEY:-}" ]]; then
    if [[ -f "$NOTARYTOOL_KEY" && -r "$NOTARYTOOL_KEY" ]]; then
      mark_ok "NOTARYTOOL_KEY is present and readable"
    else
      ASC_MISSING_VARS+=("NOTARYTOOL_KEY")
      mark_missing "NOTARYTOOL_KEY is set but the .p8 file is missing or unreadable"
    fi
  else
    ASC_MISSING_VARS+=("NOTARYTOOL_KEY")
    mark_missing "NOTARYTOOL_KEY is missing"
  fi

  if [[ -n "${NOTARYTOOL_KEY_ID:-}" ]]; then
    mark_ok "NOTARYTOOL_KEY_ID is present"
  else
    ASC_MISSING_VARS+=("NOTARYTOOL_KEY_ID")
    mark_missing "NOTARYTOOL_KEY_ID is missing"
  fi

  if [[ -n "${NOTARYTOOL_ISSUER:-}" ]]; then
    mark_ok "NOTARYTOOL_ISSUER is present"
  else
    ASC_MISSING_VARS+=("NOTARYTOOL_ISSUER")
    mark_missing "NOTARYTOOL_ISSUER is missing"
  fi

  if [[ -n "${NOTARYTOOL_PROFILE:-}" ]]; then
    FALLBACK_PROFILE_STATE="present"
    check_notary_profile "$NOTARYTOOL_PROFILE"
  else
    mark_warn "NOTARYTOOL_PROFILE is missing (fallback only)"
  fi

  if [[ "${#ASC_MISSING_VARS[@]}" -eq 0 ]]; then
    ASC_READY=1
    mark_ok "ASC notary auth lane is ready"
  else
    mark_missing "ASC notary auth lane is not ready; missing: ${ASC_MISSING_VARS[*]}"
  fi
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
    SPARKLE_APPCAST_READY=1
    mark_ok "Sparkle generate_appcast tool is available at $appcast_tool"
  else
    SPARKLE_APPCAST_READY=0
    mark_missing "Sparkle generate_appcast tool is not available; build Sparkle tools via SwiftPM before appcast generation"
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
if [[ "$ASC_READY" -eq 1 ]]; then
  printf 'Final: ASC API key lane ready.\n'
else
  printf 'Final: ASC API key lane not ready.\n'
fi

printf 'Fallback profile: %s.\n' "$FALLBACK_PROFILE_STATE"
if [[ "$SPARKLE_APPCAST_READY" -eq 1 ]]; then
  printf 'Sparkle appcast tooling: ready.\n'
else
  printf 'Sparkle appcast tooling: missing generate_appcast.\n'
fi

if [[ "$ASC_READY" -ne 1 ]]; then
  print_asc_operator_action
  if [[ "$FALLBACK_PROFILE_READY" -eq 1 ]]; then
    printf 'Fallback option: the Keychain profile works, so an operator can deliberately run the fallback profile lane if ASC setup is blocked.\n'
  else
    printf 'Fallback option: no working Keychain profile was verified; do not assume profile notarization will save this lane.\n'
  fi
elif [[ "$FAILED" -ne 0 ]]; then
  printf 'Next operator action: fix the remaining missing release prerequisites above, then rerun this preflight before any submit/poll/staple lane.\n'
else
  printf 'Next operator action: proceed with the dry-run release lane checks; no notarization submit, stapling, packaging, uploads, or release asset changes will happen in this script.\n'
fi

if [[ "$FAILED" -eq 0 && "$ASC_READY" -eq 1 ]]; then
  printf 'Ready: required release credential inputs are present.\n'
else
  printf 'Not ready: fix the missing items above before notarized Consumer distribution.\n'
fi

exit "$FAILED"
