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

  # Read and search access are both required for trustworthy sizing and a
  # complete recursive delete. Skipping early prevents partial cleanup and the
  # misleading 0K reports produced by a suppressed du error.
  if [[ ! -r "$target" || ! -x "$target" ]]; then
    printf 'permission-protected; %s; operator action: inspect this exact cache path as its owner and remove it only if confirmed disposable; cleanup will not alter permissions\n' "$metadata"
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
    if openclaw_build_path_permission_protection_reason "$run_dir" >/dev/null; then
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
      if openclaw_build_path_permission_protection_reason "$artifact_dir" >/dev/null; then
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
