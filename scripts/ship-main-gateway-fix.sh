#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
MAIN_REPO_RAW="${OPENCLAW_MAIN_REPO:-/Users/user/Programming_Projects/openclaw}"
if [[ -d "${MAIN_REPO_RAW}" ]]; then
  # Normalize early so a relative OPENCLAW_MAIN_REPO cannot re-exec the same
  # helper forever after the process switches from a worktree path to main.
  MAIN_REPO="$(cd -- "${MAIN_REPO_RAW}" && pwd -P)"
else
  MAIN_REPO="${MAIN_REPO_RAW}"
fi
GH_BIN="${OPENCLAW_GH_BIN:-gh}"
PR_NUMBER=""
DRY_RUN=0
SKIP_LIVE=0
LIVE_TELEGRAM_RESTART=0
CI_TIMEOUT_SECONDS="${OPENCLAW_SHIP_CI_TIMEOUT_SECONDS:-1800}"
RUNTIME_SCOPE="openclaw-shared"

log() {
  printf '[ship-main-gateway-fix] %s\n' "$*"
}

print_sacred_main_command() {
  printf 'cd %q && bash scripts/ship-main-gateway-fix.sh' "${MAIN_REPO}"
  printf ' %q' "$@"
  printf '\n'
}

maybe_reexec_from_sacred_main() {
  local current_script="${SCRIPT_DIR}/$(basename -- "${BASH_SOURCE[0]}")"
  local canonical_script="${MAIN_REPO}/scripts/$(basename -- "${BASH_SOURCE[0]}")"

  if [[ "${OPENCLAW_SHIP_MAIN_GATEWAY_FIX_NO_REEXEC:-0}" == "1" ]]; then
    return 0
  fi
  if [[ "${current_script}" == "${canonical_script}" ]]; then
    return 0
  fi
  if [[ ! -x "${canonical_script}" ]]; then
    log "sacred main helper is not executable; using current helper: ${current_script}" >&2
    log "safe path expected after repair: $(print_sacred_main_command "$@")" >&2
    return 0
  fi

  # Linked worktrees often carry byte-for-byte copies of this helper. Route those
  # invocations to the already-checked-out sacred main clone so merge,
  # fast-forward, and runtime proof cannot try to recreate/check out main inside
  # another worktree.
  if cmp -s "${current_script}" "${canonical_script}"; then
    log "delegating to sacred main helper: $(print_sacred_main_command "$@")" >&2
    exec bash "${canonical_script}" "$@"
  fi

  # During active helper development the worktree copy intentionally differs.
  # Keep it in control, but print the post-merge safe path so operators do not
  # cargo-cult the feature-worktree invocation for live shipping.
  log "using worktree-local helper because it differs from sacred main: ${current_script}" >&2
  log "safe path after this helper lands: $(print_sacred_main_command "$@")" >&2
}

usage() {
  cat <<'EOF'
Usage: scripts/ship-main-gateway-fix.sh --pr <number> [--runtime-scope openclaw-shared|jarvis] [--skip-live|--live-telegram-restart] [--dry-run]

Merge a main-targeted PR, fast-forward the sacred main clone, rebuild/recover
the requested runtime scope, and print closeout proof.

Scopes:
  openclaw-shared  Rebuild/recover ai.openclaw.gateway from sacred main.
  jarvis           Read-only proof of ai.jarvis.gateway. This never deploys,
                   restarts, or treats the shared gateway as Jarvis proof.
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
      --runtime-scope)
        RUNTIME_SCOPE="${2:-}"
        shift 2
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
  case "${RUNTIME_SCOPE}" in
    openclaw-shared | jarvis)
      ;;
    *)
      log "invalid --runtime-scope ${RUNTIME_SCOPE}; expected openclaw-shared or jarvis" >&2
      exit 1
      ;;
  esac
  if [[ "${RUNTIME_SCOPE}" == "jarvis" && "${LIVE_TELEGRAM_RESTART}" == "1" ]]; then
    log "--live-telegram-restart targets the OpenClaw shared gateway restart smoke, not ai.jarvis.gateway" >&2
    log "use --runtime-scope jarvis without live restart, then run Jarvis Telegram UX proof after explicit runtime refresh approval" >&2
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

  assert_sacred_main_clean
  git -C "${MAIN_REPO}" fetch origin main >/dev/null 2>&1 || true
  if git -C "${MAIN_REPO}" merge-base --is-ancestor "${head_sha}" origin/main 2>/dev/null; then
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
    log "PR #${PR_NUMBER} already merged; continuing to ${RUNTIME_SCOPE} runtime proof"
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

