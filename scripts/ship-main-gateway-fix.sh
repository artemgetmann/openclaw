#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
MAIN_REPO="${OPENCLAW_MAIN_REPO:-/Users/user/Programming_Projects/openclaw}"
GH_BIN="${OPENCLAW_GH_BIN:-gh}"
PR_NUMBER=""
DRY_RUN=0
SKIP_LIVE=0
LIVE_TELEGRAM_RESTART=0
CI_TIMEOUT_SECONDS="${OPENCLAW_SHIP_CI_TIMEOUT_SECONDS:-1800}"

log() {
  printf '[ship-main-gateway-fix] %s\n' "$*"
}

usage() {
  cat <<'EOF'
Usage: scripts/ship-main-gateway-fix.sh --pr <number> [--skip-live|--live-telegram-restart] [--dry-run]

Merge a main-targeted PR, fast-forward the sacred main clone, rebuild/recover
the shared gateway runtime, print closeout proof, and optionally run the live
Telegram restart smoke.
EOF
}

parse_args() {
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --pr)
        PR_NUMBER="${2:-}"
        shift 2
        ;;
      --skip-live)
        SKIP_LIVE=1
        shift
        ;;
      --live-telegram-restart)
        LIVE_TELEGRAM_RESTART=1
        shift
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        log "unknown argument: $1" >&2
        usage >&2
        exit 1
        ;;
    esac
  done

  if [[ -z "${PR_NUMBER}" ]]; then
    log "--pr is required" >&2
    usage >&2
    exit 1
  fi
  if (( SKIP_LIVE == 1 && LIVE_TELEGRAM_RESTART == 1 )); then
    log "choose either --skip-live or --live-telegram-restart, not both" >&2
    exit 1
  fi
}

