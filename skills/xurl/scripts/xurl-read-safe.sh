#!/usr/bin/env bash

set -euo pipefail

DEFAULT_MAX=10
HARD_MAX=100
# Standard X pay-per-use rates verified on 2026-08-18. These deliberately use
# the higher public-read rate rather than discounted owned-read pricing so the
# displayed amount remains a conservative maximum for mixed read tasks.
POST_COST_MILLS=5
USER_COST_MILLS=10
DM_COST_MILLS=10

usage() {
  cat >&2 <<'EOF'
Usage:
  xurl-read-safe.sh [--approved-max N] [--dry-run] -- <xurl read command>

Examples:
  xurl-read-safe.sh -- search "openclaw" -n 10
  xurl-read-safe.sh --approved-max 25 -- search "openclaw" -n 25

Reads default to at most 10 returned resources. More than 10 requires an exact
--approved-max value after fresh user approval. More than 100 is refused to
prevent automatic pagination.
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 2
}

format_cost() {
  local count="$1"
  local mills_per_resource="$2"
  local total_mills=$((count * mills_per_resource))
  printf '$%d.%03d' "$((total_mills / 1000))" "$((total_mills % 1000))"
}

approved_max=""
dry_run=0
while (($# > 0)); do
  case "$1" in
    --approved-max)
      (($# >= 2)) || die "--approved-max requires a value"
      approved_max="$2"
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --)
      shift
      break
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown guard option: $1"
      ;;
  esac
done

(($# > 0)) || die "an xurl read command is required"

args=("$@")
command_name=""
requested_count=""
count_flag_seen=0

# Inspect arguments as inert strings. Never evaluate user-provided query text.
# The first positional argument after global flags must be a supported read
# shortcut. This prevents a mutating command with a query word such as "read"
# from being misclassified as a safe operation.
for ((index = 0; index < ${#args[@]}; index += 1)); do
  arg="${args[$index]}"

  if [[ -z "$command_name" ]]; then
    case "$arg" in
      --app|--auth|-u|--username)
        ((index + 1 < ${#args[@]})) || die "$arg requires a value"
        index=$((index + 1))
        continue
        ;;
      -t|--trace)
        continue
        ;;
      -v|--verbose|-s|--stream)
        die "$arg is not allowed for guarded reads"
        ;;
      read|search|whoami|user|posts|timeline|mentions|bookmarks|likes|following|followers|dms)
        command_name="$arg"
        continue
        ;;
      /2/*|https://api.x.com/*|https://api.twitter.com/*)
        die "raw API reads are blocked; use a bounded xurl shortcut"
        ;;
      *)
        die "unsupported or mutating xurl command: $arg"
        ;;
    esac
  fi

  case "$arg" in
    -v|--verbose|-s|--stream)
      die "$arg is not allowed for guarded reads"
      ;;
    -n|--max-results)
      ((index + 1 < ${#args[@]})) || die "$arg requires a value"
      ((count_flag_seen == 0)) || die "result count may be specified only once"
      requested_count="${args[$((index + 1))]}"
      count_flag_seen=1
      index=$((index + 1))
      ;;
    -n[0-9]*)
      ((count_flag_seen == 0)) || die "result count may be specified only once"
      requested_count="${arg#-n}"
      count_flag_seen=1
      ;;
    --max-results=*)
      ((count_flag_seen == 0)) || die "result count may be specified only once"
      requested_count="${arg#*=}"
      count_flag_seen=1
      ;;
    --pagination-token|--next-token|*pagination_token=*|*next_token=*)
      die "pagination tokens are blocked"
      ;;
    --app|--auth|-u|--username)
      ((index + 1 < ${#args[@]})) || die "$arg requires a value"
      index=$((index + 1))
      ;;
  esac
done

[[ -n "$command_name" ]] || die "unsupported or mutating xurl command"

case "$command_name" in
  read)
    resource_label="Post"
    mills_per_resource=$POST_COST_MILLS
    fixed_count=1
    ;;
  search|posts|timeline|mentions|bookmarks|likes)
    resource_label="Post"
    mills_per_resource=$POST_COST_MILLS
    fixed_count=0
    ;;
  whoami|user)
    resource_label="User"
    mills_per_resource=$USER_COST_MILLS
    fixed_count=1
    ;;
  following|followers)
    resource_label="User"
    mills_per_resource=$USER_COST_MILLS
    fixed_count=0
    ;;
  dms)
    resource_label="DM event"
    mills_per_resource=$DM_COST_MILLS
    fixed_count=0
    ;;
esac

if ((fixed_count == 1)); then
  ((count_flag_seen == 0)) || die "$command_name reads exactly one resource and does not accept a result count"
  requested_count=1
elif ((count_flag_seen == 0)); then
  # Some xurl shortcuts default above 10. Pin the count so a CLI update cannot
  # silently increase spend.
  requested_count=$DEFAULT_MAX
  args+=("-n" "$DEFAULT_MAX")
fi

[[ "$requested_count" =~ ^[1-9][0-9]*$ ]] || die "result count must be a positive integer"
((requested_count <= HARD_MAX)) || die "requested $requested_count results; the hard limit is $HARD_MAX to prevent automatic pagination"

max_cost="$(format_cost "$requested_count" "$mills_per_resource")"
if ((requested_count > DEFAULT_MAX)); then
  [[ "$approved_max" =~ ^[1-9][0-9]*$ ]] || die "requested $requested_count $resource_label results (maximum estimated cost $max_cost). Get fresh user confirmation, then rerun with --approved-max $requested_count"
  ((approved_max == requested_count)) || die "--approved-max must exactly match the requested count ($requested_count)"
  echo "APPROVED: up to $requested_count $resource_label results; maximum estimated cost $max_cost." >&2
elif [[ -n "$approved_max" ]]; then
  die "--approved-max is only valid for reads above $DEFAULT_MAX"
fi

if ((dry_run == 1)); then
  printf 'SAFE: up to %d %s results; maximum estimated cost %s; command:' "$requested_count" "$resource_label" "$max_cost"
  printf ' %q' xurl "${args[@]}"
  printf '\n'
  exit 0
fi

# The PATH-level agent shim sets XURL_REAL_BIN before delegating here. Using
# that resolved executable avoids recursing back into the shim while keeping
# direct guard invocations backward compatible on machines without the shim.
real_xurl="${XURL_REAL_BIN:-xurl}"
exec "$real_xurl" "${args[@]}"
