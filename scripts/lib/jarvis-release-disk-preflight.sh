#!/usr/bin/env bash

# Sourceable multi-filesystem capacity gate for Jarvis release tooling.
#
# Public interfaces:
#   jarvis_release_disk_preflight_targets <required-kib> <label> <path> [<label> <path> ...]
#   jarvis_release_disk_preflight <target-path> [required-kib]  # compatibility
#
# The default 25 GiB floor is capacity insurance for the full release lane, not
# an artifact estimate. Each distinct filesystem holding release output or
# heavy staging must independently satisfy that floor. Multiple targets on one
# filesystem are checked once so the same free space is never double-counted.

jarvis_release_disk_default_required_kib() {
  printf '%s\n' $((25 * 1024 * 1024))
}

jarvis_release_disk_existing_path() {
  local target="${1:-}"

  [[ -n "$target" ]] || return 1

  # df/stat need an existing path. A not-yet-created dist/ or staging directory
  # belongs to its nearest existing ancestor's filesystem, so resolve upward
  # without mutating the filesystem. Failure to reach an existing path is fatal.
  while [[ ! -e "$target" && "$target" != "/" && "$target" != "." ]]; do
    target="$(dirname "$target")"
  done
  [[ -e "$target" ]] || return 1
  printf '%s\n' "$target"
}

jarvis_release_disk_is_nonnegative_integer() {
  [[ "${1:-}" =~ ^(0|[1-9][0-9]*)$ ]]
}

jarvis_release_disk_is_positive_integer() {
  [[ "${1:-}" =~ ^[1-9][0-9]*$ ]]
}

jarvis_release_disk_kib_to_gib() {
  awk -v kib="${1:-0}" 'BEGIN { printf "%.2f", kib / 1024 / 1024 }'
}

jarvis_release_disk_probe_target() {
  local target="$1"
  local existing_path
  local filesystem_id
  local df_output
  local filesystem_mount
  local free_kib

  # Test-only seam for deterministic multi-volume fixtures. The executable
  # prints: filesystem-id<TAB>mount<TAB>free-kib<TAB>resolved-path.
  if [[ -n "${JARVIS_RELEASE_DISK_PROBE_COMMAND:-}" ]]; then
    [[ -x "$JARVIS_RELEASE_DISK_PROBE_COMMAND" ]] || return 1
    "$JARVIS_RELEASE_DISK_PROBE_COMMAND" "$target"
    return $?
  fi

  existing_path="$(jarvis_release_disk_existing_path "$target")" || return 1
  if filesystem_id="$(stat -f %d "$existing_path" 2>/dev/null)"; then
    :
  else
    filesystem_id="$(stat -c %d "$existing_path" 2>/dev/null)" || return 1
  fi

  # POSIX df guarantees one record per filesystem. Rebuild fields 6+ so mount
  # paths containing spaces remain intact instead of being truncated to $NF.
  df_output="$(df -Pk "$existing_path" 2>/dev/null | awk 'NR == 2 {
    free = $4
    $1 = $2 = $3 = $4 = $5 = ""
    sub(/^[[:space:]]+/, "")
    printf "%s\t%s", free, $0
  }')"
  [[ -n "$df_output" ]] || return 1
  IFS=$'\t' read -r free_kib filesystem_mount <<<"$df_output"

  if [[ -n "${JARVIS_RELEASE_DISK_AVAILABLE_KIB_OVERRIDE:-}" ]]; then
    free_kib="$JARVIS_RELEASE_DISK_AVAILABLE_KIB_OVERRIDE"
  fi

  jarvis_release_disk_is_nonnegative_integer "$free_kib" || return 1
  [[ -n "$filesystem_id" && -n "$filesystem_mount" ]] || return 1
  printf '%s\t%s\t%s\t%s\n' "$filesystem_id" "$filesystem_mount" "$free_kib" "$existing_path"
}

