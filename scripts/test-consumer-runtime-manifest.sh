#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/consumer-runtime-manifest.sh
source "$ROOT_DIR/scripts/lib/consumer-runtime-manifest.sh"

NODE_BIN="${OPENCLAW_NODE_BIN:-node}"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/consumer-runtime-manifest-test.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

manifest="$TMP_ROOT/manifest.json"
cat >"$manifest" <<'JSON'
{"format":1,"bundleVersion":"100","gitCommit":"aaaaaaa","nodeVersion":"22.22.1","uvVersion":"0.9.21","runtimeInputKey":"payload-key","extraReceiptField":"preserved"}
JSON

openclaw_refresh_consumer_runtime_manifest "$NODE_BIN" "$manifest" "bbbbbbb" "200"
"$NODE_BIN" --input-type=module - "$manifest" <<'NODE'
import fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (
  manifest.gitCommit !== "bbbbbbb" ||
  manifest.bundleVersion !== "200" ||
  manifest.nodeVersion !== "22.22.1" ||
  manifest.uvVersion !== "0.9.21" ||
  manifest.runtimeInputKey !== "payload-key" ||
  manifest.extraReceiptField !== "preserved"
) {
  throw new Error(`refreshed manifest did not preserve payload identity: ${JSON.stringify(manifest)}`);
}
NODE

malformed="$TMP_ROOT/malformed.json"
cat >"$malformed" <<'JSON'
{"format":1,"bundleVersion":"100","gitCommit":"not-a-commit","nodeVersion":"22.22.1","uvVersion":"0.9.21","runtimeInputKey":"payload-key"}
JSON
cp "$malformed" "$malformed.before"
if openclaw_refresh_consumer_runtime_manifest "$NODE_BIN" "$malformed" "bbbbbbb" "200" >/dev/null 2>&1; then
  echo "ERROR: malformed cached runtime manifest was accepted" >&2
  exit 1
fi
cmp "$malformed.before" "$malformed"

echo "consumer_runtime_manifest_refresh=ok"
