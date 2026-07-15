#!/usr/bin/env bash

# Shared packaging artifact helpers.
#
# The contract is intentionally simple:
# - repo dist/ keeps final human-facing app/zip/dmg/dSYM/appcast outputs
# - ~/Library/Caches/OpenClaw/build-artifacts keeps disposable staging and caches

openclaw_build_artifact_root() {
  printf '%s\n' "${OPENCLAW_BUILD_ARTIFACT_ROOT:-$HOME/Library/Caches/OpenClaw/build-artifacts}"
}

openclaw_build_safe_slug() {
  printf '%s' "${1:-openclaw}" | tr -cs '[:alnum:]._-' '-'
}

openclaw_build_run_root() {
  local label
  local root
  local timestamp

  label="$(openclaw_build_safe_slug "${1:-package}")"
  root="$(openclaw_build_artifact_root)"
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$root/runs"
  mktemp -d "$root/runs/${timestamp}-${label}-$$.XXXXXX"
}

openclaw_build_tmp_dir() {
  local run_root="$1"
  local label

  label="$(openclaw_build_safe_slug "${2:-tmp}")"
  mkdir -p "$run_root"
  mktemp -d "$run_root/${label}.XXXXXX"
}

openclaw_build_tmp_file() {
  local run_root="$1"
  local label

  label="$(openclaw_build_safe_slug "${2:-tmp}")"
  mkdir -p "$run_root"
  mktemp "$run_root/${label}.XXXXXX"
}

openclaw_build_disk_available_kib() {
  local target="$1"
  df -k "$target" 2>/dev/null | awk 'NR == 2 { print $4 }'
}

openclaw_build_human_kib() {
  local kib="$1"
  awk -v kib="${kib:-0}" 'BEGIN {
    if (kib >= 1024 * 1024) {
      printf "%.1fG", kib / 1024 / 1024
    } else if (kib >= 1024) {
      printf "%.0fM", kib / 1024
    } else {
      printf "%dK", kib
    }
  }'
}

openclaw_build_path_metadata() {
  local target="$1"

  # macOS and GNU stat spell the same fields differently. Keep this helper
  # portable because cleanup output must identify protected cache entries even
  # when their contents cannot be traversed by the current user.
  if stat -f 'owner=%Su:%Sg uid=%u mode=%Sp' "$target" >/dev/null 2>&1; then
    stat -f 'owner=%Su:%Sg uid=%u mode=%Sp' "$target"
  else
    stat -c 'owner=%U:%G uid=%u mode=%A' "$target" 2>/dev/null || printf '%s\n' 'owner=unknown uid=unknown mode=unknown'
  fi
}

openclaw_build_path_protected_file_flags_reason() {
  local target="$1"
  local flags
  local normalized_flags

  # macOS stat exposes chflags state as a comma-separated string via %Sf. GNU
  # stat rejects this invocation, which cleanly disables this check on Linux.
  flags="$(stat -f '%Sf' "$target" 2>/dev/null)" || return 1
  normalized_flags=",$(printf '%s' "$flags" | tr '[:space:]' ','),"

  # Accept both chflags names and the longer aliases BSD stat implementations
  # may emit. These flags can make rm partially mutate a tree before failing.
  case "$normalized_flags" in
    *,uchg,*|*,uimmutable,*|*,schg,*|*,simmutable,*|*,uappnd,*|*,uappend,*|*,sappnd,*|*,sappend,*)
      printf 'protected_flags=%s; %s; operator action: inspect and clear flags on this exact path only if confirmed disposable; cleanup will not clear file flags\n' \
        "$flags" "$(openclaw_build_path_metadata "$target")"
      return 0
      ;;
  esac

  return 1
}

openclaw_build_path_extended_acl_reason() {
  local target="$1"

  # The batched find -acl query has already proved an extended ACL exists. Keep
  # reporting read-only and narrow; cleanup never attempts chmod -N or rewrites
  # ACL entries because their ownership and intent require operator review.
  printf 'protected_acl=extended; %s; operator action: inspect and remove the ACL on this exact path only if confirmed disposable; cleanup will not alter ACLs\n' \
    "$(openclaw_build_path_metadata "$target")"
}

