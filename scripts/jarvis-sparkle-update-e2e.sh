#!/usr/bin/env bash
# Safety-first Sparkle update E2E harness.  This file intentionally starts with
# a read-only preflight; --apply is the only path permitted to mutate the
# lane-owned synthetic/app copies described by the operator.
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MODE="preflight"
FIXTURE_ROOT=""
KEEP_TEMP=0
RUN_ROOT=""
MIN_FREE_BYTES="${JARVIS_SPARKLE_MIN_FREE_BYTES:-1048576}"
RUN_SENTINEL=""

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '%s\n' "$*"; }

# Cleanup is deliberately scoped to paths created by this process.  It must
# never remove a canonical release lock, user state, LaunchAgent, or identity.
cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  # The fixture root belongs to the caller.  Only remove the lane directory
  # and its disposable app/staging/preferences copies, never the fixture root.
  if [[ "$KEEP_TEMP" != 1 && -n "${RUN_ROOT:-}" && -n "${RUN_SENTINEL:-}" && -f "$RUN_SENTINEL" && "$RUN_ROOT" == "$FIXTURE_ROOT/.sparkle-e2e-lane" ]]; then
    rm -rf -- "$RUN_ROOT"
  fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

usage() {
  cat <<'EOF'
Usage: jarvis-sparkle-update-e2e.sh [--apply] --fixture <dir> [--keep-temp]

Default mode is read-only preflight. --apply is required for the synthetic
transition and cleanup path; live publishing, notarizing, installing, and
Telegram sends are intentionally unsupported.
EOF
}

