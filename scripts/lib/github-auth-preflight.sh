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
      # Shell cannot authenticate or invoke the Codex GitHub connector. The
      # caller must select that transport before any mutation and let the
      # connector prove its own authenticated read capability.
      echo "GITHUB_PREFLIGHT status=indeterminate transport=connector reason=connector-proof-required"
      return 75
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
    --jq '[.state, .headRefOid, (.mergeCommit.oid // ""), (if .autoMergeRequest == null then "false" else "true" end)] | @tsv'
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
    echo "GITHUB_MUTATION status=indeterminate reason=mutation-command-failed state=${state} head=${head} merge_commit=${merge_commit:-none} auto_merge=${auto_merge}"
  else
    echo "GITHUB_MUTATION status=indeterminate reason=mutation-and-reconciliation-read-failed"
  fi
  return 75
}
