#!/usr/bin/env bash

# Sourceable disk-capacity gate for Jarvis release tooling.
#
# Public interface:
#   jarvis_release_disk_preflight <target-path> [required-kib]
#
# The default 25 GiB floor is deliberately much larger than the current final
# app/DMG/ZIP set. A full retry can temporarily hold the app bundle, universal
# build products, notarization archives, runtime staging, dSYMs, and final dist
# artifacts at once. The floor is capacity insurance, not an artifact estimate.

jarvis_release_disk_default_required_kib() {
  printf '%s\n' $((25 * 1024 * 1024))
}

jarvis_release_disk_existing_path() {
  local target="$1"

  # df needs an existing path. Release callers often preflight a dist/ or cache
  # directory before creating it, so walk upward without mutating the filesystem.
  while [[ ! -e "$target" && "$target" != "/" ]]; do
    target="$(dirname "$target")"
  done
  printf '%s\n' "$target"
}

jarvis_release_disk_available_kib() {
  local target="$1"
  local existing_path

  # This override is intentionally numeric-only and exists so shell fixtures
  # can prove low-space behavior without filling or mounting a test volume.
  if [[ -n "${JARVIS_RELEASE_DISK_AVAILABLE_KIB_OVERRIDE:-}" ]]; then
    printf '%s\n' "$JARVIS_RELEASE_DISK_AVAILABLE_KIB_OVERRIDE"
    return 0
  fi

  existing_path="$(jarvis_release_disk_existing_path "$target")"
  df -Pk "$existing_path" 2>/dev/null | awk 'NR == 2 { print $4 }'
}

jarvis_release_disk_kib_to_gib() {
  awk -v kib="${1:-0}" 'BEGIN { printf "%.2f", kib / 1024 / 1024 }'
}

jarvis_release_disk_is_nonnegative_integer() {
  [[ "${1:-}" =~ ^(0|[1-9][0-9]*)$ ]]
}

jarvis_release_disk_is_positive_integer() {
  [[ "${1:-}" =~ ^[1-9][0-9]*$ ]]
}

jarvis_release_disk_preflight() {
  local target="${1:-.}"
  local required_kib="${2:-${JARVIS_RELEASE_DISK_REQUIRED_KIB:-$(jarvis_release_disk_default_required_kib)}}"
  local free_kib
  local shortfall_kib=0

  if ! jarvis_release_disk_is_positive_integer "$required_kib"; then
    printf 'ERROR: required disk capacity must be a positive integer in KiB; got %s\n' "$required_kib" >&2
    return 2
  fi

  free_kib="$(jarvis_release_disk_available_kib "$target" || true)"
  if ! jarvis_release_disk_is_nonnegative_integer "$free_kib"; then
    printf 'ERROR: could not determine available disk capacity for %s\n' "$target" >&2
    return 2
  fi

  if ((free_kib < required_kib)); then
    shortfall_kib=$((required_kib - free_kib))
  fi

  # Stable key=value lines make the gate useful both to humans and future
  # release wrappers without forcing callers to scrape decorative prose.
  printf 'target=%s\n' "$target"
  printf 'required_kib=%s\n' "$required_kib"
  printf 'required_gib=%s\n' "$(jarvis_release_disk_kib_to_gib "$required_kib")"
  printf 'free_kib=%s\n' "$free_kib"
  printf 'free_gib=%s\n' "$(jarvis_release_disk_kib_to_gib "$free_kib")"
  printf 'shortfall_kib=%s\n' "$shortfall_kib"
  printf 'shortfall_gib=%s\n' "$(jarvis_release_disk_kib_to_gib "$shortfall_kib")"

  if ((shortfall_kib > 0)); then
    printf 'status=fail\n'
    printf 'next_operator_action=free disk space or run the conservative build-artifact cleanup report, then rerun this preflight before packaging\n'
    return 1
  fi

  printf 'status=pass\n'
  return 0
}
