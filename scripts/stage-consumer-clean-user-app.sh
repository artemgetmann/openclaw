#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_APP="${1:-${ROOT_DIR}/dist/OpenClaw Consumer.app}"
DEST_APP="${2:-/Users/Shared/OpenClaw Consumer.app}"
STAMP_FILE="${3:-/Users/Shared/openclaw-clean-user-stage.txt}"

plist_value() {
  local plist_path="$1"
  local key_path="$2"
  /usr/libexec/PlistBuddy -c "Print :${key_path}" "$plist_path" 2>/dev/null || true
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

if [[ ! -d "$SOURCE_APP" ]]; then
  fail "missing packaged consumer app: $SOURCE_APP"
fi

SOURCE_INFO_PLIST="$SOURCE_APP/Contents/Info.plist"
SOURCE_BUILD=$(/usr/bin/defaults read "$SOURCE_APP/Contents/Info" CFBundleVersion 2>/dev/null || true)
SOURCE_COMMIT="$(plist_value "$SOURCE_INFO_PLIST" "OpenClawGitCommit")"
REPO_HEAD="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || true)"

if [[ -z "$SOURCE_BUILD" ]]; then
  fail "packaged consumer app is missing CFBundleVersion: $SOURCE_APP"
fi
if [[ -z "$SOURCE_COMMIT" ]]; then
  fail "packaged consumer app is missing OpenClawGitCommit: $SOURCE_APP"
fi
if [[ -z "$REPO_HEAD" ]]; then
  fail "unable to read repository HEAD for freshness check in $ROOT_DIR"
fi
if [[ "$SOURCE_COMMIT" != "$REPO_HEAD" ]]; then
  fail "staged app is stale: packaged app commit $SOURCE_COMMIT does not match repo HEAD $REPO_HEAD. Re-run packaging before the clean-user smoke."
fi

printf 'Staging consumer app for clean-user smoke\n'
printf '  source=%s\n' "$SOURCE_APP"
printf '  dest=%s\n' "$DEST_APP"
printf '  source_build=%s\n' "$SOURCE_BUILD"
printf '  source_commit=%s\n' "$SOURCE_COMMIT"

rm -rf "$DEST_APP"
/usr/bin/ditto "$SOURCE_APP" "$DEST_APP"

DEST_INFO_PLIST="$DEST_APP/Contents/Info.plist"
DEST_BUILD=$(/usr/bin/defaults read "$DEST_APP/Contents/Info" CFBundleVersion 2>/dev/null || true)
DEST_COMMIT="$(plist_value "$DEST_INFO_PLIST" "OpenClawGitCommit")"

if [[ "$DEST_BUILD" != "$SOURCE_BUILD" ]]; then
  fail "staged app build mismatch: source=$SOURCE_BUILD dest=$DEST_BUILD"
fi
if [[ "$DEST_COMMIT" != "$SOURCE_COMMIT" ]]; then
  fail "staged app commit mismatch: source=$SOURCE_COMMIT dest=$DEST_COMMIT"
fi

mkdir -p "$(dirname "$STAMP_FILE")"
cat > "$STAMP_FILE" <<EOF
timestamp=$(date -Iseconds)
source_app=$SOURCE_APP
dest_app=$DEST_APP
repo_root=$ROOT_DIR
repo_head=$REPO_HEAD
source_build=$SOURCE_BUILD
source_commit=$SOURCE_COMMIT
dest_build=$DEST_BUILD
dest_commit=$DEST_COMMIT
EOF
chmod 644 "$STAMP_FILE" 2>/dev/null || true

printf 'Staged consumer app verified\n'
printf '  dest_build=%s\n' "$DEST_BUILD"
printf '  dest_commit=%s\n' "$DEST_COMMIT"
printf '  stamp=%s\n' "$STAMP_FILE"