extract_json_line() {
  local raw="$1"
  local line=""
  # Some status paths emit human config warnings before the machine JSON.
  # Keep the ship wrapper tolerant so proof parsing does not fail after a
  # successful deploy/restart.
  while IFS= read -r line; do
    if printf '%s\n' "${line}" | jq -e . >/dev/null 2>&1; then
      printf '%s\n' "${line}"
      return 0
    fi
  done <<<"${raw}"

  log "expected JSON output but gateway status printed no parseable JSON object" >&2
  printf '%s\n' "${raw}" >&2
  return 1
}

print_closeout() {
  local pr_url="$1"
  local commit_sha="$2"
  local changed_files="$3"
  local ci_line="$4"
  local deploy_line="$5"
  local live_line="$6"
  local validation_line="$7"
  local known_gaps_line="$8"
  local rollback_line="$9"

  cat <<EOF
PR: ${pr_url}
Commit: ${commit_sha}
Changed files: ${changed_files}
Runtime scope: ${RUNTIME_SCOPE}
Local validation: ${validation_line}
CI: ${ci_line}
Deploy: ${deploy_line}
Live proof: ${live_line}
Known gaps: ${known_gaps_line}
Rollback: ${rollback_line}
EOF
}

main() {
  maybe_reexec_from_sacred_main "$@"
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

  local status_proof=""
  local deploy_line=""
  local validation_line=""
  local known_gaps_line=""
  local rollback_line=""
  local expected_commit=""
  expected_commit="$(git -C "${MAIN_REPO}" rev-parse --short=12 HEAD 2>/dev/null || printf dry-run)"
  if [[ "${RUNTIME_SCOPE}" == "openclaw-shared" ]]; then
    run_in_main_or_print bash scripts/build-shared-runtime.sh
    run_in_main_or_print bash scripts/gateway-recover-main.sh

    if (( DRY_RUN == 1 )); then
      status_proof="dry-run"
    else
      status_proof="$(gateway_status_summary "$(extract_json_line "$(run_in_main_or_print pnpm openclaw:local gateway status --deep --require-rpc --json)")")"
    fi
    deploy_line="sacred-main fast-forward + build + gateway recovery; status=${status_proof}"
    validation_line="scripts/build-shared-runtime.sh; scripts/gateway-recover-main.sh"
    known_gaps_line="Telegram restart smoke runs only with --live-telegram-restart and configured chat/session. This scope is not Jarvis-managed ai.jarvis.gateway proof."
    rollback_line="revert PR #${PR_NUMBER}, fast-forward ${MAIN_REPO}, then rerun scripts/build-shared-runtime.sh and scripts/gateway-recover-main.sh."
  else
    run_in_main_or_print bash scripts/prove-jarvis-runtime.sh --expected-commit "${expected_commit}"
    status_proof="jarvis runtime proof expected_commit=${expected_commit}"
    deploy_line="no deploy/restart by this wrapper; read-only Jarvis proof only; status=${status_proof}"
    validation_line="scripts/prove-jarvis-runtime.sh --expected-commit ${expected_commit}"
    known_gaps_line="Jarvis app-support bundle refresh and Telegram live UX proof are separate approval-gated steps."
    rollback_line="revert PR #${PR_NUMBER}. This wrapper did not mutate the Jarvis gateway, shared gateway, or /Applications/Jarvis.app in jarvis scope."
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
    "${deploy_line}" \
    "${live_line}" \
    "${validation_line}" \
    "${known_gaps_line}" \
    "${rollback_line}"
}

main "$@"
