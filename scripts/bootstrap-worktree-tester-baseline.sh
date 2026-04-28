#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
HELPER_MODULE="$ROOT/scripts/lib/worktree-tester-baseline.mjs"

TARGET_ROOT="$ROOT"
QUIET=0
SOURCE_CONFIG_PATH="${OPENCLAW_WORKTREE_BASELINE_SOURCE_CONFIG_PATH:-${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}}"
SOURCE_STATE_DIR="${OPENCLAW_WORKTREE_BASELINE_SOURCE_STATE_DIR:-}"

usage() {
  cat <<'EOF'
Usage: scripts/bootstrap-worktree-tester-baseline.sh [--root <worktree-path>] [--quiet]
EOF
}

emit() {
  if [[ "$QUIET" != "1" ]]; then
    printf '%s\n' "$1"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      if [[ $# -lt 2 ]]; then
        echo "Error: --root requires a value." >&2
        exit 1
      fi
      TARGET_ROOT="$2"
      shift 2
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
      echo "Error: unexpected argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

TARGET_ROOT="$(cd -- "$TARGET_ROOT" && pwd -P)"
if [[ ! -f "$TARGET_ROOT/package.json" ]]; then
  echo "Error: not a repo root: $TARGET_ROOT" >&2
  exit 1
fi

if [[ -z "$SOURCE_STATE_DIR" ]]; then
  SOURCE_STATE_DIR="$(cd -- "$(dirname -- "$SOURCE_CONFIG_PATH")" 2>/dev/null && pwd -P || true)"
fi

bootstrap_output="$(
  HELPER_MODULE="$HELPER_MODULE" \
  TARGET_ROOT="$TARGET_ROOT" \
  SOURCE_CONFIG_PATH="$SOURCE_CONFIG_PATH" \
  SOURCE_STATE_DIR="$SOURCE_STATE_DIR" \
  node --input-type=module - <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const helperPath = process.env.HELPER_MODULE ?? "";
const targetRoot = process.env.TARGET_ROOT ?? "";
const sourceConfigPath = process.env.SOURCE_CONFIG_PATH ?? "";
const sourceStateDir = process.env.SOURCE_STATE_DIR ?? "";

if (!helperPath || !targetRoot) {
  throw new Error("Missing helper module path or target root.");
}

const {
  deriveWorktreeTesterBaseline,
  resolveTesterBaselineAgentIds,
  sanitizeInheritedTesterConfigWithMetadata,
  sha256File,
} = await import(pathToFileURL(helperPath).href);

const baseline = deriveWorktreeTesterBaseline({ worktreePath: targetRoot });
// Materialize the tester baseline once per worktree so new lanes stop
// depending on ambient ~/.openclaw state during validation.
fs.mkdirSync(baseline.stateDir, { recursive: true });

let sourceConfig = {};
let sourceConfigPresent = false;
if (sourceConfigPath && fs.existsSync(sourceConfigPath)) {
  sourceConfigPresent = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(sourceConfigPath, "utf8"));
    if (parsed && typeof parsed === "object") {
      sourceConfig = parsed;
    }
  } catch {
    sourceConfig = {};
  }
}

const { config: sanitizedConfig, metadata: sanitizationMetadata } =
  sanitizeInheritedTesterConfigWithMetadata(sourceConfig);
fs.writeFileSync(baseline.configPath, `${JSON.stringify(sanitizedConfig, null, 2)}\n`, "utf8");
fs.chmodSync(baseline.configPath, 0o600);

const agentIds = resolveTesterBaselineAgentIds(sourceConfig);
const syncedAgents = [];
for (const agentId of agentIds) {
  // Copy auth snapshots instead of sharing live files so worktrees get a known
  // good baseline without mutating the sacred source runtime.
  const sourceAuthPath = path.join(sourceStateDir, "agents", agentId, "agent", "auth-profiles.json");
  if (!sourceStateDir || !fs.existsSync(sourceAuthPath)) {
    continue;
  }
  const targetAuthPath = path.join(
    baseline.stateDir,
    "agents",
    agentId,
    "agent",
    "auth-profiles.json",
  );
  fs.mkdirSync(path.dirname(targetAuthPath), { recursive: true });
  fs.copyFileSync(sourceAuthPath, targetAuthPath);
  fs.chmodSync(targetAuthPath, 0o600);
  syncedAgents.push({
    agentId,
    sourcePath: sourceAuthPath,
    targetPath: targetAuthPath,
    sourceHash: sha256File(sourceAuthPath),
    targetHash: sha256File(targetAuthPath),
  });
}

const meta = {
  sourceConfigPath,
  sourceConfigPresent,
  sourceStateDir,
  baselineId: baseline.baselineId,
  stateDir: baseline.stateDir,
  configPath: baseline.configPath,
  configHash: sha256File(baseline.configPath),
  syncedAt: new Date().toISOString(),
  syncedAgents,
  sanitization: sanitizationMetadata,
};
fs.writeFileSync(baseline.metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
fs.chmodSync(baseline.metaPath, 0o600);

console.log(`baseline_id=${baseline.baselineId}`);
console.log(`baseline_state_dir=${baseline.stateDir}`);
console.log(`baseline_config_path=${baseline.configPath}`);
console.log(`baseline_source_config=${sourceConfigPresent ? sourceConfigPath : "missing"}`);
console.log(`baseline_synced_agents=${syncedAgents.map((entry) => entry.agentId).join(",") || "none"}`);
console.log(`baseline_meta_path=${baseline.metaPath}`);
console.log(
  `baseline_stripped_named_telegram_accounts=${
    sanitizationMetadata.strippedNamedTelegramAccounts.join(",") || "none"
  }`,
);
NODE
)"

while IFS= read -r line || [[ -n "$line" ]]; do
  emit "$line"
done <<< "$bootstrap_output"
