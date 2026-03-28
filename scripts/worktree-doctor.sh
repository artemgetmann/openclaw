#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SCRIPT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
ROOT="${OPENCLAW_WORKTREE_DOCTOR_ROOT:-$SCRIPT_ROOT}"
source "$SCRIPT_ROOT/scripts/lib/consumer-instance.sh"

MODE="generic"
INSTANCE_ID="${OPENCLAW_CONSUMER_INSTANCE_ID:-}"
TELEGRAM_MODE=""
REQUIRE_DEV_LAUNCH_ENV=0
REQUIRE_NODE_MODULES=0
REQUIRE_LAUNCHD_MATCH=0
REQUIRE_INSTANCE=0
QUIET=0
FAIL=0

usage() {
  cat <<'EOF'
Usage: scripts/worktree-doctor.sh [--mode <generic|consumer-preflight|dev-launch|new-worktree|open-consumer>] [options]

Options:
  --root <path>               Inspect a specific checkout instead of this script's repo
  --instance <id>             Check the named consumer instance
  --telegram-mode <skip|warn|fail>
  --require-dev-launch-env
  --require-node-modules
  --require-launchd-match
  --require-instance
  --quiet
EOF
}

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  FAIL=1
}

warn() {
  printf 'WARN: %s\n' "$1" >&2
}

emit() {
  if [[ "$QUIET" -eq 0 ]]; then
    printf '%s\n' "$1"
  fi
}

check_required_file() {
  local file_path="$1"
  local description="$2"
  if [[ ! -f "$file_path" ]]; then
    fail "$description missing: $file_path"
  fi
}

check_required_dir() {
  local dir_path="$1"
  local description="$2"
  if [[ ! -d "$dir_path" ]]; then
    fail "$description missing: $dir_path"
  fi
}

check_launchd_match() {
  local label="$1"
  local expected_path="$2"
  local category="$3"
  local output=""

  if [[ "$(uname -s)" != "Darwin" ]]; then
    return 0
  fi

  if ! output="$(launchctl print "gui/$(id -u)/${label}" 2>/dev/null)"; then
    return 0
  fi

  if [[ "$output" != *"$expected_path"* ]]; then
    fail "${category} launch agent does not point at this worktree: ${label}"
    emit "launchd_expected_path=${expected_path}"
  fi
}

telegram_collision_report() {
  local current_instance_id="$1"
  local current_label="$2"

  CURRENT_INSTANCE_ID="$current_instance_id" CURRENT_LABEL="$current_label" node <<'EOF'
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
  process.stdout.write("telegram_status=missing-config\n");
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

for (const line of lines) {
  console.log(line);
}

if (current.launchdLoaded && current.tokenFingerprint) {
  const owners = collisions.map((record) => record.instanceId).join(",");
  if (owners) {
    console.log(`telegram_collision_owners=${owners}`);
  }
}
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --mode requires a value." >&2
        exit 1
      fi
      MODE="$2"
      shift 2
      ;;
    --instance)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --instance requires a value." >&2
        exit 1
      fi
      INSTANCE_ID="$2"
      shift 2
      ;;
    --root)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --root requires a value." >&2
        exit 1
      fi
      ROOT="$2"
      shift 2
      ;;
    --telegram-mode)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --telegram-mode requires a value." >&2
        exit 1
      fi
      TELEGRAM_MODE="$2"
      shift 2
      ;;
    --require-dev-launch-env)
      REQUIRE_DEV_LAUNCH_ENV=1
      shift
      ;;
    --require-node-modules)
      REQUIRE_NODE_MODULES=1
      shift
      ;;
    --require-launchd-match)
      REQUIRE_LAUNCHD_MATCH=1
      shift
      ;;
    --require-instance)
      REQUIRE_INSTANCE=1
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
      usage >&2
      exit 1
      ;;
  esac
done

ROOT="$(cd "$ROOT" 2>/dev/null && pwd -P || printf '%s' "$ROOT")"

case "$MODE" in
  generic)
    : ;;
  consumer-preflight)
    REQUIRE_LAUNCHD_MATCH=1
    if [[ -z "$TELEGRAM_MODE" ]]; then
      TELEGRAM_MODE="warn"
    fi
    ;;
  dev-launch)
    REQUIRE_DEV_LAUNCH_ENV=1
    REQUIRE_NODE_MODULES=1
    REQUIRE_LAUNCHD_MATCH=1
    if [[ -z "$TELEGRAM_MODE" ]]; then
      TELEGRAM_MODE="warn"
    fi
    ;;
  new-worktree)
    REQUIRE_DEV_LAUNCH_ENV=1
    if [[ -z "$TELEGRAM_MODE" ]]; then
      TELEGRAM_MODE="warn"
    fi
    ;;
  open-consumer)
    REQUIRE_NODE_MODULES=1
    REQUIRE_LAUNCHD_MATCH=1
    if [[ -z "$TELEGRAM_MODE" ]]; then
      TELEGRAM_MODE="warn"
    fi
    ;;
  telegram-live)
    REQUIRE_NODE_MODULES=1
    REQUIRE_LAUNCHD_MATCH=1
    if [[ -z "$TELEGRAM_MODE" ]]; then
      TELEGRAM_MODE="fail"
    fi
    ;;
  *)
    echo "ERROR: unknown mode: $MODE" >&2
    usage >&2
    exit 1
    ;;
