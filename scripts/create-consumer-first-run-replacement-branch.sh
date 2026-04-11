#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BASE_REF="${BASE_REF:-origin/codex/consumer-openclaw-project}"
DEFAULT_BRANCH="codex/consumer-first-run-hardening-restacked-20260411"
DEFAULT_WORKTREE="${ROOT_DIR%/}/.worktrees/consumer-first-run-restacked-20260411"
BRANCH_NAME="${1:-$DEFAULT_BRANCH}"
WORKTREE_PATH="${2:-$DEFAULT_WORKTREE}"
INCLUDE_HARNESS="${INCLUDE_CLEAN_USER_HARNESS:-0}"

KEEP_COMMITS=(
  0c18d4f5cb
  4b3da0883a
  a53e317983
  55f2209884
  45c4cc9ee6
  3c7422b6cd
  46d4ea905f
  ccda25dd47
  f8836afaee
  fed6c8fd91
)

HARNESS_COMMIT=4eb370b742
STATUS_FILE_NAME=".consumer-first-run-restack-status.txt"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_clean_target() {
  if git show-ref --verify --quiet "refs/heads/${BRANCH_NAME}"; then
    fail "branch already exists: ${BRANCH_NAME}"
  fi
  if [[ -e "${WORKTREE_PATH}" ]]; then
    fail "worktree path already exists: ${WORKTREE_PATH}"
  fi
}

print_plan() {
  printf 'Creating replacement branch for consumer first-run fix\n'
  printf '  base_ref=%s\n' "${BASE_REF}"
  printf '  branch=%s\n' "${BRANCH_NAME}"
  printf '  worktree=%s\n' "${WORKTREE_PATH}"
  printf '  include_clean_user_harness=%s\n' "${INCLUDE_HARNESS}"
  printf '  commits:\n'
  for sha in "${KEEP_COMMITS[@]}"; do
    printf '    - %s %s\n' "$sha" "$(git log -1 --format=%s "$sha")"
  done
  if [[ "${INCLUDE_HARNESS}" == "1" ]]; then
    printf '    - %s %s\n' "${HARNESS_COMMIT}" "$(git log -1 --format=%s "${HARNESS_COMMIT}")"
  fi
}

main() {
  cd "${ROOT_DIR}"
  git fetch origin >/dev/null 2>&1 || true

  git rev-parse --verify "${BASE_REF}" >/dev/null 2>&1 || fail "missing base ref: ${BASE_REF}"
  require_clean_target
  print_plan

  mkdir -p "$(dirname "${WORKTREE_PATH}")"
  git worktree add -b "${BRANCH_NAME}" "${WORKTREE_PATH}" "${BASE_REF}"

  if ! (
    cd "${WORKTREE_PATH}"
    for sha in "${KEEP_COMMITS[@]}"; do
      git cherry-pick "${sha}"
    done
    if [[ "${INCLUDE_HARNESS}" == "1" ]]; then
      git cherry-pick "${HARNESS_COMMIT}"
    fi
  ); then
    cat > "${WORKTREE_PATH}/${STATUS_FILE_NAME}" <<EOF
status=conflict
branch=${BRANCH_NAME}
worktree=${WORKTREE_PATH}
base_ref=${BASE_REF}
current_head=$(git -C "${WORKTREE_PATH}" rev-parse --short HEAD 2>/dev/null || true)
conflicted_files=$(git -C "${WORKTREE_PATH}" diff --name-only --diff-filter=U | tr '\n' ' ')
next_step=resolve conflicts in the worktree, then run git cherry-pick --continue
EOF
    printf 'Replacement branch created, but cherry-pick hit conflicts\n' >&2
    printf '  branch=%s\n' "${BRANCH_NAME}" >&2
    printf '  worktree=%s\n' "${WORKTREE_PATH}" >&2
    printf '  status_file=%s\n' "${WORKTREE_PATH}/${STATUS_FILE_NAME}" >&2
    exit 2
  fi

  printf 'Replacement branch ready\n'
  printf '  branch=%s\n' "${BRANCH_NAME}"
  printf '  worktree=%s\n' "${WORKTREE_PATH}"
  printf '  base=%s\n' "${BASE_REF}"
}

main "$@"
