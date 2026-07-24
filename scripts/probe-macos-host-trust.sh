#!/usr/bin/env bash
set -euo pipefail

# Read-only control probe for the macOS trust view visible to this process.
# This intentionally does not inspect or mutate Keychain settings, identities,
# trustd/securityd, release artifacts, or the installed Jarvis application.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/macos-host-trust.sh"

if openclaw_macos_host_trust_require; then
  printf 'host_trust_probe=confirmed\n'
  # This executable is a production operator probe. The library deliberately
  # ignores fixture overrides unless explicit test mode is enabled, so report
  # the same pinned control instead of echoing an inherited fixture variable.
  printf 'control_path=/bin/ls\n'
  printf 'next=rerun the release verification from this same host Terminal\n'
  exit 0
fi

exit 2
