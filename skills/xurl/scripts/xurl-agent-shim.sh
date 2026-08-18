#!/usr/bin/env bash

set -euo pipefail

# Resolve the checked-in/shared skill location even when this script is reached
# through ~/.local/bin/xurl. The guard must remain beside the canonical skill,
# not be copied into a second independently drifting install location.
script_path="$(realpath "${BASH_SOURCE[0]}")"
script_dir="$(cd -- "$(dirname -- "$script_path")" && pwd -P)"
guard="${XURL_AGENT_GUARD:-$script_dir/xurl-read-safe.sh}"
state_dir="${XURL_AGENT_SHIM_STATE_DIR:-${HOME}/.local/share/xurl-agent-shim}"

die() {
  echo "ERROR: $*" >&2
  exit 2
}

same_file() {
  [[ -e "$1" && -e "$2" ]] || return 1
  [[ "$(realpath "$1")" == "$(realpath "$2")" ]]
}

find_real_xurl() {
  local candidate=""

  # Tests and managed environments may pin the underlying CLI explicitly.
  if [[ -n "${XURL_REAL_BIN:-}" ]]; then
    [[ -x "$XURL_REAL_BIN" ]] || die "XURL_REAL_BIN is not executable: $XURL_REAL_BIN"
    same_file "$XURL_REAL_BIN" "$script_path" && die "XURL_REAL_BIN points back to the agent shim"
    printf '%s\n' "$XURL_REAL_BIN"
    return
  fi

  # The installer records the unrestricted CLI outside PATH. This survives a
  # package update and avoids depending on Homebrew versus npm install order.
  candidate="$state_dir/real-bin"
  if [[ -x "$candidate" ]] && ! same_file "$candidate" "$script_path"; then
    printf '%s\n' "$candidate"
    return
  fi

  # Fall back to standard package-manager locations. Never return the shim
  # itself, even if ~/.local/bin appears more than once in PATH.
  for candidate in /opt/homebrew/bin/xurl /usr/local/bin/xurl /usr/bin/xurl; do
    if [[ -x "$candidate" ]] && ! same_file "$candidate" "$script_path"; then
      printf '%s\n' "$candidate"
      return
    fi
  done

  local path_dir=""
  while IFS= read -r path_dir; do
    [[ -n "$path_dir" ]] || continue
    candidate="$path_dir/xurl"
    if [[ -x "$candidate" ]] && ! same_file "$candidate" "$script_path"; then
      printf '%s\n' "$candidate"
      return
    fi
  done < <(tr ':' '\n' <<<"$PATH")

  die "the unrestricted xurl executable was not found; reinstall xurl, then reinstall the agent shim"
}

real_xurl="$(find_real_xurl)"

# Installer-only discovery keeps the resolver logic in one place. The unusual
# flag is intentionally not forwarded to the real CLI.
if [[ "${1:-}" == "--agent-shim-print-real-bin" ]]; then
  printf '%s\n' "$real_xurl"
  exit 0
fi

(($# > 0)) || exec "$real_xurl"

# The approval receipt is a shim/guard option, not an xurl CLI flag. Require it
# at the front so a search query containing the same text remains inert data.
approved_max=""
case "${1:-}" in
  --approved-max)
    (($# >= 2)) || die "--approved-max requires a value"
    approved_max="$2"
    shift 2
    ;;
  --approved-max=*)
    approved_max="${1#*=}"
    shift
    ;;
esac

(($# > 0)) || die "an xurl command is required"

args=("$@")
command_name=""
raw_path_seen=0
request_method="GET"
request_method_explicit=0
request_data_seen=0

# Classify the first command without evaluating query text. Unknown commands
# fail closed because a future xurl release could otherwise add a paid read
# shortcut that silently bypasses this boundary.
for ((index = 0; index < ${#args[@]}; index += 1)); do
  arg="${args[$index]}"

  case "$arg" in
    -v|--verbose)
      die "$arg is forbidden in agent sessions because it can expose credentials"
      ;;
    -X|--method)
      ((index + 1 < ${#args[@]})) || die "$arg requires a value"
      request_method="$(printf '%s' "${args[$((index + 1))]}" | tr '[:lower:]' '[:upper:]')"
      request_method_explicit=1
      index=$((index + 1))
      ;;
    --method=*)
      request_method="${arg#*=}"
      request_method="$(printf '%s' "$request_method" | tr '[:lower:]' '[:upper:]')"
      request_method_explicit=1
      ;;
    -d|--data|--data=*|-F|--file|--file=*)
      request_data_seen=1
      ;;
  esac

  [[ -z "$command_name" ]] || continue
  case "$arg" in
    --app|--auth|-u|--username|-H|--header|-d|--data|-F|--file)
      ((index + 1 < ${#args[@]})) || die "$arg requires a value"
      index=$((index + 1))
      ;;
    --app=*|--auth=*|--username=*|--header=*|--data=*|--file=*|-t|--trace|-s|--stream|-X|--method|--method=*)
      ;;
    /2/*|https://api.x.com/*|https://api.twitter.com/*)
      command_name="__raw__"
      raw_path_seen=1
      ;;
    *)
      command_name="$arg"
      ;;
  esac
done

[[ -n "$command_name" ]] || die "an xurl command is required"

# Match xurl's curl-compatible behavior: request data implies POST unless the
# caller selected a method explicitly. Without this, the safety classifier
# would reject a legitimate write that xurl itself correctly treats as POST.
if ((request_data_seen == 1 && request_method_explicit == 0)); then
  request_method="POST"
fi

case "$command_name" in
  read|search|whoami|user|posts|timeline|mentions|bookmarks|likes|following|followers|dms)
    [[ -x "$guard" ]] || die "xurl read guard is missing or not executable: $guard"
    if [[ -n "$approved_max" ]]; then
      XURL_REAL_BIN="$real_xurl" exec "$guard" --approved-max "$approved_max" -- "${args[@]}"
    fi
    XURL_REAL_BIN="$real_xurl" exec "$guard" -- "${args[@]}"
    ;;
  __raw__)
    [[ -z "$approved_max" ]] || die "--approved-max is only valid for guarded read shortcuts"
    ((raw_path_seen == 1)) || die "internal raw-command classification failed"
    case "$request_method" in
      GET|HEAD)
        die "direct raw xurl reads are blocked; use a bounded shortcut through xurl-read-safe.sh"
        ;;
      POST|PUT|PATCH|DELETE)
        exec "$real_xurl" "${args[@]}"
        ;;
      *)
        die "unsupported raw request method: $request_method"
        ;;
    esac
    ;;
  auth|help|version|completion|-h|--help|--version)
    [[ -z "$approved_max" ]] || die "--approved-max is only valid for guarded read shortcuts"
    exec "$real_xurl" "${args[@]}"
    ;;
  post|reply|quote|delete|like|unlike|repost|unrepost|bookmark|unbookmark|follow|unfollow|block|unblock|mute|unmute|dm|media)
    [[ -z "$approved_max" ]] || die "--approved-max is only valid for guarded read shortcuts"
    exec "$real_xurl" "${args[@]}"
    ;;
  *)
    die "unrecognized xurl command is blocked by the agent-safe shim: $command_name"
    ;;
esac
