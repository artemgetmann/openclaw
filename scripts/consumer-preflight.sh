#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
PREFLIGHT="$ROOT/scripts/local-runtime-preflight.sh"
source "$ROOT/scripts/lib/consumer-instance.sh"

INSTANCE_ARG="${OPENCLAW_CONSUMER_INSTANCE_ID:-}"

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
    --help|-h)
      cat <<'EOF'
Usage: bash scripts/consumer-preflight.sh [--instance <id>]

Print the exact consumer lane identity before GUI testing:
- branch/worktree
- consumer instance id + runtime paths
- gateway port + launchd label
- local gateway health
- model auth health
- Telegram token collisions across local consumer runtimes
EOF
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -x "$PREFLIGHT" ]]; then
  "$PREFLIGHT" --quiet
fi

BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
WORKTREE="$(cd "$ROOT" && pwd -P)"
INSTANCE_ID="$(consumer_instance_normalize_id "$INSTANCE_ARG")"
if [[ -z "$INSTANCE_ID" ]]; then
  INSTANCE_ID="$(consumer_instance_default_id_for_checkout "$ROOT")"
fi

RUNTIME_ROOT="$(consumer_instance_runtime_root "$INSTANCE_ID")"
STATE_DIR="$(consumer_instance_state_dir "$INSTANCE_ID")"
CONFIG_PATH="$(consumer_instance_config_path "$INSTANCE_ID")"
GATEWAY_PORT="$(consumer_instance_gateway_port "$INSTANCE_ID")"
GATEWAY_LABEL="$(consumer_instance_gateway_launchd_label "$INSTANCE_ID")"
APP_LABEL="$(consumer_instance_launchd_label "$INSTANCE_ID")"
BUNDLE_ID="$(consumer_instance_bundle_id "$INSTANCE_ID")"
APP_NAME="$(consumer_instance_app_name "$INSTANCE_ID")"
INSTANCE_PRINT="${INSTANCE_ID:-default}"

echo "branch=${BRANCH}"
echo "worktree=${WORKTREE}"
echo "instance_id=${INSTANCE_PRINT}"
echo "app_name=${APP_NAME}"
echo "bundle_id=${BUNDLE_ID}"
echo "runtime_root=${RUNTIME_ROOT}"
echo "state_dir=${STATE_DIR}"
echo "config_path=${CONFIG_PATH}"
echo "gateway_port=${GATEWAY_PORT}"
echo "app_launchd_label=${APP_LABEL}"
echo "gateway_launchd_label=${GATEWAY_LABEL}"

# Run health checks through the local wrapper so we prove this checkout owns the
# lane before anyone starts clicking around in the app.
GATEWAY_OUTPUT="$(
  OPENCLAW_CONSUMER_INSTANCE_ID="$INSTANCE_ID" \
    pnpm openclaw:local gateway status --deep --require-rpc 2>&1
)" || {
  echo "gateway_status=failed"
  printf '%s\n' "$GATEWAY_OUTPUT"
  exit 1
}
echo "gateway_status=ok"

MODELS_JSON="$(
  OPENCLAW_CONSUMER_INSTANCE_ID="$INSTANCE_ID" \
    pnpm openclaw:local models status --json --check 2>&1
)" || {
  echo "models_status=failed"
  printf '%s\n' "$MODELS_JSON"
  exit 1
}

MODELS_SUMMARY="$(
  MODELS_JSON="$MODELS_JSON" node <<'EOF'
const payload = process.env.MODELS_JSON ?? "";
const jsonStart = payload.indexOf("{");
const jsonEnd = payload.lastIndexOf("}");
if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
  throw new Error("models status did not return JSON");
}
const data = JSON.parse(payload.slice(jsonStart, jsonEnd + 1));
const defaultModel = data.resolvedDefault ?? data.defaultModel ?? "unknown";
const providerSummary = (data.auth?.oauth?.providers ?? []).map((provider) => {
  return `${provider.provider}:${provider.status}`;
}).join(",");
process.stdout.write(`models_status=ok\ndefault_model=${defaultModel}\noauth_providers=${providerSummary || "none"}`);
EOF
)"
printf '%s\n' "$MODELS_SUMMARY"

