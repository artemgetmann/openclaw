#!/usr/bin/env bash

# Consumer/runtime scripts must not silently inherit whichever Node happens to
# be first in PATH. That is how a shell on Node 25 can bootstrap a worktree
# differently from the lane/runtime we actually validate and support.

if [[ -z "${OPENCLAW_VALIDATED_NODE_VERSION:-}" ]]; then
  OPENCLAW_VALIDATED_NODE_VERSION="22.22.1"
fi

openclaw_validated_node_version_file() {
  local root="$1"
  local candidate=""
  for candidate in "$root/.node-version" "$root/.nvmrc"; do
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

openclaw_validated_node_version() {
  local root="$1"
  local version_file=""
  local version_value=""

  version_file="$(openclaw_validated_node_version_file "$root" || true)"
  if [[ -z "$version_file" ]]; then
    printf '%s\n' "$OPENCLAW_VALIDATED_NODE_VERSION"
    return 0
  fi

  version_value="$(tr -d '[:space:]' < "$version_file")"
  if [[ -z "$version_value" ]]; then
    printf 'ERROR: validated Node version file is empty: %s\n' "$version_file" >&2
    return 1
  fi

  printf '%s\n' "$version_value"
}

openclaw_node_version_matches() {
  local node_bin="$1"
  local expected_version="$2"
  local actual_version=""

  [[ -x "$node_bin" ]] || return 1
  actual_version="$("$node_bin" -p "process.versions.node" 2>/dev/null | tr -d '\r')"
  [[ "$actual_version" == "$expected_version" ]]
}

openclaw_print_validated_node_candidates() {
  local expected_version="$1"
  local major_version="${expected_version%%.*}"
  local home_dir="${HOME:-}"

  cat <<EOF
/opt/homebrew/opt/node@${major_version}/bin/node
/usr/local/opt/node@${major_version}/bin/node
/opt/homebrew/bin/node
/usr/local/bin/node
${home_dir}/.nvm/versions/node/v${expected_version}/bin/node
${home_dir}/.local/share/fnm/node-versions/v${expected_version}/installation/bin/node
${home_dir}/.fnm/node-versions/v${expected_version}/installation/bin/node
${home_dir}/.volta/tools/image/node/${expected_version}/bin/node
EOF
}

openclaw_resolve_validated_node_bin() {
  local root="$1"
  local expected_version=""
  local requested_node="${OPENCLAW_NODE_BIN:-}"
  local candidate=""
  local fallback_path_node=""

  expected_version="$(openclaw_validated_node_version "$root")" || return 1

  # If the caller explicitly pins a node binary, only accept it when it still
  # matches the repo-validated version. Override is for location, not version.
  if [[ -n "$requested_node" ]]; then
    if openclaw_node_version_matches "$requested_node" "$expected_version"; then
      printf '%s\n' "$requested_node"
      return 0
    fi
    printf 'ERROR: OPENCLAW_NODE_BIN=%s is not the validated Node %s.\n' "$requested_node" "$expected_version" >&2
    return 1
  fi

  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] || continue
    if openclaw_node_version_matches "$candidate" "$expected_version"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done < <(openclaw_print_validated_node_candidates "$expected_version")

  fallback_path_node="$(command -v node 2>/dev/null || true)"
  if [[ -n "$fallback_path_node" ]] && openclaw_node_version_matches "$fallback_path_node" "$expected_version"; then
    printf '%s\n' "$fallback_path_node"
    return 0
  fi

  printf 'ERROR: validated Node %s not found. Install that exact version or set OPENCLAW_NODE_BIN to a matching binary.\n' "$expected_version" >&2
  return 1
}

openclaw_use_validated_node() {
  local root="$1"
  local node_bin=""
  local node_dir=""

  node_bin="$(openclaw_resolve_validated_node_bin "$root")" || return 1
  node_dir="$(cd -- "$(dirname -- "$node_bin")" && pwd -P)"

  export OPENCLAW_NODE_BIN="$node_bin"
  export OPENCLAW_VALIDATED_NODE_BIN="$node_bin"

  case ":${PATH:-}:" in
    *":${node_dir}:"*) ;;
    *)
      export PATH="${node_dir}:${PATH:-}"
      ;;
  esac

  printf '%s\n' "$node_bin"
}

openclaw_run_repo_pnpm() {
  local root="$1"
  shift
  local node_bin=""
  local node_dir=""
  local corepack_bin=""
  local corepack_shim_dir=""
  local expected_package_manager=""
  local actual_pnpm_version=""

  openclaw_use_validated_node "$root" >/dev/null || return 1
  node_bin="$OPENCLAW_NODE_BIN"
  node_dir="$(dirname "$node_bin")"
  corepack_bin="${node_dir}/corepack"

  expected_package_manager="$(cd "$root" && "$node_bin" -p "require('./package.json').packageManager ?? ''" 2>/dev/null || true)"

  # Prefer the Corepack binary that ships with the validated Node install so
  # pnpm resolution is anchored to the same runtime line instead of shell PATH.
  if [[ -x "$corepack_bin" ]]; then
    # Package scripts in this repo shell out to `pnpm` again (for example the
    # main build script). When launchd starts without pnpm on PATH, expose a
    # tiny repo-local shim so nested `pnpm ...` calls resolve back through the
    # same validated Node/Corepack pair instead of failing mid-build.
    corepack_shim_dir="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-pnpm-shim.XXXXXX")"
    cat > "${corepack_shim_dir}/pnpm" <<EOF
#!/usr/bin/env bash
exec "${node_bin}" "${corepack_bin}" pnpm "\$@"
EOF
    chmod 700 "${corepack_shim_dir}/pnpm"
    (
      trap 'rm -rf "'"${corepack_shim_dir}"'"' EXIT
      cd "$root"
      PATH="${corepack_shim_dir}:${node_dir}:${PATH:-}" "$node_bin" "$corepack_bin" pnpm "$@"
    )
    return $?
  fi

  # Fallback remains explicit about the required pnpm line. If someone only has
  # a standalone pnpm binary, we still reject mismatched versions instead of
  # silently trusting a random global install.
  if command -v pnpm >/dev/null 2>&1; then
    if [[ -n "$expected_package_manager" ]]; then
      actual_pnpm_version="$(pnpm --version 2>/dev/null | tr -d '\r')"
      if [[ "$expected_package_manager" != "pnpm@${actual_pnpm_version}" ]]; then
        printf 'ERROR: pnpm %s does not match packageManager=%s.\n' "${actual_pnpm_version:-unknown}" "$expected_package_manager" >&2
        return 1
      fi
    fi
    (
      cd "$root"
      pnpm "$@"
    )
    return $?
  fi

  printf 'ERROR: pnpm not found for %s. Install pnpm 10.23.0 or use a Node build that includes corepack.\n' "$root" >&2
  return 1
}
