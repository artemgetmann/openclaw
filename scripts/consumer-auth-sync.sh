#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
# shellcheck source=scripts/lib/consumer-instance.sh
source "$ROOT/scripts/lib/consumer-instance.sh"

INSTANCE_ARG="${OPENCLAW_CONSUMER_INSTANCE_ID:-}"
SOURCE_AUTH_DIR="${OPENCLAW_CONSUMER_AUTH_SOURCE_DIR:-$HOME/.openclaw/agents/main/agent}"
TARGET_AGENT_ID="${OPENCLAW_CONSUMER_AUTH_AGENT_ID:-main}"
CHECK_ONLY=0
QUIET=0

usage() {
  cat <<'EOF'
Usage: bash scripts/consumer-auth-sync.sh [--instance <id>] [--source-auth-dir <path>] [--agent-id <id>] [--check] [--quiet]

Copy the canonical auth-profiles snapshot into a consumer tester instance and
write a non-secret fingerprint record alongside it.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --instance requires a value." >&2
        exit 1
      fi
      INSTANCE_ARG="$2"
      shift 2
      ;;
    --source-auth-dir)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --source-auth-dir requires a value." >&2
        exit 1
      fi
      SOURCE_AUTH_DIR="$2"
      shift 2
      ;;
    --agent-id)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --agent-id requires a value." >&2
        exit 1
      fi
      TARGET_AGENT_ID="$2"
      shift 2
      ;;
    --check)
      CHECK_ONLY=1
      shift
      ;;
    --quiet)
      QUIET=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

INSTANCE_ID="$(consumer_instance_normalize_id "$INSTANCE_ARG")"
if [[ -z "$INSTANCE_ID" ]]; then
  INSTANCE_ID="$(consumer_instance_default_id_for_checkout "$ROOT")"
fi
if [[ -z "$INSTANCE_ID" ]]; then
  echo "ERROR: missing consumer instance id. Pass --instance or set OPENCLAW_CONSUMER_INSTANCE_ID." >&2
  exit 1
fi

SOURCE_AUTH_DIR="${SOURCE_AUTH_DIR%/}"
SOURCE_AUTH_PATH="$SOURCE_AUTH_DIR/auth-profiles.json"
TARGET_STATE_DIR="$(consumer_instance_state_dir "$INSTANCE_ID")"
TARGET_AUTH_DIR="$TARGET_STATE_DIR/agents/$TARGET_AGENT_ID/agent"
TARGET_AUTH_PATH="$TARGET_AUTH_DIR/auth-profiles.json"
SYNC_META_PATH="$TARGET_AUTH_DIR/auth-sync.json"

umask 077

if [[ ! -f "$SOURCE_AUTH_PATH" ]]; then
  echo "ERROR: canonical auth snapshot missing: $SOURCE_AUTH_PATH" >&2
  exit 1
fi

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  OPENCLAW_CONSUMER_AUTH_SYNC_SOURCE_PATH="$SOURCE_AUTH_PATH" \
    OPENCLAW_CONSUMER_AUTH_SYNC_TARGET_PATH="$TARGET_AUTH_PATH" \
    OPENCLAW_CONSUMER_AUTH_SYNC_META_PATH="$SYNC_META_PATH" \
    OPENCLAW_CONSUMER_AUTH_SYNC_INSTANCE_ID="$INSTANCE_ID" \
    OPENCLAW_CONSUMER_AUTH_SYNC_AGENT_ID="$TARGET_AGENT_ID" \
    OPENCLAW_CONSUMER_AUTH_SYNC_MODE="check" \
    OPENCLAW_CONSUMER_AUTH_SYNC_QUIET="$QUIET" \
    node --input-type=module <<'NODE'
import crypto from "node:crypto";
import fs from "node:fs";

const sourcePath = process.env.OPENCLAW_CONSUMER_AUTH_SYNC_SOURCE_PATH ?? "";
const targetPath = process.env.OPENCLAW_CONSUMER_AUTH_SYNC_TARGET_PATH ?? "";
const metaPath = process.env.OPENCLAW_CONSUMER_AUTH_SYNC_META_PATH ?? "";
const instanceId = process.env.OPENCLAW_CONSUMER_AUTH_SYNC_INSTANCE_ID ?? "unknown";
const agentId = process.env.OPENCLAW_CONSUMER_AUTH_SYNC_AGENT_ID ?? "main";
const quiet = process.env.OPENCLAW_CONSUMER_AUTH_SYNC_QUIET === "1";

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

if (!fs.existsSync(targetPath)) {
  fail(`consumer auth sync missing for instance ${instanceId}. Run: bash scripts/consumer-auth-sync.sh --instance ${instanceId}`);
}

if (!fs.existsSync(metaPath)) {
  fail(`consumer auth sync metadata missing for instance ${instanceId}. Run: bash scripts/consumer-auth-sync.sh --instance ${instanceId}`);
}

const sourceHash = sha256(sourcePath);
const targetHash = sha256(targetPath);
const meta = readJson(metaPath);

if (
  !meta ||
  meta.sourceHash !== sourceHash ||
  meta.targetHash !== targetHash ||
  meta.instanceId !== instanceId ||
  meta.agentId !== agentId ||
  meta.sourcePath !== sourcePath ||
  meta.targetPath !== targetPath
) {
  fail(`consumer auth sync is stale for instance ${instanceId}. Run: bash scripts/consumer-auth-sync.sh --instance ${instanceId}`);
}

