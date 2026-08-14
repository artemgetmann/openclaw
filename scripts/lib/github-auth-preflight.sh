#!/usr/bin/env bash

# GitHub truth crosses an execution-context boundary on developer machines:
# keyring and network access can differ between a restricted agent process and
# the host. Keep this helper read-only so an authorized host rerun cannot repeat
# a mutation or turn a sandbox false negative into credential churn.

openclaw_github_preflight() {
  local context="${1:-restricted}"
  local transport="${2:-host-gh}"
  local gh_bin="${OPENCLAW_GITHUB_GH_BIN:-gh}"
  local account=""

  case "${context}" in
    restricted|host) ;;
    *)
      echo "GITHUB_PREFLIGHT status=invalid reason=unknown-context" >&2
      return 2
      ;;
  esac

  case "${transport}" in
    host-gh) ;;
    connector)
      # Connector calls happen at the native agent boundary, then this one
      # verifier validates their secret-free, capability-scoped evidence. Both
      # preflight and workflow commands therefore consume the same policy source.
      local helper_root=""
      helper_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
      if [[ -z "${OPENCLAW_GITHUB_CONNECTOR_EVIDENCE:-}" ||
        -z "${OPENCLAW_GITHUB_REPOSITORY:-}" ||
        -z "${OPENCLAW_GITHUB_PR:-}" ]]; then
        echo "GITHUB_PREFLIGHT status=blocked transport=connector reason=evidence-context-missing next=collect_connector_candidate_evidence" >&2
        return 75
      fi
      if ! node "${helper_root}/scripts/github-connector-transport.mjs" verify \
        "${OPENCLAW_GITHUB_CONNECTOR_EVIDENCE}" >/dev/null; then
        return 75
      fi
      echo "GITHUB_PREFLIGHT status=ready context=${context} transport=connector capability=read-candidate"
      return 0
      ;;
    *)
      echo "GITHUB_PREFLIGHT status=invalid reason=unknown-transport" >&2
      return 2
      ;;
  esac

  # `gh auth status` is local metadata and can succeed while API access fails.
  # Probe the smallest useful authenticated API read, discard all stderr, and
  # emit only a validated public login so tokens and credential diagnostics can
  # never escape through this helper.
  if account="$("${gh_bin}" api user --jq .login 2>/dev/null)" &&
    [[ "${account}" =~ ^[A-Za-z0-9-]+$ ]]; then
    echo "GITHUB_PREFLIGHT status=ready context=${context} transport=host-gh account=${account}"
    return 0
  fi

  if [[ "${context}" == "restricted" ]]; then
    echo "GITHUB_PREFLIGHT status=indeterminate context=restricted transport=host-gh reason=api-probe-failed next=authorized-host-read-only-or-authenticated-connector"
    return 75
  fi

  echo "GITHUB_PREFLIGHT status=blocked context=host transport=host-gh reason=api-probe-failed"
  return 1
}

