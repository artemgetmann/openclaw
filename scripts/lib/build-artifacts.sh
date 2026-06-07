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
    rm -rf "$run_dir"
    deleted=$((deleted + 1))
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
      rm -rf "$artifact_dir"
      deleted=$((deleted + 1))
    done < <(find "$root/$bucket" -mindepth 1 -maxdepth 1 -type d -mmin "+$older_minutes" -print0 2>/dev/null)
  done

  printf '%s\n' "$deleted"
}

openclaw_build_prune_empty_parents() {
  local root="$1"
  rmdir "$root/runs" "$root/tmp" "$root/temp" "$root/smoke" "$root" 2>/dev/null || true
}