openclaw_build_path_permission_protection_reason() {
  local target="$1"
  local owner_uid
  local current_uid
  local metadata

  metadata="$(openclaw_build_path_metadata "$target")"
  current_uid="$(id -u)"
  if owner_uid="$(stat -f %u "$target" 2>/dev/null)"; then
    :
  else
    owner_uid="$(stat -c %u "$target" 2>/dev/null || true)"
  fi

  # A cache entry owned by another account is an ownership/provenance problem,
  # not permission cleanup. Never chmod, sudo, or try to delete it here.
  if [[ -z "$owner_uid" || "$owner_uid" != "$current_uid" ]]; then
    printf 'permission-protected; %s; operator action: ask the owning administrator to inspect and remove this exact stale cache path if disposable; do not change permissions recursively\n' "$metadata"
    return 0
  fi

  # Directories need read access to enumerate children and search access to
  # traverse them. Regular generated files only need read access; requiring an
  # executable bit would incorrectly protect every ordinary log file.
  if [[ -d "$target" && ( ! -r "$target" || ! -x "$target" ) ]]; then
    printf 'permission-protected; %s; operator action: inspect this exact cache path as its owner and remove it only if confirmed disposable; cleanup will not alter permissions\n' "$metadata"
    return 0
  fi
  if [[ ! -d "$target" && ! -r "$target" ]]; then
    printf 'permission-protected; %s; operator action: inspect this exact cache path as its owner and remove it only if confirmed disposable; cleanup will not alter permissions\n' "$metadata"
    return 0
  fi

  return 1
}

openclaw_build_tree_removal_protection_reason() {
  local target="$1"
  local target_parent
  local descendant_dir
  local protected_acl_path=""
  local protected_flags_path=""
  local protected_parent_acl_path=""
  local protection_reason

  if protection_reason="$(openclaw_build_path_permission_protection_reason "$target")"; then
    printf '%s\n' "$protection_reason"
    return 0
  fi

  target_parent="$(dirname "$target")"
  if [[ ! -w "$target_parent" || ! -x "$target_parent" ]]; then
    printf 'removal-protected parent=%s; %s; operator action: inspect this exact parent and candidate; cleanup will not alter permissions\n' \
      "$target_parent" "$(openclaw_build_path_metadata "$target_parent")"
    return 0
  fi

  # Deleting the candidate itself depends on its parent directory. A deny
  # delete_child ACL there can let rm erase candidate contents first, then fail
  # removing the now-empty candidate. Test the parent itself without descending.
  while IFS= read -r -d '' protected_parent_acl_path; do
    break
  done < <(find "$target_parent" -prune -acl -print0 2>/dev/null)
  if [[ -n "$protected_parent_acl_path" ]]; then
    protection_reason="$(openclaw_build_path_extended_acl_reason "$protected_parent_acl_path")"
    printf 'protected_parent=%s; %s\n' "$protected_parent_acl_path" "$protection_reason"
    return 0
  fi

  # BSD find evaluates file flags inside one traversal, avoiding a stat process
  # for every regular file. GNU find rejects -flags; stderr is suppressed and
  # an empty result safely bypasses this macOS-only protection on Linux.
  while IFS= read -r -d '' protected_flags_path; do
    break
  done < <(find "$target" -flags +uchg,schg,uappnd,sappnd -print0 -quit 2>/dev/null)
  if [[ -n "$protected_flags_path" ]]; then
    protection_reason="$(openclaw_build_path_protected_file_flags_reason "$protected_flags_path")"
    printf 'protected_descendant=%s; %s\n' "$protected_flags_path" "$protection_reason"
    return 0
  fi

  # BSD find also evaluates extended ACL presence in-process across the whole
  # candidate. GNU find rejects -acl, leaving the result empty and safely
  # bypassing this macOS-only guard without per-file subprocesses.
  while IFS= read -r -d '' protected_acl_path; do
    break
  done < <(find "$target" -acl -print0 -quit 2>/dev/null)
  if [[ -n "$protected_acl_path" ]]; then
    protection_reason="$(openclaw_build_path_extended_acl_reason "$protected_acl_path")"
    printf 'protected_descendant=%s; %s\n' "$protected_acl_path" "$protection_reason"
    return 0
  fi

  [[ -d "$target" ]] || return 1

  # rm -rf can delete accessible siblings before discovering a blocked nested
  # directory. Keep permission/removal validation on directories only; the
  # batched flag query above already covers every regular file.
  while IFS= read -r -d '' descendant_dir; do
    if protection_reason="$(openclaw_build_path_permission_protection_reason "$descendant_dir")"; then
      printf 'protected_descendant=%s; %s\n' "$descendant_dir" "$protection_reason"
      return 0
    fi
    if [[ ! -w "$descendant_dir" ]]; then
      printf 'removal-protected descendant=%s; %s; operator action: inspect this exact nested directory; cleanup will not alter permissions\n' \
        "$descendant_dir" "$(openclaw_build_path_metadata "$descendant_dir")"
      return 0
    fi
  done < <(find "$target" -type d -print0 2>/dev/null)

  # A second traversal captures errors that occur before find can emit a path.
  # No deletion happens if the complete tree cannot be enumerated reliably.
  if ! find "$target" -print0 >/dev/null 2>&1; then
    printf 'traversal-protected target=%s; %s; operator action: inspect inaccessible descendants; cleanup will not alter permissions\n' \
      "$target" "$(openclaw_build_path_metadata "$target")"
    return 0
  fi

  return 1
}