openclaw_git_transport_preflight() {
  local context="${1:-restricted}"
  local remote="${2:-origin}"
  local git_bin="${OPENCLAW_GITHUB_GIT_BIN:-git}"
  local fetch_url=""
  local push_url=""
  local fetch_protocol="unknown"
  local push_protocol="unknown"
  local probe_ref="refs/heads/codex/transport-preflight-$$"

  case "${context}" in
    restricted|host) ;;
    *)
      echo "GIT_TRANSPORT status=invalid reason=unknown-context" >&2
      return 2
      ;;
  esac

  if ! fetch_url="$("${git_bin}" remote get-url "${remote}" 2>/dev/null)" ||
    ! push_url="$("${git_bin}" remote get-url --push "${remote}" 2>/dev/null)"; then
    echo "GIT_TRANSPORT status=blocked context=${context} remote=${remote} fetch_protocol=unknown push_protocol=unknown reason=remote-url-unavailable" >&2
    return 1
  fi

  case "${fetch_url}" in
    git@github.com:*|ssh://git@github.com/*) fetch_protocol="ssh" ;;
    https://github.com/*) fetch_protocol="https" ;;
  esac
  case "${push_url}" in
    git@github.com:*|ssh://git@github.com/*) push_protocol="ssh" ;;
    https://github.com/*) push_protocol="https" ;;
  esac

  # A read probe proves fetch only. The dry run checks the configured push URL,
  # authentication, and repository permission without creating a remote ref.
  # Disable local hooks so a nominally non-mutating diagnostic stays read-only.
  if "${git_bin}" ls-remote --exit-code "${remote}" HEAD >/dev/null 2>&1 &&
    "${git_bin}" -c core.hooksPath=/dev/null push --dry-run "${remote}" "HEAD:${probe_ref}" >/dev/null 2>&1; then
    echo "GIT_TRANSPORT status=ready context=${context} remote=${remote} fetch_protocol=${fetch_protocol} push_protocol=${push_protocol} fetch=ready push=ready"
    return 0
  fi

  if [[ "${context}" == "restricted" ]]; then
    echo "GIT_TRANSPORT status=indeterminate context=restricted remote=${remote} fetch_protocol=${fetch_protocol} push_protocol=${push_protocol} reason=fetch-or-push-probe-failed next=authorized-host-read-only-probe"
    return 75
  fi

  echo "GIT_TRANSPORT status=blocked context=host remote=${remote} fetch_protocol=${fetch_protocol} push_protocol=${push_protocol} reason=fetch-or-push-probe-failed" >&2
  return 1
}

openclaw_github_transport_report() {
  local context="${1:-restricted}"
  local remote="${2:-origin}"
  local connector_status=75
  local host_gh_status=75
  local git_status=75

  echo "GITHUB_TRANSPORT_REPORT status=begin context=${context} remote=${remote}"

  if [[ -n "${OPENCLAW_GITHUB_CONNECTOR_EVIDENCE:-}" &&
    -n "${OPENCLAW_GITHUB_REPOSITORY:-}" &&
    -n "${OPENCLAW_GITHUB_PR:-}" ]]; then
    connector_status=0
    openclaw_github_preflight "${context}" connector || connector_status=$?
  else
    echo "GITHUB_PREFLIGHT status=unproven context=${context} transport=connector capability=unknown next=collect_connector_capability_evidence"
  fi

  host_gh_status=0
  openclaw_github_preflight "${context}" host-gh || host_gh_status=$?

  git_status=0
  openclaw_git_transport_preflight "${context}" "${remote}" || git_status=$?

  if [[ "${connector_status}" -eq 0 || "${host_gh_status}" -eq 0 ]]; then
    if [[ "${git_status}" -eq 0 ]]; then
      echo "GITHUB_TRANSPORT_REPORT status=ready api=available git=ready"
      return 0
    fi
    echo "GITHUB_TRANSPORT_REPORT status=partial api=available git=unavailable"
    return "${git_status}"
  fi

  echo "GITHUB_TRANSPORT_REPORT status=partial api=unavailable-or-unproven git=$([[ "${git_status}" -eq 0 ]] && echo ready || echo unavailable)"
  [[ "${context}" == "restricted" ]] && return 75
  return 1
}

openclaw_reconcile_failed_git_push() {
  local remote="$1"
  local remote_ref="$2"
  local expected_sha="$3"
  local previous_sha="$4"
  local git_bin="${OPENCLAW_GITHUB_GIT_BIN:-git}"
  local observed_sha=""

  if ! observed_sha="$("${git_bin}" ls-remote "${remote}" "${remote_ref}" 2>/dev/null | awk '{print $1}')"; then
    echo "GIT_PUSH status=indeterminate reason=push-and-reconciliation-read-failed ref=${remote_ref}" >&2
    return 75
  fi

  if [[ "${observed_sha}" == "${expected_sha}" ]]; then
    echo "GIT_PUSH status=accepted-after-reconciliation ref=${remote_ref} sha=${expected_sha} retry=false"
    return 0
  fi

  if [[ "${observed_sha}" == "${previous_sha}" ]]; then
    echo "GIT_PUSH status=indeterminate reason=push-failed-remote-unchanged ref=${remote_ref} sha=${observed_sha} retry=false" >&2
    return 75
  fi

  echo "GIT_PUSH status=blocked reason=remote-drift ref=${remote_ref} expected=${expected_sha} previous=${previous_sha} actual=${observed_sha:-absent} retry=false" >&2
  return 3
}