while (($#)); do
  case "$1" in
    --apply) MODE="apply"; shift ;;
    --fixture) (($# >= 2)) || die "--fixture requires a path"; FIXTURE_ROOT="$2"; shift 2 ;;
    --keep-temp) KEEP_TEMP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

log "PROOF_LAYER=preflight"
log "mode=$MODE"

[[ -n "$FIXTURE_ROOT" ]] || die "--fixture is required; live paths are intentionally unsupported"
[[ "$FIXTURE_ROOT" = /* ]] || die "fixture path must be absolute"
[[ -d "$FIXTURE_ROOT" ]] || die "fixture directory does not exist: $FIXTURE_ROOT"

# This harness is deliberately synthetic.  Refuse paths that could be a real
# installation or user runtime, even when an operator accidentally supplies
# them.  No amount of --apply can bypass this boundary.
case "$FIXTURE_ROOT" in
  /Applications|/Applications/*|"$HOME/Library/Application Support/Jarvis"|"$HOME/Library/Application Support/Jarvis"/*|"$HOME/Library/LaunchAgents"|"$HOME/Library/LaunchAgents"/*)
    die "refusing live app-support, /Applications, or LaunchAgents path"
    ;;
esac

RUN_ROOT="$FIXTURE_ROOT/.sparkle-e2e-lane"
RUN_SENTINEL="$RUN_ROOT/.owned-by-jarvis-sparkle-update-e2e"
OLD_META="$FIXTURE_ROOT/old-app.env"
NEW_META="$FIXTURE_ROOT/new-app.env"
INSTALLED_META="$FIXTURE_ROOT/installed-app.env"
MANAGED_META="$FIXTURE_ROOT/managed-manifest.env"
EXPECTED_MANAGED_META="$FIXTURE_ROOT/expected-managed-manifest.env"
PUBLIC_FEED="$FIXTURE_ROOT/public-feed.env"
GATEWAY_META="$FIXTURE_ROOT/gateway.env"
# In synthetic mode the fixture's canonical-release.lock is the only lock this
# script may inspect. There is no override that could point cleanup at a live
# or unrelated owner-control path.
LOCK_FILE="$FIXTURE_ROOT/canonical-release.lock"

require_file() { [[ -f "$1" ]] || die "preflight blocked: missing $2 ($1)"; }
read_field() {
  local file="$1" key="$2" value
  value="$(awk -F= -v key="$key" '$1 == key {sub(/^[^=]*=/, ""); print; exit}' "$file")"
  [[ -n "$value" ]] || die "preflight blocked: $file missing $key"
  printf '%s' "$value"
}
is_uint() { [[ "$1" =~ ^[0-9]+$ ]]; }
assert_field() {
  local file="$1" key="$2" expected="$3" actual
  actual="$(read_field "$file" "$key")"
  [[ "$actual" == "$expected" ]] || die "preflight blocked: $file $key=$actual (expected $expected)"
}

# Required inputs are plain env-like fixture files.  They make every claim
# inspectable in CI without touching real app bundles, keychains, launchd, or
# Telegram state.
require_file "$OLD_META" "old baseline"
require_file "$NEW_META" "new app"
require_file "$INSTALLED_META" "installed app"
require_file "$MANAGED_META" "managed manifest"
require_file "$EXPECTED_MANAGED_META" "expected managed manifest"
require_file "$PUBLIC_FEED" "public feed"
require_file "$GATEWAY_META" "gateway identity"

available="$(cat "$FIXTURE_ROOT/disk.available_bytes" 2>/dev/null || true)"
is_uint "$available" || die "preflight blocked: disk.available_bytes is not numeric"
is_uint "$MIN_FREE_BYTES" || die "invalid JARVIS_SPARKLE_MIN_FREE_BYTES"
(( available >= MIN_FREE_BYTES )) || die "preflight blocked: insufficient disposable disk (${available} < ${MIN_FREE_BYTES})"
[[ ! -e "$FIXTURE_ROOT/debug-jarvis-processes" ]] || die "preflight blocked: debug Jarvis process marker is active"
[[ ! -e "$FIXTURE_ROOT/package-owner" ]] || die "preflight blocked: package owner marker is active"

# Inspect only the canonical lock.  We never acquire, reclaim, remove, or
# mutate it; even a stale-looking owner remains an operator handoff problem.
if [[ -e "$LOCK_FILE" && -s "$LOCK_FILE" ]]; then
  die "preflight blocked: canonical release lock is active (inspect-only: $LOCK_FILE)"
fi

old_build="$(read_field "$OLD_META" BUILD)"
new_build="$(read_field "$NEW_META" BUILD)"
old_version="$(read_field "$OLD_META" VERSION)"
new_version="$(read_field "$NEW_META" VERSION)"
is_uint "$old_build" && is_uint "$new_build" || die "preflight blocked: app builds must be numeric"
(( new_build > old_build )) || die "preflight blocked: new build must strictly increase (${old_build} -> ${new_build})"
[[ "$new_version" != "$old_version" || "$new_build" != "$old_build" ]] || die "preflight blocked: old/new app are identical"
for app_meta in "$OLD_META" "$NEW_META"; do
  assert_field "$app_meta" CODESIGN strict-valid
  assert_field "$app_meta" GATEKEEPER strict-valid
done
assert_field "$INSTALLED_META" VERSION "$old_version"
assert_field "$INSTALLED_META" BUILD "$old_build"

expected_commit="$(read_field "$EXPECTED_MANAGED_META" PACKAGE_COMMIT)"
new_commit="$(read_field "$NEW_META" PACKAGE_COMMIT)"
[[ "$new_commit" == "$expected_commit" ]] || die "preflight blocked: new package commit does not match expected package commit"
managed_commit="$(read_field "$MANAGED_META" PACKAGE_COMMIT)"
managed_build="$(read_field "$MANAGED_META" BUILD)"
is_uint "$managed_build" || die "preflight blocked: managed manifest BUILD is not numeric"
(( managed_build <= new_build )) || die "preflight blocked: managed manifest is newer than candidate app"
if [[ "$managed_commit" != "$expected_commit" && ( "$managed_build" != "$old_build" || "$managed_commit" != old ) ]]; then
  die "preflight blocked: managed manifest commit mismatch"
fi

assert_field "$PUBLIC_FEED" VERSION "$new_version"
assert_field "$PUBLIC_FEED" BUILD "$new_build"
assert_field "$PUBLIC_FEED" PACKAGE_COMMIT "$expected_commit"
assert_field "$GATEWAY_META" LABEL ai.jarvis.gateway
assert_field "$GATEWAY_META" IDENTITY ai.jarvis.gateway

if [[ -f "$FIXTURE_ROOT/telegram-nonce.expected" ]]; then
  require_file "$FIXTURE_ROOT/telegram-nonce.observed" "optional telegram-user nonce observation"
  cmp -s "$FIXTURE_ROOT/telegram-nonce.expected" "$FIXTURE_ROOT/telegram-nonce.observed" || die "preflight blocked: optional telegram-user nonce mismatch"
  log "telegram_nonce=verified"
else
  log "telegram_nonce=not_requested"
fi

log "preflight=passed"
log "release_lock=inspected_only path=$LOCK_FILE"
log "mutation=$([[ "$MODE" == apply ]] && printf enabled || printf disabled)"
log "live_publish=disabled"
log "live_package=disabled"
log "live_notarize=disabled"
log "live_restart=disabled"
log "live_telegram_send=disabled"

[[ "$MODE" == "apply" ]] || exit 0

# Apply is still synthetic: write only lane-owned disposable copies.  The
# actual package/publish/restart operations are explicitly out of scope.
[[ ! -e "$RUN_ROOT" ]] || die "preflight blocked: lane root already exists; refusing to reclaim it"
mkdir -p "$RUN_ROOT/sparkle-staging" "$RUN_ROOT/temp-prefs" "$RUN_ROOT/installed-app"
printf 'lane=jarvis-sparkle-update-e2e\n' >"$RUN_SENTINEL"
cp -- "$INSTALLED_META" "$RUN_ROOT/installed-app/before.env"
cp -- "$MANAGED_META" "$RUN_ROOT/managed-before.env"
cp -- "$NEW_META" "$RUN_ROOT/sparkle-staging/new-app.env"
cp -- "$INSTALLED_META" "$RUN_ROOT/installed-app/current.env"
sed -i.bak "s/^VERSION=.*/VERSION=$new_version/; s/^BUILD=.*/BUILD=$new_build/" "$RUN_ROOT/installed-app/current.env"
rm -f -- "$RUN_ROOT/installed-app/current.env.bak"
{
  printf 'FROM_VERSION=%s\n' "$old_version"
  printf 'FROM_BUILD=%s\n' "$old_build"
  printf 'TO_VERSION=%s\n' "$new_version"
  printf 'TO_BUILD=%s\n' "$new_build"
  printf 'PACKAGE_COMMIT=%s\n' "$expected_commit"
} >"$RUN_ROOT/sparkle-staging/transition.env"
cp -- "$EXPECTED_MANAGED_META" "$RUN_ROOT/managed-reseed.env"
cp -- "$GATEWAY_META" "$RUN_ROOT/gateway-after.env"
printf 'RESTARTED=exact-synthetic\n' >>"$RUN_ROOT/gateway-after.env"

# Post-apply assertions form separate proof layers so a passing transition
# cannot be mistaken for proof of a real public update or live gateway.
assert_field "$RUN_ROOT/installed-app/current.env" VERSION "$new_version"
assert_field "$RUN_ROOT/installed-app/current.env" BUILD "$new_build"
assert_field "$RUN_ROOT/sparkle-staging/transition.env" PACKAGE_COMMIT "$expected_commit"
assert_field "$RUN_ROOT/managed-reseed.env" PACKAGE_COMMIT "$expected_commit"
assert_field "$RUN_ROOT/gateway-after.env" LABEL ai.jarvis.gateway
assert_field "$RUN_ROOT/gateway-after.env" IDENTITY ai.jarvis.gateway
assert_field "$RUN_ROOT/gateway-after.env" RESTARTED exact-synthetic
log "PROOF_LAYER=installed_app version=$new_version build=$new_build"
log "PROOF_LAYER=sparkle_transition from_build=$old_build to_build=$new_build"
log "PROOF_LAYER=expected_package_commit commit=$expected_commit"
log "PROOF_LAYER=managed_manifest_reseed commit=$expected_commit"
log "PROOF_LAYER=gateway_identity label=ai.jarvis.gateway restart=exact-synthetic"
log "cleanup_scope=lane-owned-disposable-apps-sparkle-staging-temp-prefs"
exit 0