esac

if [[ -z "$TELEGRAM_MODE" ]]; then
  TELEGRAM_MODE="skip"
fi

if ! git -C "$ROOT" rev-parse --show-toplevel >/dev/null 2>&1; then
  fail "not a valid OpenClaw repo root: $ROOT"
fi

BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
HEAD_SHA="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
WORKTREE_PATH="$(cd "$ROOT" && pwd -P)"
git_common_dir="$(git -C "$ROOT" rev-parse --git-common-dir 2>/dev/null || true)"
git_common_dir="$(cd "$ROOT" && cd "$git_common_dir" 2>/dev/null && pwd -P || printf '%s' "$git_common_dir")"

if [[ -z "$BRANCH" || "$BRANCH" == "HEAD" ]]; then
  fail "current checkout is detached HEAD"
fi

emit "branch=${BRANCH}"
emit "worktree=${WORKTREE_PATH}"
emit "head=${HEAD_SHA}"
emit "git_common_dir=${git_common_dir}"
emit "mode=${MODE}"

if [[ "$REQUIRE_NODE_MODULES" -eq 1 ]]; then
  check_required_dir "$ROOT/node_modules" "node_modules"
fi

if [[ "$REQUIRE_DEV_LAUNCH_ENV" -eq 1 ]]; then
  check_required_file "$ROOT/.dev-launch.env" ".dev-launch.env"
fi

NORMALIZED_INSTANCE_ID="$(consumer_instance_normalize_id "$INSTANCE_ID")"
if [[ -z "$NORMALIZED_INSTANCE_ID" ]]; then
  NORMALIZED_INSTANCE_ID="$(consumer_instance_default_id_for_checkout "$ROOT")"
fi

if [[ -n "$NORMALIZED_INSTANCE_ID" || "$REQUIRE_INSTANCE" -eq 1 ]]; then
  if [[ -z "$NORMALIZED_INSTANCE_ID" ]]; then
    fail "consumer instance id could not be inferred for this checkout"
  else
    RUNTIME_ROOT="$(consumer_instance_runtime_root "$NORMALIZED_INSTANCE_ID")"
    STATE_DIR="$(consumer_instance_state_dir "$NORMALIZED_INSTANCE_ID")"
    CONFIG_PATH="$(consumer_instance_config_path "$NORMALIZED_INSTANCE_ID")"
    GATEWAY_PORT="$(consumer_instance_gateway_port "$NORMALIZED_INSTANCE_ID")"
    APP_LABEL="$(consumer_instance_launchd_label "$NORMALIZED_INSTANCE_ID")"
    GATEWAY_LABEL="$(consumer_instance_gateway_launchd_label "$NORMALIZED_INSTANCE_ID")"

    emit "instance_id=${NORMALIZED_INSTANCE_ID}"
    emit "runtime_root=${RUNTIME_ROOT}"
    emit "state_dir=${STATE_DIR}"
    emit "config_path=${CONFIG_PATH}"
    emit "gateway_port=${GATEWAY_PORT}"
    emit "app_launchd_label=${APP_LABEL}"
    emit "gateway_launchd_label=${GATEWAY_LABEL}"

    if [[ "$REQUIRE_LAUNCHD_MATCH" -eq 1 ]]; then
      check_launchd_match "$GATEWAY_LABEL" "$WORKTREE_PATH" "gateway"
      check_launchd_match "$APP_LABEL" "$WORKTREE_PATH" "app"
    fi

    if [[ "$TELEGRAM_MODE" != "skip" ]]; then
      TELEGRAM_SUMMARY="$(telegram_collision_report "$NORMALIZED_INSTANCE_ID" "$GATEWAY_LABEL")"
      printf '%s\n' "$TELEGRAM_SUMMARY"

      TELEGRAM_TOKEN_COLLISIONS="$(
        printf '%s\n' "$TELEGRAM_SUMMARY" | sed -nE 's/^telegram_token_collisions=([0-9]+)$/\1/p'
      )"
      TELEGRAM_STATUS="$(
        printf '%s\n' "$TELEGRAM_SUMMARY" | sed -nE 's/^telegram_status=(.*)$/\1/p' | tail -n 1
      )"

      if [[ "$TELEGRAM_STATUS" == "not-configured" ]]; then
        if [[ "$TELEGRAM_MODE" == "fail" ]]; then
          fail "Telegram token is not configured for ${NORMALIZED_INSTANCE_ID}"
        else
          warn "Telegram token is not configured for ${NORMALIZED_INSTANCE_ID}"
        fi
      fi

      if [[ "${TELEGRAM_TOKEN_COLLISIONS:-0}" -gt 0 ]]; then
        if [[ "$TELEGRAM_MODE" == "fail" ]]; then
          fail "Telegram token collision detected for ${NORMALIZED_INSTANCE_ID}"
        else
          warn "Telegram token collision detected for ${NORMALIZED_INSTANCE_ID}"
        fi
      fi
    fi
  fi
fi

if [[ "$FAIL" -ne 0 ]]; then
  exit 1
fi