require_tools() {
  local missing=()
  command -v "${GH_BIN}" >/dev/null 2>&1 || missing+=("${GH_BIN}")
  command -v git >/dev/null 2>&1 || missing+=("git")
  command -v jq >/dev/null 2>&1 || missing+=("jq")
  if (( ${#missing[@]} > 0 )); then
    log "missing required command(s): ${missing[*]}" >&2
    exit 1
  fi
}

run_or_print() {
  if (( DRY_RUN == 1 )); then
    printf '+'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

run_in_main_or_print() {
  if (( DRY_RUN == 1 )); then
    printf '+ cd %q &&' "${MAIN_REPO}"
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  (cd "${MAIN_REPO}" && "$@")
}

pr_json() {
  "${GH_BIN}" pr view "${PR_NUMBER}" --json number,state,isDraft,baseRefName,headRefName,headRefOid,mergeCommit,title,url
}

assert_pr_is_main_targeted() {
  local json="$1"
  local base=""
  local state=""
  base="$(printf '%s\n' "${json}" | jq -r '.baseRefName')"
  state="$(printf '%s\n' "${json}" | jq -r '.state')"

  if [[ "${base}" != "main" ]]; then
    log "refusing PR #${PR_NUMBER}: baseRefName=${base}, expected main" >&2
    exit 1
  fi
  if [[ "${state}" == "CLOSED" ]]; then
    log "refusing PR #${PR_NUMBER}: PR is closed, not merged" >&2
    exit 1
  fi
}

assert_pr_not_redundant() {
  local json="$1"
  local state=""
  local head_sha=""
  state="$(printf '%s\n' "${json}" | jq -r '.state')"
  head_sha="$(printf '%s\n' "${json}" | jq -r '.headRefOid')"

  if [[ "${state}" == "MERGED" || -z "${head_sha}" || "${head_sha}" == "null" ]]; then
    return 0
  fi

  git -C "${REPO_ROOT}" fetch origin main >/dev/null 2>&1 || true
  if git -C "${REPO_ROOT}" merge-base --is-ancestor "${head_sha}" origin/main 2>/dev/null; then
    log "refusing PR #${PR_NUMBER}: head ${head_sha} is already reachable from origin/main; likely superseded or redundant" >&2
    exit 1
  fi
}

assert_sacred_main_clean() {
  if [[ ! -d "${MAIN_REPO}/.git" && ! -f "${MAIN_REPO}/.git" ]]; then
    log "sacred main repo missing: ${MAIN_REPO}" >&2
    exit 1
  fi

  local branch=""
  branch="$(git -C "${MAIN_REPO}" rev-parse --abbrev-ref HEAD)"
  if [[ "${branch}" != "main" ]]; then
    log "sacred main repo must be on main before deploy (got ${branch})" >&2
    exit 1
  fi

  if [[ -n "$(git -C "${MAIN_REPO}" status --porcelain)" ]]; then
    log "sacred main repo has uncommitted changes; refusing runtime deploy" >&2
    git -C "${MAIN_REPO}" status --short >&2
    exit 1
  fi
}

mark_ready_if_needed() {
  local json="$1"
  local is_draft=""
  local state=""
  is_draft="$(printf '%s\n' "${json}" | jq -r '.isDraft')"
  state="$(printf '%s\n' "${json}" | jq -r '.state')"
  if [[ "${state}" == "OPEN" && "${is_draft}" == "true" ]]; then
    run_or_print "${GH_BIN}" pr ready "${PR_NUMBER}"
  fi
}

merge_if_needed() {
  local json="$1"
  local state=""
  local head_sha=""
  local title=""
  state="$(printf '%s\n' "${json}" | jq -r '.state')"
  head_sha="$(printf '%s\n' "${json}" | jq -r '.headRefOid')"
  title="$(printf '%s\n' "${json}" | jq -r '.title')"

  if [[ "${state}" == "MERGED" ]]; then
    log "PR #${PR_NUMBER} already merged; continuing to sacred-main deploy"
    return 0
  fi

  "${SCRIPT_DIR}/pr-required-status.sh" --pr "${PR_NUMBER}" --wait --timeout "${CI_TIMEOUT_SECONDS}"
  run_or_print "${GH_BIN}" pr merge "${PR_NUMBER}" --squash --delete-branch --match-head-commit "${head_sha}" --subject "${title} (#${PR_NUMBER})"
}

fast_forward_sacred_main() {
  assert_sacred_main_clean
  run_in_main_or_print git fetch origin main
  run_in_main_or_print git pull --ff-only origin main
}

changed_files_for_closeout() {
  if (( DRY_RUN == 1 )); then
    printf 'dry-run\n'
    return 0
  fi
  "${GH_BIN}" pr view "${PR_NUMBER}" --json files --jq '.files[].path' 2>/dev/null | paste -sd ',' - || true
}

gateway_status_summary() {
  local status_json="$1"
  printf '%s\n' "${status_json}" | jq -rc '
    {
      ok: (.ok // false),
      branch: (.runtimeFingerprint.branch // null),
      worktree: (.runtimeFingerprint.worktree // null),
      pid: (.service.runtime.pid // null),
      rpc: (.rpc.ok // ([.targets[]? | select(.connect.rpcOk == true)] | length > 0))
    }
  '
}

print_closeout() {
  local pr_url="$1"
  local commit_sha="$2"
  local changed_files="$3"
  local ci_line="$4"
  local deploy_line="$5"
  local live_line="$6"

  cat <<EOF
PR: ${pr_url}
Commit: ${commit_sha}
Changed files: ${changed_files}
Local validation: scripts/build-shared-runtime.sh; scripts/gateway-recover-main.sh
CI: ${ci_line}
Deploy: ${deploy_line}
Live proof: ${live_line}
Known gaps: Telegram restart smoke runs only with --live-telegram-restart and configured chat/session.
Rollback: revert PR #${PR_NUMBER}, fast-forward ${MAIN_REPO}, then rerun scripts/build-shared-runtime.sh and scripts/gateway-recover-main.sh.
EOF
}

main() {
  parse_args "$@"
  require_tools

  local json=""
  json="$(pr_json)"
  assert_pr_is_main_targeted "${json}"
  assert_pr_not_redundant "${json}"

  if (( DRY_RUN == 1 )); then
    log "dry-run plan for PR #${PR_NUMBER}"
  fi

  mark_ready_if_needed "${json}"
  merge_if_needed "${json}"
  fast_forward_sacred_main
  run_in_main_or_print bash scripts/build-shared-runtime.sh
  run_in_main_or_print bash scripts/gateway-recover-main.sh

  local status_proof=""
  if (( DRY_RUN == 1 )); then
    status_proof="dry-run"
  else
    status_proof="$(gateway_status_summary "$(run_in_main_or_print pnpm openclaw:local gateway status --deep --require-rpc --json)")"
  fi

  local live_line="skipped"
  if (( LIVE_TELEGRAM_RESTART == 1 )); then
    live_line="$(run_in_main_or_print bash scripts/smoke-main-gateway-restart.sh)"
  elif (( SKIP_LIVE == 1 )); then
    live_line="skipped by --skip-live"
  fi

  local refreshed_json=""
  refreshed_json="$(pr_json)"
  local pr_url=""
  local commit_sha=""
  pr_url="$(printf '%s\n' "${refreshed_json}" | jq -r '.url // empty')"
  commit_sha="$(git -C "${MAIN_REPO}" rev-parse --short=12 HEAD 2>/dev/null || printf dry-run)"

  print_closeout \
    "${pr_url:-PR #${PR_NUMBER}}" \
    "${commit_sha}" \
    "$(changed_files_for_closeout)" \
    "pr-required passed before merge" \
    "sacred-main fast-forward + build + gateway recovery; status=${status_proof}" \
    "${live_line}"
}

main "$@"