TELEGRAM_SUMMARY="$(
  CURRENT_INSTANCE_ID="$INSTANCE_PRINT" CURRENT_LABEL="$GATEWAY_LABEL" node <<'EOF'
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");

const currentInstanceId = process.env.CURRENT_INSTANCE_ID ?? "default";
const currentLabel = process.env.CURRENT_LABEL ?? "ai.openclaw.consumer.gateway";
const uid = typeof process.getuid === "function" ? process.getuid() : null;
const baseRoot = path.join(os.homedir(), "Library", "Application Support", "OpenClaw Consumer");
const configs = [];

function launchdLoaded(label) {
  if (uid == null || process.platform !== "darwin") return false;
  try {
    cp.execFileSync("launchctl", ["print", `gui/${uid}/${label}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function normalizeToken(value) {
  return typeof value === "string" ? value.trim() : "";
}

function tokenFingerprint(token) {
  if (!token) return "";
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 10);
}

function labelFor(instanceId) {
  return instanceId === "default"
    ? "ai.openclaw.consumer.gateway"
    : `ai.openclaw.consumer.${instanceId}.gateway`;
}

function collect(instanceId, configPath) {
  if (!fs.existsSync(configPath)) return;
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const root = JSON.parse(raw);
    const telegram = root?.channels?.telegram ?? {};
    const token = normalizeToken(telegram.botToken);
    const label = labelFor(instanceId);
    configs.push({
      instanceId,
      configPath,
      enabled: telegram.enabled === true,
      dmPolicy: typeof telegram.dmPolicy === "string" ? telegram.dmPolicy : "",
      allowFromCount: Array.isArray(telegram.allowFrom) ? telegram.allowFrom.length : 0,
      tokenFingerprint: tokenFingerprint(token),
      hasToken: Boolean(token),
      launchdLoaded: launchdLoaded(label),
      launchdLabel: label,
    });
  } catch {
    configs.push({
      instanceId,
      configPath,
      enabled: false,
      dmPolicy: "",
      allowFromCount: 0,
      tokenFingerprint: "",
      hasToken: false,
      launchdLoaded: false,
      launchdLabel: labelFor(instanceId),
      invalid: true,
    });
  }
}

collect("default", path.join(baseRoot, ".openclaw", "openclaw.json"));

const instancesRoot = path.join(baseRoot, "instances");
if (fs.existsSync(instancesRoot)) {
  for (const entry of fs.readdirSync(instancesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    collect(entry.name, path.join(instancesRoot, entry.name, ".openclaw", "openclaw.json"));
  }
}

const current = configs.find((record) => record.instanceId === currentInstanceId);
if (!current) {
  process.stdout.write("telegram_status=missing-config");
  process.exit(0);
}

const collisions = current.tokenFingerprint
  ? configs.filter((record) => {
      return record.instanceId !== current.instanceId &&
        record.tokenFingerprint === current.tokenFingerprint &&
        record.hasToken;
    })
  : [];

const lines = [
  `telegram_status=${current.enabled && current.hasToken ? "configured" : "not-configured"}`,
  `telegram_launchd_loaded=${current.launchdLoaded ? "yes" : "no"}`,
  `telegram_dm_policy=${current.dmPolicy || "unset"}`,
  `telegram_allow_from_count=${current.allowFromCount}`,
  `telegram_token_fingerprint=${current.tokenFingerprint || "missing"}`,
  `telegram_token_collisions=${collisions.length}`,
];

for (const collision of collisions) {
  lines.push(
    `telegram_collision=${collision.instanceId}:${collision.launchdLoaded ? "loaded" : "stopped"}:${collision.configPath}`,
  );
}

const activeOwners = configs.filter((record) => record.launchdLoaded && record.enabled && record.hasToken);
for (const owner of activeOwners) {
  lines.push(`telegram_active_owner=${owner.instanceId}:${owner.tokenFingerprint}:${owner.launchdLabel}`);
}

process.stdout.write(lines.join("\n"));
EOF
)"
printf '%s\n' "$TELEGRAM_SUMMARY"

echo "consumer_preflight=ok"
