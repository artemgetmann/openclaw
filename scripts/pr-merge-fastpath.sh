#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=0
PR_NUMBER=""

log() {
  printf '[pr-merge-fastpath] %s\n' "$*"
}

usage() {
  cat <<EOF
usage: bash scripts/pr-merge-fastpath.sh [--dry-run] PR_NUMBER

Compact PR merge helper. Required gates are:
- CI / pr-required
- Workflow Sanity / actionlint
EOF
}

parse_args() {
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --dry-run)
        DRY_RUN=1
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        if [[ -n "${PR_NUMBER}" ]]; then
          printf '[pr-merge-fastpath] unexpected argument: %s\n' "$1" >&2
          usage >&2
          exit 2
        fi
        PR_NUMBER="$1"
        ;;
    esac
    shift
  done
  if [[ -z "${PR_NUMBER}" || ! "${PR_NUMBER}" =~ ^[0-9]+$ ]]; then
    usage >&2
    exit 2
  fi
}

run_or_print() {
  if [[ "${DRY_RUN}" == "1" ]]; then
    log "dry-run: $*"
    return 0
  fi
  "$@"
}

required_check_state() {
  local checks_json="$1"
  node --input-type=module - "${checks_json}" <<'JS'
const checks = JSON.parse(process.argv[2]);
const required = new Map([
  ["CI / pr-required", "missing"],
  ["Workflow Sanity / actionlint", "missing"],
]);
for (const check of checks) {
  const name = check.name ?? check.context ?? "";
  if (!required.has(name)) continue;
  required.set(name, String(check.state ?? check.conclusion ?? "unknown").toLowerCase());
}
for (const [name, state] of required) {
  console.log(`${name}=${state}`);
}
JS
}

has_pending_required_check() {
  printf '%s\n' "$1" | grep -E -q '=(pending|queued|in_progress|waiting|requested|missing)$'
}

has_failed_required_check() {
  printf '%s\n' "$1" | grep -E -q '=(fail|failure|error|cancelled|skipped|timed_out|action_required)$'
}

main() {
  parse_args "$@"

  local pr_json=""
  pr_json="$(gh pr view "${PR_NUMBER}" --json number,headRefOid,mergeStateStatus,isCrossRepository)"
  local head_sha=""
  local merge_state=""
  head_sha="$(node --input-type=module - "${pr_json}" <<'JS'
const pr = JSON.parse(process.argv[2]);
console.log(pr.headRefOid ?? "");
JS
)"
  merge_state="$(node --input-type=module - "${pr_json}" <<'JS'
const pr = JSON.parse(process.argv[2]);
console.log(pr.mergeStateStatus ?? "");
JS
)"

  local checks_json=""
  checks_json="$(gh pr checks "${PR_NUMBER}" --json name,state 2>/dev/null || printf '[]')"
  local required_state=""
  required_state="$(required_check_state "${checks_json}")"

  log "pr=${PR_NUMBER}"
  log "head=${head_sha}"
  log "required_checks=$(printf '%s' "${required_state}" | paste -sd ',' -)"

  if [[ "${merge_state}" == "BEHIND" ]]; then
    run_or_print gh pr update-branch "${PR_NUMBER}"
    log "result=update-branch-requested"
    return 0
  fi

  if has_failed_required_check "${required_state}"; then
    log "result=blocked-required-check-failed"
    return 1
  fi

  if has_pending_required_check "${required_state}"; then
    run_or_print gh pr merge "${PR_NUMBER}" --squash --auto
    log "result=auto-merge-enabled"
    return 0
  fi

  run_or_print gh pr merge "${PR_NUMBER}" --squash
  log "result=merged-or-merge-requested"
}

if [[ "${OPENCLAW_SCRIPT_LIB_TEST:-0}" != "1" ]]; then
  main "$@"
fi