jarvis_release_disk_preflight_targets() {
  local required_kib="${1:-}"
  local label
  local target
  local probe_output
  local filesystem_id
  local filesystem_mount
  local free_kib
  local resolved_path
  local duplicate_index
  local target_index=0
  local filesystem_index
  local i
  local shortfall_kib
  local overall_status=0
  local -a filesystem_ids=()
  local -a filesystem_mounts=()
  local -a filesystem_free_kib=()
  local -a filesystem_labels=()
  local -a filesystem_targets=()
  local -a filesystem_resolved_paths=()

  shift || true
  if ! jarvis_release_disk_is_positive_integer "$required_kib"; then
    printf 'ERROR: required disk capacity must be a positive integer in KiB; got %s\n' "$required_kib" >&2
    return 2
  fi
  if [[ $# -lt 2 || $(( $# % 2 )) -ne 0 ]]; then
    printf 'ERROR: disk preflight requires one or more <label> <path> target pairs\n' >&2
    return 2
  fi

  while [[ $# -gt 0 ]]; do
    label="$1"
    target="$2"
    shift 2
    target_index=$((target_index + 1))

    if [[ -z "$label" || -z "$target" ]]; then
      printf 'target[%s].status=error\n' "$target_index"
      printf 'target[%s].reason=label-and-path-must-be-nonempty\n' "$target_index"
      printf 'status=fail\n'
      return 2
    fi

    probe_output="$(jarvis_release_disk_probe_target "$target")" || {
      printf 'target[%s].label=%s\n' "$target_index" "$label"
      printf 'target[%s].path=%s\n' "$target_index" "$target"
      printf 'target[%s].status=error\n' "$target_index"
      printf 'target[%s].reason=filesystem-resolution-failed\n' "$target_index"
      printf 'status=fail\n'
      return 2
    }
    IFS=$'\t' read -r filesystem_id filesystem_mount free_kib resolved_path <<<"$probe_output"
    if [[ -z "$filesystem_id" || -z "$filesystem_mount" || -z "$resolved_path" ]] || ! jarvis_release_disk_is_nonnegative_integer "$free_kib"; then
      printf 'target[%s].label=%s\n' "$target_index" "$label"
      printf 'target[%s].path=%s\n' "$target_index" "$target"
      printf 'target[%s].status=error\n' "$target_index"
      printf 'target[%s].reason=invalid-filesystem-probe-output\n' "$target_index"
      printf 'status=fail\n'
      return 2
    fi

    duplicate_index=-1
    i=0
    while ((i < ${#filesystem_ids[@]})); do
      if [[ "${filesystem_ids[$i]}" == "$filesystem_id" ]]; then
        duplicate_index="$i"
        break
      fi
      i=$((i + 1))
    done

    if ((duplicate_index >= 0)); then
      filesystem_index=$((duplicate_index + 1))
      filesystem_labels[$duplicate_index]="${filesystem_labels[$duplicate_index]},$label"
      filesystem_targets[$duplicate_index]="${filesystem_targets[$duplicate_index]},$target"
      filesystem_resolved_paths[$duplicate_index]="${filesystem_resolved_paths[$duplicate_index]},$resolved_path"
      # Free space can change between probes; retain the lower observation.
      if ((free_kib < filesystem_free_kib[$duplicate_index])); then
        filesystem_free_kib[$duplicate_index]="$free_kib"
      fi
      printf 'target[%s].deduplicated=true\n' "$target_index"
    else
      filesystem_ids[${#filesystem_ids[@]}]="$filesystem_id"
      i=$((${#filesystem_ids[@]} - 1))
      filesystem_mounts[$i]="$filesystem_mount"
      filesystem_free_kib[$i]="$free_kib"
      filesystem_labels[$i]="$label"
      filesystem_targets[$i]="$target"
      filesystem_resolved_paths[$i]="$resolved_path"
      filesystem_index=$((i + 1))
      printf 'target[%s].deduplicated=false\n' "$target_index"
    fi

    printf 'target[%s].label=%s\n' "$target_index" "$label"
    printf 'target[%s].path=%s\n' "$target_index" "$target"
    printf 'target[%s].resolved_path=%s\n' "$target_index" "$resolved_path"
    printf 'target[%s].filesystem_id=%s\n' "$target_index" "$filesystem_id"
    printf 'target[%s].filesystem_mount=%s\n' "$target_index" "$filesystem_mount"
    printf 'target[%s].filesystem_index=%s\n' "$target_index" "$filesystem_index"
    printf 'target[%s].status=resolved\n' "$target_index"
  done

  i=0
  while ((i < ${#filesystem_ids[@]})); do
    filesystem_index=$((i + 1))
    free_kib="${filesystem_free_kib[$i]}"
    shortfall_kib=0
    if ((free_kib < required_kib)); then
      shortfall_kib=$((required_kib - free_kib))
      overall_status=1
    fi

    printf 'filesystem[%s].id=%s\n' "$filesystem_index" "${filesystem_ids[$i]}"
    printf 'filesystem[%s].mount=%s\n' "$filesystem_index" "${filesystem_mounts[$i]}"
    printf 'filesystem[%s].labels=%s\n' "$filesystem_index" "${filesystem_labels[$i]}"
    printf 'filesystem[%s].targets=%s\n' "$filesystem_index" "${filesystem_targets[$i]}"
    printf 'filesystem[%s].resolved_paths=%s\n' "$filesystem_index" "${filesystem_resolved_paths[$i]}"
    printf 'filesystem[%s].required_kib=%s\n' "$filesystem_index" "$required_kib"
    printf 'filesystem[%s].required_gib=%s\n' "$filesystem_index" "$(jarvis_release_disk_kib_to_gib "$required_kib")"
    printf 'filesystem[%s].free_kib=%s\n' "$filesystem_index" "$free_kib"
    printf 'filesystem[%s].free_gib=%s\n' "$filesystem_index" "$(jarvis_release_disk_kib_to_gib "$free_kib")"
    printf 'filesystem[%s].shortfall_kib=%s\n' "$filesystem_index" "$shortfall_kib"
    printf 'filesystem[%s].shortfall_gib=%s\n' "$filesystem_index" "$(jarvis_release_disk_kib_to_gib "$shortfall_kib")"
    if ((shortfall_kib > 0)); then
      printf 'filesystem[%s].status=fail\n' "$filesystem_index"
    else
      printf 'filesystem[%s].status=pass\n' "$filesystem_index"
    fi
    i=$((i + 1))
  done

  printf 'targets_checked=%s\n' "$target_index"
  printf 'filesystems_checked=%s\n' "${#filesystem_ids[@]}"
  if [[ "$overall_status" -ne 0 ]]; then
    printf 'status=fail\n'
    printf 'next_operator_action=free disk space on every failed filesystem, then rerun this preflight before packaging\n'
    return 1
  fi

  printf 'status=pass\n'
  return 0
}

jarvis_release_disk_preflight() {
  local target="${1:-.}"
  local required_kib="${2:-${JARVIS_RELEASE_DISK_REQUIRED_KIB:-$(jarvis_release_disk_default_required_kib)}}"
  jarvis_release_disk_preflight_targets "$required_kib" target "$target"
}
