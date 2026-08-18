#!/usr/bin/env bash

set -euo pipefail

script_path="$(realpath "${BASH_SOURCE[0]}")"
script_dir="$(cd -- "$(dirname -- "$script_path")" && pwd -P)"
shim="${XURL_AGENT_SHIM_SOURCE:-$script_dir/xurl-agent-shim.sh}"
target="${XURL_AGENT_SHIM_TARGET:-${HOME}/.local/bin/xurl}"
state_dir="${XURL_AGENT_SHIM_STATE_DIR:-${HOME}/.local/share/xurl-agent-shim}"
mode="install"

usage() {
  cat <<'EOF'
Usage: install-xurl-agent-shim.sh [--status|--uninstall]

Installs the agent-safe xurl shim at ~/.local/bin/xurl and preserves the prior
entry for a reversible uninstall. Override paths with XURL_AGENT_SHIM_SOURCE,
XURL_AGENT_SHIM_TARGET, and XURL_AGENT_SHIM_STATE_DIR for tests.
EOF
}

if (($# > 1)); then
  usage >&2
  exit 2
fi
case "${1:-}" in
  "") ;;
  --status) mode="status" ;;
  --uninstall) mode="uninstall" ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

is_installed() {
  [[ -L "$target" && "$(realpath "$target")" == "$(realpath "$shim")" ]]
}

is_effective() {
  local resolved=""
  resolved="$(command -v xurl 2>/dev/null || true)"
  [[ -n "$resolved" && -e "$resolved" && "$(realpath "$resolved")" == "$(realpath "$shim")" ]]
}

has_managed_state() {
  [[ -f "$state_dir/install-marker" && -f "$state_dir/original-kind" ]] || return 1
  [[ "$(<"$state_dir/install-marker")" == "$target" ]]
}

if [[ "$mode" == "status" ]]; then
  if is_installed && is_effective; then
    echo "installed: $target -> $(realpath "$shim")"
    exit 0
  fi
  if is_installed; then
    echo "installed but inactive: PATH does not resolve xurl to $target" >&2
  else
    echo "not installed: $target" >&2
  fi
  exit 1
fi

if [[ "$mode" == "uninstall" ]]; then
  is_installed || { echo "not installed: $target" >&2; exit 1; }
  [[ -f "$state_dir/original-kind" ]] || { echo "missing uninstall state: $state_dir/original-kind" >&2; exit 2; }

  original_kind="$(<"$state_dir/original-kind")"
  /bin/rm -f -- "$target"
  case "$original_kind" in
    symlink)
      original_link="$(<"$state_dir/original-link")"
      ln -s -- "$original_link" "$target"
      ;;
    file)
      cp -p -- "$state_dir/original-file" "$target"
      ;;
    absent)
      ;;
    *)
      echo "unknown uninstall state: $original_kind" >&2
      exit 2
      ;;
  esac
  echo "removed agent-safe xurl shim"
  exit 0
fi

[[ -x "$shim" ]] || { echo "shim is missing or not executable: $shim" >&2; exit 2; }
if is_installed; then
  if is_effective; then
    echo "already installed: $target"
    exit 0
  fi
  echo "shim exists but PATH does not resolve xurl to $target" >&2
  exit 2
fi

# Resolve the real CLI before replacing the current PATH entry. The shim then
# receives a stable backing symlink that prevents recursion after installation.
real_xurl="$($shim --agent-shim-print-real-bin)"
real_xurl="$(realpath "$real_xurl")"
[[ -x "$real_xurl" ]] || { echo "resolved xurl is not executable: $real_xurl" >&2; exit 2; }

target_dir="$(dirname -- "$target")"
mkdir -p -- "$target_dir" "$state_dir"

# Installation is useless if an unrestricted xurl earlier on PATH still wins.
# Check the final resolution order before touching the existing command.
path_can_resolve_target=0
while IFS= read -r path_dir; do
  [[ -n "$path_dir" ]] || continue
  mkdir_candidate="$(cd -- "$path_dir" 2>/dev/null && pwd -P || true)"
  [[ -n "$mkdir_candidate" ]] || continue
  if [[ "$mkdir_candidate" == "$(cd -- "$target_dir" && pwd -P)" ]]; then
    path_can_resolve_target=1
    break
  fi
  [[ -x "$path_dir/xurl" ]] && break
done < <(tr ':' '\n' <<<"$PATH")
((path_can_resolve_target == 1)) || { echo "refusing inactive install: put $target_dir before the current xurl directory on PATH" >&2; exit 2; }

# A managed upgrade may point at an older shared-skill location. Preserve the
# original pre-shim receipt instead of replacing it with the obsolete shim.
if ! has_managed_state; then
  if [[ -L "$target" ]]; then
    printf '%s\n' symlink >"$state_dir/original-kind"
    readlink "$target" >"$state_dir/original-link"
  elif [[ -f "$target" ]]; then
    printf '%s\n' file >"$state_dir/original-kind"
    cp -p -- "$target" "$state_dir/original-file"
  elif [[ -e "$target" ]]; then
    echo "refusing to replace non-file target: $target" >&2
    exit 2
  else
    printf '%s\n' absent >"$state_dir/original-kind"
  fi
  printf '%s\n' "$target" >"$state_dir/install-marker"
fi

ln -sfn -- "$real_xurl" "$state_dir/real-bin"
ln -sfn -- "$(realpath "$shim")" "$target"
is_effective || { echo "installation failed: PATH does not resolve xurl to $target" >&2; exit 2; }
echo "installed: $target -> $(realpath "$shim")"