openclaw_build_path_has_retention_marker() {
  local target="$1"

  # Release operators can pin an in-progress or diagnostically useful staging
  # directory without moving it into durable dist/. These markers are explicit
  # and narrow; cleanup does not infer protection from arbitrary filenames.
  [[ -e "$target/.openclaw-active" || -e "$target/.openclaw-protected" ]]
}

openclaw_build_prune_old_runs() {
  local root="$1"
  local older_minutes="${2:-1440}"
  local deleted=0
  local run_dir

  [[ -d "$root/runs" ]] || {
    printf '%s\n' 0
    return 0
  }

  while IFS= read -r -d '' run_dir; do
    if openclaw_build_path_has_retention_marker "$run_dir"; then
      continue
    fi
    if openclaw_build_tree_removal_protection_reason "$run_dir" >/dev/null; then
      continue
    fi
    if rm -rf "$run_dir"; then
      deleted=$((deleted + 1))
    fi
  done < <(find "$root/runs" -mindepth 1 -maxdepth 1 -type d -mmin "+$older_minutes" -print0 2>/dev/null)

  printf '%s\n' "$deleted"
}

openclaw_build_prune_old_temp_artifacts() {
  local root="$1"
  local older_minutes="${2:-4320}"
  local deleted=0
  local bucket=""
  local artifact_dir=""

  for bucket in tmp temp smoke; do
    [[ -d "$root/$bucket" ]] || continue
    while IFS= read -r -d '' artifact_dir; do
      if openclaw_build_path_has_retention_marker "$artifact_dir"; then
        continue
      fi
      if openclaw_build_tree_removal_protection_reason "$artifact_dir" >/dev/null; then
        continue
      fi
      if rm -rf "$artifact_dir"; then
        deleted=$((deleted + 1))
      fi
    done < <(find "$root/$bucket" -mindepth 1 -maxdepth 1 -type d -mmin "+$older_minutes" -print0 2>/dev/null)
  done

  printf '%s\n' "$deleted"
}

openclaw_build_prune_empty_parents() {
  local root="$1"
  rmdir "$root/runs" "$root/tmp" "$root/temp" "$root/smoke" "$root" 2>/dev/null || true
}
