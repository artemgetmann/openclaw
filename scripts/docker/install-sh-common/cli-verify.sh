#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./version-parse.sh
source "$SCRIPT_DIR/version-parse.sh"

resolve_installer_node() {
  local requested_node="${OPENCLAW_NODE_BIN:-}"
  local candidate=""
  local version=""
  local best_node=""
  local best_version=""

  if [[ -n "$requested_node" ]]; then
    if [[ -x "$requested_node" ]]; then
      printf '%s\n' "$requested_node"
      return 0
    fi
    echo "ERROR: OPENCLAW_NODE_BIN=$requested_node is not executable" >&2
    return 1
  fi

  # The installer may add a newer system Node while this shell still sees the
  # image's original Node first. Select the highest version visible on PATH so
  # the verifier exercises the runtime the installer made available.
  while IFS= read -r candidate; do
    [[ -x "$candidate" ]] || continue
    version="$("$candidate" -p 'process.versions.node' 2>/dev/null || true)"
    [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
    if [[ -z "$best_version" || "$(printf '%s\n%s\n' "$best_version" "$version" | sort -V | tail -n 1)" == "$version" ]]; then
      best_node="$candidate"
      best_version="$version"
    fi
  done < <(type -a -p node 2>/dev/null | awk '!seen[$0]++')

  if [[ -z "$best_node" ]]; then
    echo "ERROR: no executable Node.js runtime found on PATH" >&2
    return 1
  fi
  printf '%s\n' "$best_node"
}

verify_installed_cli() {
  local package_name="$1"
  local expected_version="$2"
  local cli_name="$package_name"
  local cmd_path=""
  local entry_path=""
  local npm_root=""
  local installed_version=""
  local node_bin=""
  local node_path=""
  local version_output=""

  node_bin="$(resolve_installer_node)" || return 1
  node_path="$(dirname "$node_bin")"

  cmd_path="$(command -v "$cli_name" || true)"
  if [[ -z "$cmd_path" && -x "$HOME/.npm-global/bin/$package_name" ]]; then
    cmd_path="$HOME/.npm-global/bin/$package_name"
  fi

  if [[ -z "$cmd_path" ]]; then
    npm_root="$(npm root -g 2>/dev/null || true)"
    if [[ -n "$npm_root" && -f "$npm_root/$package_name/dist/entry.js" ]]; then
      entry_path="$npm_root/$package_name/dist/entry.js"
    fi
  fi

  if [[ -z "$cmd_path" && -z "$entry_path" ]]; then
    echo "ERROR: $package_name is not on PATH" >&2
    return 1
  fi

  if [[ -n "$cmd_path" ]]; then
    if ! version_output="$(PATH="$node_path:$PATH" "$cmd_path" --version 2>&1)"; then
      printf '%s\n' "$version_output" >&2
      return 1
    fi
  else
    if ! version_output="$("$node_bin" "$entry_path" --version 2>&1)"; then
      printf '%s\n' "$version_output" >&2
      return 1
    fi
  fi
  installed_version="$(printf '%s\n' "$version_output" | head -n 1 | tr -d '\r')"

  installed_version="$(extract_openclaw_semver "$installed_version")"

  echo "cli=$cli_name installed=$installed_version expected=$expected_version"
  if [[ "$installed_version" != "$expected_version" ]]; then
    echo "ERROR: expected ${cli_name}@${expected_version}, got ${cli_name}@${installed_version}" >&2
    return 1
  fi

  echo "==> Sanity: CLI runs"
  if [[ -n "$cmd_path" ]]; then
    PATH="$node_path:$PATH" "$cmd_path" --help >/dev/null
  else
    "$node_bin" "$entry_path" --help >/dev/null
  fi
}
