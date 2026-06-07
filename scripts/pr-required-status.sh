#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="pr-required-status"
GH_BIN="${OPENCLAW_GH_BIN:-gh}"
PR_NUMBER=""
WAIT=0
DEBUG=0
TIMEOUT_SECONDS="${OPENCLAW_PR_REQUIRED_TIMEOUT_SECONDS:-1800}"
POLL_SECONDS="${OPENCLAW_PR_REQUIRED_POLL_SECONDS:-15}"

log() {
  printf '[%s] %s\n' "${SCRIPT_NAME}" "$*"
}

usage() {
  cat <<'EOF'
Usage: scripts/pr-required-status.sh --pr <number> [--wait] [--timeout <seconds>] [--debug]

Checks the required GitHub status checks for one PR with a quiet, merge-focused
summary. Exit codes:
  0  pr-required and all required checks passed
  1  pr-required is missing or a required check failed
  2  required checks are still pending, queued, or timed out
EOF
}

parse_args() {
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --pr)
        PR_NUMBER="${2:-}"
        shift 2
        ;;
      --wait)
        WAIT=1
        shift
        ;;
      --timeout)
        TIMEOUT_SECONDS="${2:-}"
        shift 2
        ;;
      --debug)
        DEBUG=1
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
}

require_tools() {
  local missing=()
  command -v "${GH_BIN}" >/dev/null 2>&1 || missing+=("${GH_BIN}")
  command -v jq >/dev/null 2>&1 || missing+=("jq")
  if (( ${#missing[@]} > 0 )); then
    log "missing required command(s): ${missing[*]}" >&2
    exit 1
  fi
}

fetch_required_checks_json() {
  local output=""
  local err_file=""
  err_file="$(mktemp)"
  if ! output="$("${GH_BIN}" pr checks "${PR_NUMBER}" --required --json name,bucket,state,workflow 2>"${err_file}")"; then
    log "gh pr checks failed for PR #${PR_NUMBER}" >&2
    sed 's/^/[pr-required-status] gh: /' "${err_file}" >&2 || true
    rm -f "${err_file}"
    exit 1
  fi
  rm -f "${err_file}"

  if [[ -z "${output}" ]]; then
    printf '[]\n'
  else
    printf '%s\n' "${output}"
  fi
}

check_once() {
  local checks_json="$1"
  local required_count=0
  local pr_required_count=0
  local failed_count=0
  local pending_count=0

  required_count="$(printf '%s\n' "${checks_json}" | jq 'length')"
  pr_required_count="$(
    printf '%s\n' "${checks_json}" |
      jq '[.[] | select((.name // "") == "pr-required" or (.name // "" | endswith(" / pr-required")))] | length'
  )"

  if [[ "${pr_required_count}" -eq 0 ]]; then
    log "missing pr-required among ${required_count} required check(s)"
    if (( DEBUG == 1 )); then
      printf '%s\n' "${checks_json}" | jq -r '.[] | "\(.bucket // "-")\t\(.name // "-")\t\(.state // "-")"'
    fi
    return 1
  fi

  failed_count="$(
    printf '%s\n' "${checks_json}" |
      jq '[.[] | select((.bucket // "") == "fail" or (.state // "" | test("(?i)fail|error|cancel")))] | length'
  )"
  if [[ "${failed_count}" -gt 0 ]]; then
    log "failed required check(s):"
    printf '%s\n' "${checks_json}" |
      jq -r '.[] | select((.bucket // "") == "fail" or (.state // "" | test("(?i)fail|error|cancel"))) | "  - \(.name // "-") [\(.state // .bucket // "-")]"'
    if (( DEBUG == 1 )); then
      log "full required rollup:"
      printf '%s\n' "${checks_json}" | jq -r '.[] | "  - \(.name // "-") [\(.bucket // "-")/\(.state // "-")]"'
    fi
    return 1
  fi

  pending_count="$(
    printf '%s\n' "${checks_json}" |
      jq '[.[] | select((.bucket // "") == "pending" or (.state // "" | test("(?i)pending|queued|in_progress|waiting")))] | length'
  )"
  if [[ "${pending_count}" -gt 0 ]]; then
    log "still-running required check(s):"
    printf '%s\n' "${checks_json}" |
      jq -r '.[] | select((.bucket // "") == "pending" or (.state // "" | test("(?i)pending|queued|in_progress|waiting"))) | "  - \(.name // "-") [\(.state // .bucket // "-")]"'
    return 2
  fi

  log "pr-required=pass required_checks=${required_count}"
  if (( DEBUG == 1 )); then
    printf '%s\n' "${checks_json}" | jq -r '.[] | "  - \(.name // "-") [\(.bucket // "-")/\(.state // "-")]"'
  fi
  return 0
}

main() {
  parse_args "$@"
  require_tools

  local deadline=$((SECONDS + TIMEOUT_SECONDS))
  local checks_json=""
  local result=0

  while true; do
    checks_json="$(fetch_required_checks_json)"
    # Capture the status explicitly. In bash, `$?` after a completed `if`
    # compound can mask the command's non-zero result, which would turn failed
    # CI into a false green ship signal.
    set +e
    check_once "${checks_json}"
    result=$?
    set -e
    if [[ "${result}" -eq 0 ]]; then
      return 0
    fi

    if (( WAIT != 1 || result == 1 )); then
      return "${result}"
    fi

    if (( SECONDS >= deadline )); then
      log "timed out after ${TIMEOUT_SECONDS}s waiting for required checks"
      return 2
    fi

    sleep "${POLL_SECONDS}"
  done
}

main "$@"
