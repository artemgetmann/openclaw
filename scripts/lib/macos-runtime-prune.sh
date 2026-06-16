#!/usr/bin/env bash

# Shared pruning helpers for the bundled macOS runtime. These functions only
# remove files after production dependencies have been materialized into the app
# bundle, so the repo install and pnpm lockfile stay untouched.

openclaw_prune_bundled_koffi_non_macos() {
  local node_modules_dir="$1"
  local koffi_build_dirs=()
  local koffi_build_dir=""
  local pnpm_koffi_dir=""

  # pnpm deploy materializes packages under node_modules/.pnpm and exposes
  # symlinks only for direct dependency edges. Koffi is transitive in the Jarvis
  # runtime, so scan the virtual-store package root instead of assuming
  # node_modules/koffi exists.
  if [[ -d "$node_modules_dir/koffi/build/koffi" ]]; then
    koffi_build_dirs+=("$node_modules_dir/koffi/build/koffi")
  fi
  if [[ -d "$node_modules_dir/.pnpm" ]]; then
    while IFS= read -r -d '' pnpm_koffi_dir; do
      koffi_build_dir="$pnpm_koffi_dir/node_modules/koffi/build/koffi"
      if [[ -d "$koffi_build_dir" ]]; then
        koffi_build_dirs+=("$koffi_build_dir")
      fi
    done < <(find "$node_modules_dir/.pnpm" -mindepth 1 -maxdepth 1 -type d -name 'koffi@*' -print0)
  fi

  # Koffi is a transitive native dependency. Some installs may not include it,
  # so absence is not an error for packaging variants that never deployed it.
  if [[ "${#koffi_build_dirs[@]}" -eq 0 ]]; then
    return 0
  fi

  for koffi_build_dir in "${koffi_build_dirs[@]}"; do
    openclaw_prune_koffi_build_dir_non_macos "$koffi_build_dir"
  done
}

openclaw_prune_koffi_build_dir_non_macos() {
  local koffi_build_dir="$1"

  # Jarvis ships a universal macOS app. Keep both macOS triplets so Intel and
  # Apple Silicon launches resolve the native addon through Koffi's own loader.
  local required_triplet=""
  for required_triplet in darwin_arm64 darwin_x64; do
    if [[ ! -f "$koffi_build_dir/$required_triplet/koffi.node" ]]; then
      echo "ERROR: bundled Koffi runtime is missing required macOS addon: $koffi_build_dir/$required_triplet/koffi.node" >&2
      return 1
    fi
  done

  local removed_count=0
  local removed_kib=0
  local triplet_dir=""
  while IFS= read -r -d '' triplet_dir; do
    case "$(basename "$triplet_dir")" in
      darwin_arm64|darwin_x64)
        continue
        ;;
    esac

    # du reports KiB portably here; exact byte accounting happens in the release
    # size reporter after packaging. This log is just operator feedback.
    local triplet_kib
    triplet_kib="$(du -sk "$triplet_dir" 2>/dev/null | awk '{print $1}')"
    removed_kib=$((removed_kib + ${triplet_kib:-0}))
    rm -rf "$triplet_dir"
    removed_count=$((removed_count + 1))
  done < <(find "$koffi_build_dir" -mindepth 1 -maxdepth 1 -type d -print0)

  if [[ "$removed_count" -gt 0 ]]; then
    echo "Pruned bundled Koffi non-macOS native payloads: ${removed_count} triplets, ${removed_kib} KiB ($koffi_build_dir)"
  fi
}
