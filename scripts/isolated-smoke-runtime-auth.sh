#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"

STATE_DIR=""
CONFIG_PATH=""
AGENT_ID="main"
MODEL_REF="${OPENCLAW_SMOKE_MODEL:-openai-codex/gpt-5.5}"
SOURCE_STATE_DIR="${OPENCLAW_SMOKE_AUTH_SOURCE_STATE_DIR:-$HOME/Library/Application Support/OpenClaw/.openclaw}"
SOURCE_AUTH_DIR="${OPENCLAW_SMOKE_AUTH_SOURCE_DIR:-}"
PROBE=1
PROBE_TIMEOUT_MS="${OPENCLAW_SMOKE_AUTH_PROBE_TIMEOUT_MS:-20000}"

usage() {
  cat <<'EOF'
Usage: bash scripts/isolated-smoke-runtime-auth.sh --state-dir <path> [options]

Bootstrap model auth into an isolated smoke runtime before browser/product tests.

Options:
  --state-dir <path>          Required isolated OPENCLAW_STATE_DIR.
  --config-path <path>        Optional isolated OPENCLAW_CONFIG_PATH to update/probe.
  --agent-id <id>             Agent id to seed (default: main).
  --model <provider/model>    Model to pin/probe (default: openai-codex/gpt-5.5).
  --source-state-dir <path>   Source app-owned OpenClaw state dir.
  --source-auth-dir <path>    Source agent dir containing auth-profiles.json.
  --no-probe                  Copy and fingerprint only; skip no-op model probe.

Default source state:
  ~/Library/Application Support/OpenClaw/.openclaw
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --state-dir)
      [[ $# -ge 2 ]] || { echo "ERROR: --state-dir requires a value." >&2; exit 1; }
      STATE_DIR="$2"
      shift 2
      ;;
    --config-path)
      [[ $# -ge 2 ]] || { echo "ERROR: --config-path requires a value." >&2; exit 1; }
      CONFIG_PATH="$2"
      shift 2
      ;;
    --agent-id)
      [[ $# -ge 2 ]] || { echo "ERROR: --agent-id requires a value." >&2; exit 1; }
      AGENT_ID="$2"
      shift 2
      ;;
    --model)
      [[ $# -ge 2 ]] || { echo "ERROR: --model requires a value." >&2; exit 1; }
      MODEL_REF="$2"
      shift 2
      ;;
    --source-state-dir)
      [[ $# -ge 2 ]] || { echo "ERROR: --source-state-dir requires a value." >&2; exit 1; }
      SOURCE_STATE_DIR="$2"
      shift 2
      ;;
    --source-auth-dir)
      [[ $# -ge 2 ]] || { echo "ERROR: --source-auth-dir requires a value." >&2; exit 1; }
      SOURCE_AUTH_DIR="$2"
      shift 2
      ;;
    --no-probe)
      PROBE=0
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$STATE_DIR" ]]; then
  echo "ERROR: --state-dir is required." >&2
  usage >&2
  exit 1
fi

if [[ -z "$SOURCE_AUTH_DIR" ]]; then
  SOURCE_AUTH_DIR="${SOURCE_STATE_DIR%/}/agents/${AGENT_ID}/agent"
fi

SOURCE_AUTH_PATH="${SOURCE_AUTH_DIR%/}/auth-profiles.json"
TARGET_AUTH_PATH="${STATE_DIR%/}/agents/${AGENT_ID}/agent/auth-profiles.json"

umask 077
mkdir -p "$(dirname "$TARGET_AUTH_PATH")"
if [[ -n "$CONFIG_PATH" ]]; then
  mkdir -p "$(dirname "$CONFIG_PATH")"
fi

OPENCLAW_SMOKE_STATE_DIR="$STATE_DIR" \
OPENCLAW_SMOKE_CONFIG_PATH="$CONFIG_PATH" \
OPENCLAW_SMOKE_SOURCE_AUTH_PATH="$SOURCE_AUTH_PATH" \
OPENCLAW_SMOKE_TARGET_AUTH_PATH="$TARGET_AUTH_PATH" \
OPENCLAW_SMOKE_AGENT_ID="$AGENT_ID" \
OPENCLAW_SMOKE_MODEL_REF="$MODEL_REF" \
node --input-type=module <<'NODE'
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const sourceAuthPath = process.env.OPENCLAW_SMOKE_SOURCE_AUTH_PATH ?? "";
const targetAuthPath = process.env.OPENCLAW_SMOKE_TARGET_AUTH_PATH ?? "";
const configPath = process.env.OPENCLAW_SMOKE_CONFIG_PATH ?? "";
const modelRef = process.env.OPENCLAW_SMOKE_MODEL_REF ?? "";

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    fail(`invalid JSON: ${filePath}`);
  }
}

function providerFromModel(ref) {
  const slash = String(ref).indexOf("/");
  return slash > 0 ? String(ref).slice(0, slash).trim().toLowerCase() : "";
}

const provider = providerFromModel(modelRef);
if (!provider) {
  fail(`model must be provider/model, got: ${modelRef || "(empty)"}`);
}
if (!fs.existsSync(sourceAuthPath)) {
  fail(`source auth store missing: ${sourceAuthPath}`);
}

const sourceStore = readJson(sourceAuthPath);
const sourceProfiles =
  sourceStore?.profiles && typeof sourceStore.profiles === "object" ? sourceStore.profiles : {};
const selectedProfiles = {};
for (const [profileId, profile] of Object.entries(sourceProfiles)) {
  const profileProvider = String(profile?.provider ?? profileId.split(":")[0] ?? "")
    .trim()
    .toLowerCase();
  if (profileProvider === provider) {
    selectedProfiles[profileId] = profile;
  }
}
if (Object.keys(selectedProfiles).length === 0) {
  fail(`source auth store has no profiles for provider "${provider}": ${sourceAuthPath}`);
}

const sourceOrder = sourceStore?.order && typeof sourceStore.order === "object" ? sourceStore.order : {};
const selectedOrder = Array.isArray(sourceOrder[provider])
  ? sourceOrder[provider].filter((id) => Object.hasOwn(selectedProfiles, id))
  : Object.keys(selectedProfiles);
const targetStore = {
  version: Number(sourceStore?.version ?? 1),
  profiles: selectedProfiles,
  order: {
    [provider]: selectedOrder.length > 0 ? selectedOrder : Object.keys(selectedProfiles),
  },
};
if (sourceStore?.usageStats && typeof sourceStore.usageStats === "object") {
  const usageStats = {};
  for (const profileId of Object.keys(selectedProfiles)) {
    if (sourceStore.usageStats[profileId]) {
      usageStats[profileId] = sourceStore.usageStats[profileId];
    }
  }
  if (Object.keys(usageStats).length > 0) {
    targetStore.usageStats = usageStats;
  }
}

fs.mkdirSync(path.dirname(targetAuthPath), { recursive: true });
fs.writeFileSync(targetAuthPath, `${JSON.stringify(targetStore, null, 2)}\n`, "utf8");
fs.chmodSync(targetAuthPath, 0o600);

if (configPath) {
  let config = {};
  if (fs.existsSync(configPath)) {
    config = readJson(configPath);
  }
  config.agents = config.agents && typeof config.agents === "object" ? config.agents : {};
  config.agents.defaults =
    config.agents.defaults && typeof config.agents.defaults === "object"
      ? config.agents.defaults
      : {};
  config.agents.defaults.model = { primary: modelRef, fallbacks: [] };
  const models =
    config.agents.defaults.models && typeof config.agents.defaults.models === "object"
      ? config.agents.defaults.models
      : {};
  models[modelRef] = {
    ...(models[modelRef] && typeof models[modelRef] === "object" ? models[modelRef] : {}),
    alias: models[modelRef]?.alias ?? modelRef,
  };
  config.agents.defaults.models = models;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  fs.chmodSync(configPath, 0o600);
}

const sourceHash = sha256File(sourceAuthPath);
const targetHash = sha256File(targetAuthPath);
console.log("smoke_auth_bootstrap=ok");
console.log(`smoke_auth_source=${sourceAuthPath}`);
console.log(`smoke_auth_target=${targetAuthPath}`);
console.log(`smoke_auth_provider=${provider}`);
console.log(`smoke_auth_profiles=${Object.keys(selectedProfiles).join(",")}`);
console.log(`smoke_auth_source_fingerprint=${sourceHash}`);
console.log(`smoke_auth_target_fingerprint=${targetHash}`);
if (configPath) {
  console.log(`smoke_config_path=${configPath}`);
  console.log(`smoke_model=${modelRef}`);
}
NODE

if [[ "$PROBE" -eq 0 ]]; then
  echo "smoke_auth_probe=skipped"
  exit 0
fi

PROVIDER="${MODEL_REF%%/*}"
PROBE_ENV=(
  "OPENCLAW_STATE_DIR=$STATE_DIR"
)
if [[ -n "$CONFIG_PATH" ]]; then
  PROBE_ENV+=("OPENCLAW_CONFIG_PATH=$CONFIG_PATH")
fi

if [[ "$PROVIDER" == "openai-codex" ]]; then
  set +e
  env -u OPENAI_API_KEY \
    -u OPENAI_MODEL_API_KEY \
    -u OPENAI_BASE_URL \
    -u OPENAI_API_BASE \
    -u OPENAI_MODEL \
    -u OPENAI_ORG_ID \
    -u OPENAI_ORGANIZATION \
    -u OPENAI_PROJECT \
    -u OPENAI_PROJECT_ID \
    -u OPENCLAW_CONSUMER_OPENAI_API_KEY \
    "${PROBE_ENV[@]}" \
    node "$ROOT/openclaw.mjs" models status --json --check --probe \
      --probe-provider "$PROVIDER" \
      --probe-timeout "$PROBE_TIMEOUT_MS" \
      --probe-concurrency 1 \
      --probe-max-tokens 8 >/tmp/openclaw-smoke-auth-probe.$$.json
  PROBE_EXIT=$?
  set -e
else
  set +e
  env "${PROBE_ENV[@]}" \
    node "$ROOT/openclaw.mjs" models status --json --check --probe \
      --probe-provider "$PROVIDER" \
      --probe-timeout "$PROBE_TIMEOUT_MS" \
      --probe-concurrency 1 \
      --probe-max-tokens 8 >/tmp/openclaw-smoke-auth-probe.$$.json
  PROBE_EXIT=$?
  set -e
fi

OPENCLAW_SMOKE_AUTH_PROBE_EXIT="$PROBE_EXIT" \
node --input-type=module <<'NODE'
import fs from "node:fs";
const path = `/tmp/openclaw-smoke-auth-probe.${process.ppid}.json`;
const commandExit = Number(process.env.OPENCLAW_SMOKE_AUTH_PROBE_EXIT ?? "1");
const raw = fs.existsSync(path) ? fs.readFileSync(path, "utf8") : "";
try {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  const data = JSON.parse(raw.slice(start, end + 1));
  const results = data.auth?.probes?.results ?? [];
  const ok = Array.isArray(results) && results.some((entry) => entry.status === "ok");
  console.log(`smoke_auth_probe=${ok ? "ok" : "failed"}`);
  console.log(`smoke_auth_probe_command_exit=${Number.isFinite(commandExit) ? commandExit : "unknown"}`);
  if (!ok && Array.isArray(results)) {
    for (const entry of results.slice(0, 5)) {
      console.log(
        `smoke_auth_probe_result=${entry.provider ?? "unknown"}:${entry.profileId ?? entry.source ?? "unknown"}:${entry.status ?? "unknown"}`,
      );
    }
  }
  process.exit(ok ? 0 : 1);
} catch {
  console.log("smoke_auth_probe=unparseable");
  process.exit(1);
} finally {
  try {
    fs.unlinkSync(path);
  } catch {}
}
NODE
