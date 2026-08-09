#!/usr/bin/env bash
set -euo pipefail

# Adopt a Codex-created checkout into the same lane contract as scripts/new-worktree.sh.
# The point is not to create a second workflow; this script only repairs the entrypoint
# difference and then delegates dependency, baseline, doctor, and readiness work to the
# existing OpenClaw helpers.

usage() {
  cat <<'EOF'
Usage: scripts/adopt-codex-worktree.sh <feature-name> [options]

Options:
  --root <path>              Worktree to adopt. Defaults to the current repo root.
  --base <branch>            Base branch to validate against. Defaults to main.
  --mode <clean|warm>        Bootstrap mode. Defaults to warm.
  --allow-stale-head         Allow detached HEAD that is not origin/<base>.
  --allow-dirty              Allow existing local changes while adopting.
  --no-home-refresh          Do not fast-forward the sacred home clone first.
  --thread-id <id>           Optional native Codex thread receipt (secret-free).
  --credential-mode <mode>   copy (default) or none for source-only workers.
  --capacity-wait-seconds <n> Wait lease-free for guarded bootstrap (max 86400).
EOF
}

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

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

run_ensure_with_timeout() {
  local worktree_path="$1"
  local timeout_secs="${OPENCLAW_ADOPT_WORKTREE_ENSURE_TIMEOUT_SECS:-45}"

  if [[ ! "$timeout_secs" =~ ^[0-9]+$ ]] || (( timeout_secs <= 0 )); then
    timeout_secs=45
  fi

  # Match scripts/new-worktree.sh: Telegram runtime ensure is useful for clean
  # live-test lanes, but adoption should not hang indefinitely on runtime health.
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

FEATURE_NAME=""
ROOT=""
BASE_BRANCH="main"
LANE_MODE="warm"
ALLOW_STALE_HEAD=0
ALLOW_DIRTY=0
REFRESH_HOME=1
THREAD_ID="${CODEX_THREAD_ID:-unavailable}"
CREDENTIAL_MODE="copy"
CAPACITY_WAIT_SECONDS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      [[ $# -ge 2 ]] || fail "--root requires a value."
      ROOT="$2"
      shift 2
      ;;
    --base)
      [[ $# -ge 2 ]] || fail "--base requires a value."
      BASE_BRANCH="$2"
      shift 2
      ;;
    --mode)
      [[ $# -ge 2 ]] || fail "--mode requires a value."
      LANE_MODE="$2"
      shift 2
      ;;
    --allow-stale-head)
      ALLOW_STALE_HEAD=1
      shift
      ;;
    --allow-dirty)
      ALLOW_DIRTY=1
      shift
      ;;
    --no-home-refresh)
      REFRESH_HOME=0
      shift
      ;;
    --thread-id)
      [[ $# -ge 2 ]] || fail "--thread-id requires a value."
      THREAD_ID="$2"
      shift 2
      ;;
    --credential-mode)
      [[ $# -ge 2 ]] || fail "--credential-mode requires a value."
      CREDENTIAL_MODE="$2"
      shift 2
      ;;
    --capacity-wait-seconds)
      [[ $# -ge 2 ]] || fail "--capacity-wait-seconds requires a value."
      CAPACITY_WAIT_SECONDS="$2"
      shift 2
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
        fail "unexpected argument: $1"
      fi
      ;;
  esac
done

[[ -n "$FEATURE_NAME" ]] || {
  usage >&2
  exit 1
}

[[ "$FEATURE_NAME" =~ ^[a-zA-Z0-9_-]+$ ]] || fail "feature name must match [a-zA-Z0-9_-]+."
[[ "$THREAD_ID" =~ ^[a-zA-Z0-9:_-]+$ ]] || fail "thread id must match [a-zA-Z0-9:_-]+."
[[ "$LANE_MODE" == "clean" || "$LANE_MODE" == "warm" ]] || fail "--mode must be one of: clean, warm."
[[ "$CREDENTIAL_MODE" == "copy" || "$CREDENTIAL_MODE" == "none" ]] ||
  fail "--credential-mode must be one of: copy, none."
if [[ "$CREDENTIAL_MODE" == "none" && "$LANE_MODE" != "warm" ]]; then
  fail "--credential-mode none is valid only with --mode warm."
fi
[[ "$CAPACITY_WAIT_SECONDS" =~ ^(0|[1-9][0-9]*)$ ]] ||
  fail "--capacity-wait-seconds must be an integer from 0 to 86400."
(( CAPACITY_WAIT_SECONDS <= 86400 )) ||
  fail "--capacity-wait-seconds must be an integer from 0 to 86400."

if [[ -z "$ROOT" ]]; then
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "run from inside a git worktree or pass --root."
else
  ROOT="$(cd -- "$ROOT" && pwd -P)" || fail "could not resolve --root."
fi
ROOT="$(cd -- "$ROOT" && pwd -P)"

[[ -f "$ROOT/package.json" ]] || fail "not a repo root: $ROOT"

source "$ROOT/scripts/lib/worktree-guards.sh"
source "$ROOT/scripts/lib/validated-node.sh"

BRANCH_NAME="codex/${FEATURE_NAME}"
CURRENT_BRANCH="$(git -C "$ROOT" branch --show-current 2>/dev/null || true)"
HEAD_SHA="$(git -C "$ROOT" rev-parse HEAD)"
GIT_COMMON_DIR="$(git -C "$ROOT" rev-parse --git-common-dir)"
GIT_COMMON_DIR="$(cd "$ROOT" && cd "$GIT_COMMON_DIR" && pwd -P)"

HOME_CLONE="$(worktree_guard_sacred_home_clone_path_for_branch "$BASE_BRANCH" 2>/dev/null || true)"
[[ -n "$HOME_CLONE" ]] || fail "unsupported base branch for adoption: $BASE_BRANCH"
HOME_CLONE="$(cd "$HOME_CLONE" && pwd -P)" || fail "could not resolve sacred home clone for $BASE_BRANCH."
HOME_GIT_DIR="$(cd "$HOME_CLONE/.git" && pwd -P)"

# Codex-created chat checkouts are linked worktrees. Refuse plain clones and the
# sacred home clone so this helper cannot accidentally mutate the runtime anchor.
worktree_guard_is_linked_checkout "$ROOT" || fail "checkout is not a linked git worktree: $ROOT"
if worktree_guard_is_sacred_home_clone "$ROOT"; then
  fail "refusing to adopt sacred home clone: $ROOT"
fi

if [[ "$GIT_COMMON_DIR" != "$HOME_GIT_DIR" ]]; then
  cat >&2 <<EOF
Error: worktree common git dir does not belong to the sacred home clone.

Worktree common dir: ${GIT_COMMON_DIR}
Expected common dir: ${HOME_GIT_DIR}
EOF
  exit 1
fi

# Git owns branch attachment across every linked checkout in the repository.
# Resolve that ownership before fetch, branch mutation, Telegram-local copying,
# baseline creation, or dependency setup. The native Codex creator is outside
# this repository, so this is the earliest enforceable contract boundary.
BRANCH_OWNER_PATHS=()
while IFS= read -r owner_path; do
  [[ -n "$owner_path" ]] || continue
  BRANCH_OWNER_PATHS+=("$owner_path")
done < <(
  git -C "$ROOT" worktree list --porcelain | awk -v wanted="refs/heads/${BRANCH_NAME}" '
    /^worktree / { path = substr($0, 10) }
    /^branch / && substr($0, 8) == wanted { print path }
  '
)

if [[ "${#BRANCH_OWNER_PATHS[@]}" -gt 0 ]]; then
  ROOT_OWNS_BRANCH=0
  for owner_path in "${BRANCH_OWNER_PATHS[@]}"; do
    if [[ "$owner_path" == "$ROOT" ]]; then
      ROOT_OWNS_BRANCH=1
    fi
  done
  if [[ "$ROOT_OWNS_BRANCH" != "1" ]]; then
    cat >&2 <<EOF
Error: intended lane branch is already attached to another worktree.

Requested worktree: ${ROOT}
Requested branch:   ${BRANCH_NAME}
Existing owner(s):
$(printf '  %s\n' "${BRANCH_OWNER_PATHS[@]}")

No branch was created, switched, or stolen. Reconcile the native Codex task
owner before adoption; do not create a replacement lane after this failure.
EOF
    exit 1
  fi
fi

if [[ "$REFRESH_HOME" == "1" ]]; then
  HOME_BRANCH="$(git -C "$HOME_CLONE" branch --show-current 2>/dev/null || true)"
  [[ "$HOME_BRANCH" == "$BASE_BRANCH" ]] || fail "sacred home clone is on ${HOME_BRANCH:-<detached>}, expected $BASE_BRANCH."
  [[ -z "$(git -C "$HOME_CLONE" status --short)" ]] || fail "sacred home clone is dirty: $HOME_CLONE"

  git -C "$HOME_CLONE" fetch origin
  read -r HOME_AHEAD HOME_BEHIND < <(git -C "$HOME_CLONE" rev-list --left-right --count "${BASE_BRANCH}...origin/${BASE_BRANCH}")
  if [[ "$HOME_AHEAD" != "0" ]]; then
    fail "sacred home clone is ahead of origin/${BASE_BRANCH}; resolve that before adoption."
  fi
  if [[ "$HOME_BEHIND" != "0" ]]; then
    git -C "$HOME_CLONE" pull --ff-only origin "$BASE_BRANCH"
  fi
else
  git -C "$ROOT" fetch origin
fi

[[ -z "$(git -C "$ROOT" status --porcelain)" || "$ALLOW_DIRTY" == "1" ]] || {
  cat >&2 <<EOF
Error: worktree has local changes.

Use --allow-dirty only when you intentionally want to preserve existing edits
while attaching the proper branch and bootstrapping this lane.
EOF
  exit 1
}

if [[ -z "$CURRENT_BRANCH" ]]; then
  ORIGIN_BASE_SHA="$(git -C "$ROOT" rev-parse "origin/${BASE_BRANCH}")"
  if [[ "$HEAD_SHA" != "$ORIGIN_BASE_SHA" && "$ALLOW_STALE_HEAD" != "1" ]]; then
    cat >&2 <<EOF
Error: detached HEAD is not origin/${BASE_BRANCH}.

head=${HEAD_SHA}
origin_${BASE_BRANCH}=${ORIGIN_BASE_SHA}

Rerun with --allow-stale-head only if this Codex-created snapshot should be
preserved instead of respawned from current origin/${BASE_BRANCH}.
EOF
    exit 1
  fi
  if git -C "$ROOT" show-ref --verify --quiet "refs/heads/${BRANCH_NAME}"; then
    EXISTING_BRANCH_SHA="$(git -C "$ROOT" rev-parse "refs/heads/${BRANCH_NAME}")"
    if [[ "$EXISTING_BRANCH_SHA" != "$HEAD_SHA" ]]; then
      cat >&2 <<EOF
Error: unattached lane branch does not match this detached checkout.

Requested worktree: ${ROOT}
Requested branch:   ${BRANCH_NAME}
Detached head:      ${HEAD_SHA}
Existing branch:    ${EXISTING_BRANCH_SHA}

No branch was switched or reset. Reconcile the intended source snapshot first.
EOF
      exit 1
    fi
    git -C "$ROOT" switch "$BRANCH_NAME"
  else
    git -C "$ROOT" switch -c "$BRANCH_NAME"
  fi
elif [[ "$CURRENT_BRANCH" != "$BRANCH_NAME" ]]; then
  fail "checkout is already on branch ${CURRENT_BRANCH}; expected detached HEAD or ${BRANCH_NAME}."
fi

printf 'adoption_owner_receipt=thread:%s worktree:%s branch:%s\n' \
  "$THREAD_ID" "$ROOT" "$BRANCH_NAME"

# Warm and clean lanes both get isolated dev launch state. This mirrors
# scripts/new-worktree.sh so feature runtimes do not inherit the shared main
# gateway state by accident.
openclaw_use_validated_node "$ROOT" >/dev/null
VALIDATED_NODE_BIN="$OPENCLAW_NODE_BIN"
DEV_PORT="$(WORKTREE_PATH="$ROOT" "$VALIDATED_NODE_BIN" --input-type=module - <<'NODE'
import crypto from "node:crypto";
import path from "node:path";

const worktreePath = path.resolve(process.env.WORKTREE_PATH ?? "");
const hash = crypto.createHash("sha256").update(worktreePath).digest("hex");
const hashInt = Number.parseInt(hash.slice(0, 8), 16);
const port = 18800 + (Number.isFinite(hashInt) ? hashInt % 100 : 0);
process.stdout.write(String(port));
NODE
)"

if [[ "$CREDENTIAL_MODE" == "none" ]]; then
  # Source-only reviewers and testers need repository tools, not Telegram or
  # model credentials. Preserve the canonical adoption/ownership path while
  # skipping every credential-copying bootstrap before dependency readiness.
  TELEGRAM_BOOTSTRAP_STATUS="skipped-no-credentials"
elif [[ "$LANE_MODE" == "clean" ]]; then
  (cd "$ROOT" && bash scripts/bootstrap-worktree-telegram.sh --optional)
  TELEGRAM_BOOTSTRAP_STATUS="optional"
else
  (cd "$ROOT" && bash scripts/bootstrap-worktree-telegram.sh --copy-only)
  TELEGRAM_BOOTSTRAP_STATUS="copy-only"
fi

if [[ "$CREDENTIAL_MODE" == "none" ]]; then
  # The baseline helper also copies sanitized config and auth snapshots by
  # default. Point it at a deliberately absent lane-local source so it still
  # creates the isolated empty config required by .dev-launch.env without
  # reading any user or runtime credential state.
  NO_CREDENTIAL_SOURCE_ROOT="$ROOT/.local/no-credential-baseline-source"
  BASELINE_OUTPUT="$(
    OPENCLAW_WORKTREE_BASELINE_SOURCE_CONFIG_PATH="$NO_CREDENTIAL_SOURCE_ROOT/openclaw.json" \
      OPENCLAW_WORKTREE_BASELINE_SOURCE_STATE_DIR="$NO_CREDENTIAL_SOURCE_ROOT" \
      bash "$ROOT/scripts/bootstrap-worktree-tester-baseline.sh" --root "$ROOT"
  )"
else
  BASELINE_OUTPUT="$(bash "$ROOT/scripts/bootstrap-worktree-tester-baseline.sh" --root "$ROOT")"
fi
BASELINE_STATE_DIR="$(printf '%s\n' "$BASELINE_OUTPUT" | sed -n 's/^baseline_state_dir=//p' | tail -n 1)"
BASELINE_CONFIG_PATH="$(printf '%s\n' "$BASELINE_OUTPUT" | sed -n 's/^baseline_config_path=//p' | tail -n 1)"
BASELINE_META_PATH="$(printf '%s\n' "$BASELINE_OUTPUT" | sed -n 's/^baseline_meta_path=//p' | tail -n 1)"
BASELINE_STRIPPED_NAMED_TELEGRAM_ACCOUNTS="$(printf '%s\n' "$BASELINE_OUTPUT" | sed -n 's/^baseline_stripped_named_telegram_accounts=//p' | tail -n 1)"

[[ -n "$BASELINE_STATE_DIR" ]] || BASELINE_STATE_DIR="/tmp/openclaw-dev-${FEATURE_NAME}"

cat > "$ROOT/.dev-launch.env" <<EOF
OPENCLAW_STATE_DIR=${BASELINE_STATE_DIR}
OPENCLAW_CONFIG_PATH=${BASELINE_CONFIG_PATH}
OPENCLAW_GATEWAY_PORT=${DEV_PORT}
EOF

RUNTIME_ARGS=(--root "$ROOT" --quiet)
if [[ "$LANE_MODE" == "warm" ]]; then
  RUNTIME_ARGS+=(--skip-build)
fi
if (( CAPACITY_WAIT_SECONDS > 0 )); then
  # Fresh tester tasks keep their exact thread/contract identity while the
  # canonical wrapper waits without a lease. The guarded bootstrap executes
  # once after admission; owner races never become replacement tester tasks.
  bash "$ROOT/scripts/with-heavy-local-slot.sh" \
    --label "adopt-worktree-runtime:${FEATURE_NAME}" \
    --wait-seconds "$CAPACITY_WAIT_SECONDS" \
    -- \
    bash "$ROOT/scripts/bootstrap-worktree-runtime.sh" "${RUNTIME_ARGS[@]}"
else
  bash "$ROOT/scripts/bootstrap-worktree-runtime.sh" "${RUNTIME_ARGS[@]}"
fi

bash "$ROOT/scripts/worktree-doctor.sh" \
  --root "$ROOT" \
  --mode new-worktree \
  --telegram-mode skip \
  --require-dev-launch-env

READY_OUTPUT="$(bash "$ROOT/scripts/worktree-ready-check.sh" --root "$ROOT" --mode "$LANE_MODE")"

if [[ "$LANE_MODE" == "clean" ]] && [[ -f "$ROOT/.env.local" ]]; then
  run_ensure_with_timeout "$ROOT"
elif [[ "$CREDENTIAL_MODE" == "none" ]]; then
  echo "info: credential-free warm mode skips Telegram and auth copying; dependencies are installed in-place" >&2
elif [[ "$LANE_MODE" == "warm" ]]; then
  echo "info: warm mode copies canonical Telegram userbot files but skips Telegram lane claim/ensure and the build step; dependencies are installed in-place" >&2
else
  echo "warning: no Telegram token claim was assigned; skipping telegram-live-runtime ensure" >&2
fi

BOT_FINGERPRINT="none"
if [[ "$CREDENTIAL_MODE" == "copy" && -f "$ROOT/.env.local" ]]; then
  token_value="$(read_last_env_value "$ROOT/.env.local" "TELEGRAM_BOT_TOKEN")"
  if [[ -n "$token_value" ]]; then
    BOT_FINGERPRINT="$(mask_token "$token_value")"
  fi
fi

echo "worktree=${ROOT}"
echo "branch=${BRANCH_NAME}"
echo "base_branch=${BASE_BRANCH}"
echo "lane_mode=${LANE_MODE}"
echo "credential_mode=${CREDENTIAL_MODE}"
echo "bot_fingerprint=${BOT_FINGERPRINT}"
echo "dev_port=${DEV_PORT}"
echo "telegram_bootstrap=${TELEGRAM_BOOTSTRAP_STATUS}"
echo "baseline_state_dir=${BASELINE_STATE_DIR}"
echo "baseline_config_path=${BASELINE_CONFIG_PATH}"
echo "baseline_meta_path=${BASELINE_META_PATH}"
echo "baseline_stripped_named_telegram_accounts=${BASELINE_STRIPPED_NAMED_TELEGRAM_ACCOUNTS:-none}"
printf '%s\n' "$READY_OUTPUT"
if [[ "$LANE_MODE" == "warm" ]]; then
  echo "prewarm_hint=cd ${ROOT} && bash scripts/prewarm-worktree.sh --root ${ROOT} --macos"
fi