if (!quiet) {
  console.log(`auth_sync=ok`);
  console.log(`auth_sync_instance=${instanceId}`);
  console.log(`auth_sync_agent=${agentId}`);
  console.log(`auth_sync_fingerprint=${sourceHash}`);
}
NODE
  exit 0
fi

mkdir -p "$TARGET_AUTH_DIR"
tmp_auth="$(mktemp "${TARGET_AUTH_DIR}/auth-profiles.json.tmp.XXXXXX")"
tmp_meta="$(mktemp "${TARGET_AUTH_DIR}/auth-sync.json.tmp.XXXXXX")"
cleanup() {
  rm -f "$tmp_auth" "$tmp_meta"
}
trap cleanup EXIT

cp "$SOURCE_AUTH_PATH" "$tmp_auth"
chmod 600 "$tmp_auth"
mv "$tmp_auth" "$TARGET_AUTH_PATH"

SOURCE_HASH="$(
  OPENCLAW_CONSUMER_AUTH_SYNC_SOURCE_PATH="$SOURCE_AUTH_PATH" \
    node --input-type=module <<'NODE'
import crypto from "node:crypto";
import fs from "node:fs";
const sourcePath = process.env.OPENCLAW_CONSUMER_AUTH_SYNC_SOURCE_PATH ?? "";
process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex"));
NODE
)"
TARGET_HASH="$SOURCE_HASH"
SOURCE_SIZE="$(stat -f '%z' "$SOURCE_AUTH_PATH" 2>/dev/null || stat -c '%s' "$SOURCE_AUTH_PATH" 2>/dev/null || printf '0')"
SOURCE_MTIME_MS="$(SOURCE_AUTH_PATH="$SOURCE_AUTH_PATH" node --input-type=module <<'NODE'
import fs from "node:fs";
const sourcePath = process.env.SOURCE_AUTH_PATH ?? "";
process.stdout.write(String(Math.trunc(fs.statSync(sourcePath).mtimeMs)));
NODE
)"

OPENCLAW_CONSUMER_AUTH_SYNC_SOURCE_PATH="$SOURCE_AUTH_PATH" \
  OPENCLAW_CONSUMER_AUTH_SYNC_TARGET_PATH="$TARGET_AUTH_PATH" \
  OPENCLAW_CONSUMER_AUTH_SYNC_META_PATH="$tmp_meta" \
  OPENCLAW_CONSUMER_AUTH_SYNC_INSTANCE_ID="$INSTANCE_ID" \
  OPENCLAW_CONSUMER_AUTH_SYNC_AGENT_ID="$TARGET_AGENT_ID" \
  OPENCLAW_CONSUMER_AUTH_SYNC_SOURCE_HASH="$SOURCE_HASH" \
  OPENCLAW_CONSUMER_AUTH_SYNC_TARGET_HASH="$TARGET_HASH" \
  OPENCLAW_CONSUMER_AUTH_SYNC_SOURCE_SIZE="$SOURCE_SIZE" \
  OPENCLAW_CONSUMER_AUTH_SYNC_SOURCE_MTIME_MS="$SOURCE_MTIME_MS" \
  node --input-type=module <<'NODE'
import fs from "node:fs";

const metaPath = process.env.OPENCLAW_CONSUMER_AUTH_SYNC_META_PATH ?? "";
const payload = {
  sourcePath: process.env.OPENCLAW_CONSUMER_AUTH_SYNC_SOURCE_PATH ?? "",
  targetPath: process.env.OPENCLAW_CONSUMER_AUTH_SYNC_TARGET_PATH ?? "",
  sourceHash: process.env.OPENCLAW_CONSUMER_AUTH_SYNC_SOURCE_HASH ?? "",
  targetHash: process.env.OPENCLAW_CONSUMER_AUTH_SYNC_TARGET_HASH ?? "",
  sourceSize: Number(process.env.OPENCLAW_CONSUMER_AUTH_SYNC_SOURCE_SIZE ?? "0"),
  sourceMtimeMs: Number(process.env.OPENCLAW_CONSUMER_AUTH_SYNC_SOURCE_MTIME_MS ?? "0"),
  instanceId: process.env.OPENCLAW_CONSUMER_AUTH_SYNC_INSTANCE_ID ?? "unknown",
  agentId: process.env.OPENCLAW_CONSUMER_AUTH_SYNC_AGENT_ID ?? "main",
  syncedAt: new Date().toISOString(),
};

fs.writeFileSync(metaPath, `${JSON.stringify(payload, null, 2)}\n`);
fs.chmodSync(metaPath, 0o600);
NODE

chmod 600 "$TARGET_AUTH_PATH"
mv "$tmp_meta" "$SYNC_META_PATH"
trap - EXIT

if [[ "$QUIET" -eq 0 ]]; then
  echo "auth_sync=ok"
  echo "auth_sync_instance=$INSTANCE_ID"
  echo "auth_sync_agent=$TARGET_AGENT_ID"
  echo "auth_sync_fingerprint=$SOURCE_HASH"
fi