openclaw_github_select_mutation_transport() {
  local requested="${1:-host-gh}"

  # A shell PR workflow owns only host `gh`. Selecting connector transport
  # disables shell mutation completely; it is not an admin or bypass route.
  case "${requested}" in
    host-gh)
      if [[ -n "${OPENCLAW_GITHUB_SELECTED_TRANSPORT:-}" &&
        "${OPENCLAW_GITHUB_SELECTED_TRANSPORT}" != "host-gh" ]]; then
        echo "GITHUB_MUTATION status=blocked reason=transport-already-selected" >&2
        return 2
      fi
      OPENCLAW_GITHUB_SELECTED_TRANSPORT="host-gh"
      export OPENCLAW_GITHUB_SELECTED_TRANSPORT
      ;;
    connector)
      if [[ -n "${OPENCLAW_GITHUB_SELECTED_TRANSPORT:-}" &&
        "${OPENCLAW_GITHUB_SELECTED_TRANSPORT}" != "connector" ]]; then
        echo "GITHUB_MUTATION status=blocked reason=transport-already-selected" >&2
        return 2
      fi
      OPENCLAW_GITHUB_SELECTED_TRANSPORT="connector"
      export OPENCLAW_GITHUB_SELECTED_TRANSPORT
      echo "GITHUB_MUTATION status=blocked transport=connector reason=shell-transport-disabled" >&2
      return 75
      ;;
    *)
      echo "GITHUB_MUTATION status=blocked reason=unknown-transport" >&2
      return 2
      ;;
  esac
}

openclaw_github_pr_snapshot() {
  local pr="$1"
  local gh_bin="${OPENCLAW_GITHUB_GH_BIN:-gh}"

  "${gh_bin}" pr view "${pr}" \
    --json state,headRefOid,mergeCommit,autoMergeRequest \
    --jq '[.state, .headRefOid, (.mergeCommit.oid // "none"), (if .autoMergeRequest == null then "false" else "true" end)] | @tsv'
}

openclaw_github_pr_mutation_once() {
  local pr="$1"
  local expected_head="$2"
  shift 2
  local snapshot=""
  local state=""
  local head=""
  local merge_commit=""
  local auto_merge=""

  openclaw_github_select_mutation_transport "${OPENCLAW_GITHUB_MUTATION_TRANSPORT:-host-gh}" || return $?

  # Bind authorization to the immutable candidate immediately before the one
  # mutation attempt. A connector transport must enforce the same expected-head
  # condition in its own request; it never falls through to this shell path.
  if ! snapshot="$(openclaw_github_pr_snapshot "${pr}" 2>/dev/null)"; then
    echo "GITHUB_MUTATION status=indeterminate reason=pre-mutation-read-failed" >&2
    return 75
  fi
  IFS=$'\t' read -r state head merge_commit auto_merge <<<"${snapshot}"
  if [[ "${head}" != "${expected_head}" ]]; then
    echo "GITHUB_MUTATION status=blocked reason=expected-head-mismatch expected=${expected_head} actual=${head}" >&2
    return 3
  fi

  # Never surface command stderr: GitHub tooling may include credential or
  # request details. A failed command is ambiguous until a read-only snapshot
  # proves current state, and it is never retried by this helper.
  if "$@" >/dev/null 2>&1; then
    echo "GITHUB_MUTATION status=accepted transport=host-gh head=${expected_head}"
    return 0
  fi

  if snapshot="$(openclaw_github_pr_snapshot "${pr}" 2>/dev/null)"; then
    IFS=$'\t' read -r state head merge_commit auto_merge <<<"${snapshot}"
    echo "GITHUB_MUTATION status=indeterminate reason=mutation-command-failed state=${state} head=${head} merge_commit=${merge_commit} auto_merge=${auto_merge}"
  else
    echo "GITHUB_MUTATION status=indeterminate reason=mutation-and-reconciliation-read-failed"
  fi
  return 75
}
