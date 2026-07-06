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

openclaw_prune_bundled_node_modules_development_payloads() {
  local node_modules_dir="$1"

  if [[ ! -d "$node_modules_dir" ]]; then
    return 0
  fi

  local removed_count=0
  local removed_kib=0
  local candidate=""

  # Production npm packages often ship tests, examples, docs, and benchmarks.
  # Jarvis does not execute those paths at runtime, and this function only runs
  # against already-materialized bundled node_modules trees inside the app. Keep
  # the prune narrow so package code, native binaries, types, and package
  # metadata remain intact.
  while IFS= read -r -d '' candidate; do
    local candidate_kib
    candidate_kib="$(du -sk "$candidate" 2>/dev/null | awk '{print $1}')"
    removed_kib=$((removed_kib + ${candidate_kib:-0}))
    rm -rf "$candidate"
    removed_count=$((removed_count + 1))
  done < <(find "$node_modules_dir" -type d \( \
    -name docs -o \
    -name doc -o \
    -name test -o \
    -name tests -o \
    -name __tests__ -o \
    -name example -o \
    -name examples -o \
    -name benchmark -o \
    -name benchmarks \
  \) -prune -print0)

  if [[ "$removed_count" -gt 0 ]]; then
    echo "Pruned bundled node_modules development payloads: ${removed_count} directories, ${removed_kib} KiB ($node_modules_dir)"
  fi
}

openclaw_dedupe_bundled_dist_assets() {
  local dist_dir="$1"
  local root_assets="$dist_dir/assets"
  local plugin_sdk_assets="$dist_dir/plugin-sdk/assets"

  if [[ ! -d "$root_assets" || ! -d "$plugin_sdk_assets" ]]; then
    return 0
  fi

  # The plugin SDK build can carry a second copy of the same emitted assets.
  # Keep the compatibility path as a symlink so any runtime code that resolves
  # dist/plugin-sdk/assets still reaches the canonical dist/assets payload.
  if ! diff -qr "$root_assets" "$plugin_sdk_assets" >/dev/null; then
    echo "WARN: bundled dist/plugin-sdk/assets differs from dist/assets; keeping both asset trees." >&2
    return 0
  fi

  local asset_kib
  asset_kib="$(du -sk "$plugin_sdk_assets" 2>/dev/null | awk '{print $1}')"
  rm -rf "$plugin_sdk_assets"
  ln -s ../assets "$plugin_sdk_assets"
  echo "Pruned duplicate bundled plugin SDK assets: ${asset_kib:-unknown} KiB ($plugin_sdk_assets -> ../assets)"
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
