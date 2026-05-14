#!/usr/bin/env bash

# Shared release-environment loader for macOS packaging scripts.
#
# Keep release secrets out of the repo. This optional env file is only a
# deterministic bridge for non-secret release settings and secret file pointers,
# so fresh worktrees can discover the same release inputs without relying on
# agent memory.

if [[ -n "${OPENCLAW_RELEASE_ENV_LOADED:-}" ]]; then
  return 0
fi
export OPENCLAW_RELEASE_ENV_LOADED=1

openclaw_release_env_default_file() {
  printf '%s\n' "${HOME}/Library/Application Support/OpenClaw/release.env"
}

openclaw_release_env_file() {
  if [[ -n "${OPENCLAW_RELEASE_ENV_FILE:-}" ]]; then
    printf '%s\n' "$OPENCLAW_RELEASE_ENV_FILE"
    return 0
  fi

  openclaw_release_env_default_file
}

openclaw_source_release_env_if_present() {
  local env_file
  env_file="$(openclaw_release_env_file)"

  if [[ "$env_file" == "0" || "$env_file" == "false" ]]; then
    return 0
  fi

  if [[ -f "$env_file" ]]; then
    # shellcheck disable=SC1090
    source "$env_file"
  fi
}

openclaw_release_env_hint() {
  cat <<EOF
Release env search:
  default: $(openclaw_release_env_default_file)
  override: OPENCLAW_RELEASE_ENV_FILE=/path/to/release.env

Recommended contents:
  export NOTARYTOOL_KEY="<path outside the repo>/AuthKey_<key id>.p8"
  export NOTARYTOOL_KEY_ID="<App Store Connect API key id>"
  export NOTARYTOOL_ISSUER="<App Store Connect issuer id>"
  export SPARKLE_FEED_URL="<consumer-owned appcast URL>"
  export SPARKLE_PUBLIC_ED_KEY="<consumer Sparkle public EdDSA key>"
  export SPARKLE_PRIVATE_KEY_FILE="<path outside the repo>"

Recommended notary auth is App Store Connect API key auth, with the .p8 file
stored outside the repo. Keychain profiles still work as a fallback:
  export NOTARYTOOL_PROFILE="<keychain profile name>"
  xcrun notarytool store-credentials "<keychain profile name>"
EOF
}

openclaw_source_release_env_if_present
