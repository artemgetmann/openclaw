#!/usr/bin/env bash
set -euo pipefail

# Trim leading/trailing whitespace for robust .env parsing.
trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

# Remove one pair of matching outer quotes if present.
strip_outer_quotes() {
  local value="$1"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    printf '%s' "${value:1:${#value}-2}"
    return
  fi
  if [[ "$value" == \'*\' && "$value" == *\' ]]; then
    printf '%s' "${value:1:${#value}-2}"
    return
  fi
  printf '%s' "$value"
}

# Parse KEY=value (with optional "export") and return the normalized value.
parse_env_assignment() {
  local key="$1"
  local line="$2"
  local parsed=""
  if [[ "$line" =~ ^(export[[:space:]]+)?${key}[[:space:]]*=[[:space:]]*(.*)$ ]]; then
    parsed="$(trim "${BASH_REMATCH[2]}")"
    parsed="$(strip_outer_quotes "$parsed")"
  fi
  printf '%s' "$parsed"
}

# Return the last occurrence of KEY from an env-style file.
read_last_env_value() {
  local file_path="$1"
  local key="$2"
  local line=""
  local trimmed=""
  local parsed=""
  local last_value=""

  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="$(trim "$line")"
    if [[ -z "$trimmed" || "$trimmed" == \#* ]]; then
      continue
    fi
    parsed="$(parse_env_assignment "$key" "$trimmed")"
    if [[ -n "$parsed" ]]; then
      last_value="$parsed"
    fi
  done < "$file_path"

  printf '%s' "$last_value"
}

# Mask token output so logs never leak full credentials.
mask_token() {
  local token="$1"
  local len=${#token}
  if (( len <= 4 )); then
    printf '****'
    return
  fi
  if (( len <= 8 )); then
    printf '%s...%s' "${token:0:1}" "${token:len-1:1}"
    return
  fi
  printf '%s...%s' "${token:0:4}" "${token:len-4:4}"
}

usage() {
  cat <<'EOF'
Usage: scripts/new-worktree.sh <feature-name> [--base <branch>] [--mode <clean|warm>] [--no-bootstrap]
EOF
}

resolve_default_base_branch() {
  local current_branch=""
  local upstream_branch=""

  current_branch="$(git branch --show-current 2>/dev/null || true)"
  upstream_branch="$(git rev-parse --abbrev-ref --symbolic-full-name @{upstream} 2>/dev/null || true)"

  # Keep the automatic default intentionally narrow: use the dedicated
  # consumer base only when the current checkout is on that branch or is a
  # feature branch that still tracks that branch. Everything else falls back
  # to main so feature branches do not silently start branching from each
  # other just because they exist.
  if [[ "$current_branch" == "codex/consumer-openclaw-project" ]] ||
    [[ "$upstream_branch" == "origin/codex/consumer-openclaw-project" ]]; then
    printf 'codex/consumer-openclaw-project'
    return
  fi

  printf 'main'
}

maybe_reexec_from_sacred_home_clone() {
  local base_branch="$1"
  local target_root=""
  local -a rerun_args=()

  target_root="$(worktree_guard_sacred_home_clone_path_for_branch "$base_branch" 2>/dev/null || true)"
  [[ -n "$target_root" ]] || return 0
  target_root="$(cd "$target_root" 2>/dev/null && pwd -P)" || {
    cat >&2 <<EOF
Error: could not resolve the sacred home clone for '${base_branch}'.

Expected clone:
  ${target_root}
EOF
    exit 1
  }

  if [[ "$REPO_ROOT" == "$target_root" ]]; then
    return 0
  fi

  if [[ "${OPENCLAW_NEW_WORKTREE_REEXECED:-0}" == "1" ]]; then
    cat >&2 <<EOF
Error: scripts/new-worktree.sh already re-execed once but is still not in the
correct sacred home clone.

Current checkout: ${REPO_ROOT}
Expected clone:   ${target_root}
Base branch:      ${base_branch}
EOF
    exit 1
  fi

  if [[ ! -d "${target_root}/.git" ]]; then
    cat >&2 <<EOF
Error: sacred home clone missing for '${base_branch}'.

Expected clone:
  ${target_root}

Create or restore that sacred home clone first, then rerun this command.
EOF
    exit 1
  fi

  # Default task spawn should branch from the correct sacred home clone even
  # when the caller launches the helper from another checkout. Otherwise the
  # task accidentally inherits the wrong clone's branch truth and metadata.
  rerun_args=("$FEATURE_NAME" "--base" "$base_branch" "--mode" "$LANE_MODE")
  if [[ "$NO_BOOTSTRAP" == "1" ]]; then
    rerun_args+=("--no-bootstrap")
  fi

  cd "$target_root"
  exec env OPENCLAW_NEW_WORKTREE_REEXECED=1 bash scripts/new-worktree.sh "${rerun_args[@]}"
}

assert_base_branch_synced_with_remote() {
  local base_branch="$1"
  local override="${OPENCLAW_NEW_WORKTREE_ALLOW_UNSYNCED_BASE:-0}"
  local local_ref="refs/heads/${base_branch}"
  local remote_ref="refs/remotes/origin/${base_branch}"
  local local_only=0
  local remote_only=0

  if [[ "$override" == "1" ]]; then
    return 0
  fi

  if ! git show-ref --verify --quiet "$local_ref"; then
    cat >&2 <<EOF
Error: local base branch '${base_branch}' does not exist.

Create or fast-forward it first so local branch truth matches origin:
  git checkout ${base_branch}
  git pull --ff-only

If you intentionally want to bypass this check, set:
  OPENCLAW_NEW_WORKTREE_ALLOW_UNSYNCED_BASE=1
EOF
    exit 1
  fi

  read -r local_only remote_only < <(git rev-list --left-right --count "${base_branch}...origin/${base_branch}")
  if [[ "$local_only" == "0" && "$remote_only" == "0" ]]; then
    return 0
  fi

  cat >&2 <<EOF
Error: base branch '${base_branch}' is not synced with origin/${base_branch}.

Ahead commits:  ${local_only}
Behind commits: ${remote_only}

Sync the base branch before creating a new worktree:
  git checkout ${base_branch}
  git pull --ff-only

If the branch is ahead locally, push/merge that work first so origin/${base_branch}
matches what you expect to branch from.

If you intentionally want to bypass this check, set:
  OPENCLAW_NEW_WORKTREE_ALLOW_UNSYNCED_BASE=1
EOF
  exit 1
}

run_ensure_with_timeout() {
  local worktree_path="$1"
  local timeout_secs="${OPENCLAW_NEW_WORKTREE_ENSURE_TIMEOUT_SECS:-45}"

  if [[ ! "$timeout_secs" =~ ^[0-9]+$ ]] || (( timeout_secs <= 0 )); then
    timeout_secs=45
  fi

  # `telegram-live-runtime.sh ensure` is allowed to wait several minutes for a
  # healthy isolated runtime. That is sensible for a live-test gate, but far
  # too slow for a worktree bootstrap helper whose real job is branch/setup
  # creation. Bound it so the worktree is still usable even if runtime health
  # checks drag or hang.
  if command -v python3 >/dev/null 2>&1; then
    if python3 - "$worktree_path" "$timeout_secs" <<'PY'
import subprocess
import sys

worktree_path = sys.argv[1]
timeout_secs = int(sys.argv[2])

try:
    completed = subprocess.run(
        ["bash", "scripts/telegram-live-runtime.sh", "ensure"],
        cwd=worktree_path,
        timeout=timeout_secs,
        check=False,
    )
    raise SystemExit(completed.returncode)
except subprocess.TimeoutExpired:
    print(
        f"Warning: telegram-live-runtime.sh ensure exceeded {timeout_secs}s; continuing.",
        file=sys.stderr,
    )
    raise SystemExit(124)
PY
    then
      :
    else
      ensure_status=$?
      if [[ "$ensure_status" != "124" ]]; then
        echo "Warning: telegram-live-runtime.sh ensure exited with status ${ensure_status}; continuing." >&2
      fi
    fi
  else
    (cd "$worktree_path" && bash scripts/telegram-live-runtime.sh ensure) || true
  fi
}

if [[ $# -lt 1 ]]; then
  usage >&2
  exit 1
fi

FEATURE_NAME=""
BASE_BRANCH=""
BASE_SOURCE="auto"
LANE_MODE="clean"
NO_BOOTSTRAP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)
      if [[ $# -lt 2 ]]; then
        echo "Error: --base requires a value." >&2
        exit 1
      fi
      BASE_BRANCH="$2"
      BASE_SOURCE="flag"
      shift 2
      ;;
    --mode)
      if [[ $# -lt 2 ]]; then
        echo "Error: --mode requires a value." >&2
        exit 1
      fi
      LANE_MODE="$2"
      shift 2
      ;;
    --no-bootstrap)
      NO_BOOTSTRAP=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      if [[ -z "$FEATURE_NAME" ]]; then
        FEATURE_NAME="$1"
        shift
      else
        echo "Error: unexpected argument: $1" >&2
        usage >&2
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$FEATURE_NAME" ]]; then
  echo "Error: feature name is required." >&2
  usage >&2
  exit 1
fi

if [[ "$LANE_MODE" != "clean" && "$LANE_MODE" != "warm" ]]; then
  echo "Error: --mode must be one of: clean, warm." >&2
  exit 1
fi

if [[ ! "$FEATURE_NAME" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "Error: feature name must match [a-zA-Z0-9_-]+." >&2
  exit 1
fi

if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  echo "Error: run this script from inside a git worktree." >&2
  exit 1
fi
REPO_ROOT="$(cd "$REPO_ROOT" && pwd -P)"
source "${REPO_ROOT}/scripts/lib/worktree-guards.sh"
source "${REPO_ROOT}/scripts/lib/validated-node.sh"

if ! git fetch origin; then
  echo "Warning: git fetch origin failed; continuing with local refs." >&2
fi

if [[ -z "$BASE_BRANCH" ]]; then
  BASE_BRANCH="$(resolve_default_base_branch)"
fi

maybe_reexec_from_sacred_home_clone "$BASE_BRANCH"

if ! worktree_guard_is_sacred_home_clone "$REPO_ROOT"; then
  cat >&2 <<EOF
Error: scripts/new-worktree.sh must run from a sacred home clone.

Checkout: ${REPO_ROOT}
Base:     ${BASE_BRANCH}

Create temp worktrees from the correct pull-only home clone so branch truth
comes from the right base branch:
  /Users/user/Programming_Projects/openclaw            -> main
  /Users/user/Programming_Projects/openclaw-consumer   -> codex/consumer-openclaw-project
EOF
  exit 1
fi

worktree_guard_require_sacred_home_clone_base_branch \
  "$REPO_ROOT" \
  "scripts/new-worktree.sh"

# Resolve the repo-validated runtime only after we know we are in the correct
# sacred home clone. That keeps Node/pnpm/tooling resolution tied to the branch
# truth we are actually going to branch from.
openclaw_use_validated_node "$REPO_ROOT" >/dev/null
VALIDATED_NODE_BIN="$OPENCLAW_NODE_BIN"

worktree_guard_reject_sacred_home_edits \
  "$REPO_ROOT" \
  worktree \
  --context "scripts/new-worktree.sh"

BOOTSTRAP_SCRIPT="${REPO_ROOT}/scripts/bootstrap-worktree-telegram.sh"
BASELINE_BOOTSTRAP_SCRIPT="${REPO_ROOT}/scripts/bootstrap-worktree-tester-baseline.sh"
RUNTIME_BOOTSTRAP_SCRIPT="${REPO_ROOT}/scripts/bootstrap-worktree-runtime.sh"
READY_CHECK_SCRIPT="${REPO_ROOT}/scripts/worktree-ready-check.sh"
DOCTOR_SCRIPT="${REPO_ROOT}/scripts/worktree-doctor.sh"

# Keep helper-generated worktrees under the repo-owned durable lane area so
# follow-up sessions and local tooling land in one predictable tree.
mkdir -p "${REPO_ROOT}/.worktrees"
WORKTREE_PATH="${REPO_ROOT}/.worktrees/${FEATURE_NAME}"
BRANCH_NAME="codex/${FEATURE_NAME}"

if [[ -e "$WORKTREE_PATH" ]]; then
  echo "Error: worktree path already exists: $WORKTREE_PATH" >&2
  exit 1
fi

if git show-ref --verify --quiet "refs/heads/${BRANCH_NAME}"; then
  echo "Error: branch already exists locally: ${BRANCH_NAME}" >&2
  exit 1
fi

if ! git show-ref --verify --quiet "refs/remotes/origin/${BASE_BRANCH}"; then
  echo "Error: origin/${BASE_BRANCH} does not exist locally. Fetch it or choose a different --base." >&2
  exit 1
fi

# Creating a fresh lane from stale local branch truth is how we keep reimporting
# old scripts, old docs, and old runtime rules. Require the named base branch to
# be exactly aligned with its origin tracking branch before creating the worktree.
assert_base_branch_synced_with_remote "$BASE_BRANCH"

# Mirror the Telegram live runtime port derivation pattern: normalize the
# absolute worktree path, hash it, then take a stable modulo into a reserved
# dev-only port window that does not overlap the default gateway port.
TARGET_REF="origin/${BASE_BRANCH}"
git worktree add "$WORKTREE_PATH" -b "$BRANCH_NAME" "$TARGET_REF"

TELEGRAM_BOOTSTRAP_STATUS="skipped"
if [[ "$LANE_MODE" == "clean" ]]; then
  (cd "$WORKTREE_PATH" && bash "$BOOTSTRAP_SCRIPT" --optional)
  TELEGRAM_BOOTSTRAP_STATUS="optional"
fi

DEV_PORT="$(WORKTREE_PATH="$WORKTREE_PATH" "$VALIDATED_NODE_BIN" --input-type=module - <<'NODE'
import crypto from "node:crypto";
import path from "node:path";

const worktreePath = path.resolve(process.env.WORKTREE_PATH ?? "");
const hash = crypto.createHash("sha256").update(worktreePath).digest("hex");
const hashInt = Number.parseInt(hash.slice(0, 8), 16);
const port = 18800 + (Number.isFinite(hashInt) ? hashInt % 100 : 0);
process.stdout.write(String(port));
NODE
)"

BASELINE_STATE_DIR=""
BASELINE_CONFIG_PATH=""
BASELINE_META_PATH=""
BASELINE_STRIPPED_NAMED_TELEGRAM_ACCOUNTS="none"
BASELINE_BOOTSTRAP_STATUS="disabled"
if [[ -f "$BASELINE_BOOTSTRAP_SCRIPT" ]]; then
  if ! BASELINE_BOOTSTRAP_OUTPUT="$(bash "$BASELINE_BOOTSTRAP_SCRIPT" --root "$WORKTREE_PATH")"; then
    echo "Error: tester baseline bootstrap failed for ${WORKTREE_PATH}." >&2
    exit 1
  fi
  BASELINE_BOOTSTRAP_STATUS="ok"
  BASELINE_STATE_DIR="$(printf '%s\n' "$BASELINE_BOOTSTRAP_OUTPUT" | sed -n 's/^baseline_state_dir=//p' | tail -n 1)"
  BASELINE_CONFIG_PATH="$(printf '%s\n' "$BASELINE_BOOTSTRAP_OUTPUT" | sed -n 's/^baseline_config_path=//p' | tail -n 1)"
  BASELINE_META_PATH="$(printf '%s\n' "$BASELINE_BOOTSTRAP_OUTPUT" | sed -n 's/^baseline_meta_path=//p' | tail -n 1)"
  BASELINE_STRIPPED_NAMED_TELEGRAM_ACCOUNTS="$(printf '%s\n' "$BASELINE_BOOTSTRAP_OUTPUT" | sed -n 's/^baseline_stripped_named_telegram_accounts=//p' | tail -n 1)"
else
  echo "warning: tester baseline bootstrap helper missing; falling back to legacy lane state path" >&2
fi

if [[ -z "$BASELINE_STATE_DIR" ]]; then
  BASELINE_STATE_DIR="/tmp/openclaw-dev-${FEATURE_NAME}"
fi

cat > "${WORKTREE_PATH}/.dev-launch.env" <<EOF
OPENCLAW_STATE_DIR=${BASELINE_STATE_DIR}
OPENCLAW_CONFIG_PATH=${BASELINE_CONFIG_PATH}
OPENCLAW_GATEWAY_PORT=${DEV_PORT}
EOF

if [[ -x "$DOCTOR_SCRIPT" ]]; then
  bash "$DOCTOR_SCRIPT" \
    --root "$WORKTREE_PATH" \
    --mode new-worktree \
    --telegram-mode warn \
    --require-dev-launch-env
fi

BOOTSTRAP_RUNTIME_STATUS="disabled"
READY_MODE="$LANE_MODE"
if [[ "$NO_BOOTSTRAP" != "1" ]] && [[ -f "$RUNTIME_BOOTSTRAP_SCRIPT" ]]; then
  # Fresh git worktrees bootstrap their own dependency tree in-place. We do
  # not symlink node_modules from the source checkout because that lets one
  # lane resolve packages out of another lane's filesystem state.
  RUNTIME_BOOTSTRAP_ARGS=(--root "$WORKTREE_PATH" --quiet)
  if [[ "$LANE_MODE" == "warm" ]]; then
    # Warm lanes keep the dependency install, but skip the slower build step so
    # the lane is usable faster while still remaining isolated.
    RUNTIME_BOOTSTRAP_ARGS+=(--skip-build)
  fi
  if bash "$RUNTIME_BOOTSTRAP_SCRIPT" "${RUNTIME_BOOTSTRAP_ARGS[@]}"; then
    if [[ "$LANE_MODE" == "warm" ]]; then
      BOOTSTRAP_RUNTIME_STATUS="dependencies-only"
    else
      BOOTSTRAP_RUNTIME_STATUS="ok"
    fi
  else
    BOOTSTRAP_RUNTIME_STATUS="failed"
    cat >&2 <<EOF
Error: worktree runtime bootstrap failed the readiness gate.

Worktree: ${WORKTREE_PATH}
Branch:   ${BRANCH_NAME}

This lane was created, but it is not safe to hand off to an agent because
local dependencies/tools were not proven ready inside the worktree.
EOF
    exit 1
  fi
fi

if [[ "$NO_BOOTSTRAP" == "1" ]]; then
  BOOTSTRAP_RUNTIME_STATUS="disabled"
else
  if [[ ! -x "$READY_CHECK_SCRIPT" && ! -f "$READY_CHECK_SCRIPT" ]]; then
    echo "Error: missing readiness check helper: $READY_CHECK_SCRIPT" >&2
    exit 1
  fi
  if ! READY_CHECK_OUTPUT="$(bash "$READY_CHECK_SCRIPT" --root "$WORKTREE_PATH" --mode "$READY_MODE")"; then
    cat >&2 <<EOF
Error: lane readiness proof failed after bootstrap.

Worktree: ${WORKTREE_PATH}
Branch:   ${BRANCH_NAME}

Expected proof command:
  pnpm exec vitest --version
EOF
    exit 1
  fi
fi

if [[ "$LANE_MODE" == "clean" ]] && [[ -f "$WORKTREE_PATH/.env.local" ]]; then
  run_ensure_with_timeout "$WORKTREE_PATH"
elif [[ "$LANE_MODE" == "warm" ]]; then
  echo "info: warm mode skips Telegram lane claim/ensure and the build step; dependencies are installed in-place" >&2
else
  echo "warning: no Telegram token claim was assigned; skipping telegram-live-runtime ensure" >&2
fi

BOT_FINGERPRINT="none"
if [[ -f "${WORKTREE_PATH}/.env.local" ]]; then
  token_value="$(read_last_env_value "${WORKTREE_PATH}/.env.local" "TELEGRAM_BOT_TOKEN")"
  if [[ -n "$token_value" ]]; then
    BOT_FINGERPRINT="$(mask_token "$token_value")"
  fi
fi

echo "worktree=${WORKTREE_PATH}"
echo "branch=${BRANCH_NAME}"
echo "base_branch=${BASE_BRANCH}"
echo "base_source=${BASE_SOURCE}"
echo "lane_mode=${LANE_MODE}"
echo "bot_fingerprint=${BOT_FINGERPRINT}"
echo "dev_port=${DEV_PORT}"
echo "baseline_bootstrap=${BASELINE_BOOTSTRAP_STATUS}"
echo "baseline_state_dir=${BASELINE_STATE_DIR}"
echo "baseline_config_path=${BASELINE_CONFIG_PATH}"
echo "baseline_meta_path=${BASELINE_META_PATH}"
echo "baseline_stripped_named_telegram_accounts=${BASELINE_STRIPPED_NAMED_TELEGRAM_ACCOUNTS}"
echo "telegram_bootstrap=${TELEGRAM_BOOTSTRAP_STATUS}"
echo "bootstrap_runtime=${BOOTSTRAP_RUNTIME_STATUS}"
if [[ "$NO_BOOTSTRAP" != "1" ]]; then
  printf '%s\n' "$READY_CHECK_OUTPUT"
fi
if [[ "$LANE_MODE" == "warm" ]]; then
  echo "prewarm_hint=cd ${WORKTREE_PATH} && bash scripts/prewarm-worktree.sh --root ${WORKTREE_PATH} --macos"
fi
