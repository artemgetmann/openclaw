#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/macos-runtime-prune.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "PASS: $*"
}

make_koffi_triplet() {
  local node_modules_dir="$1"
  local triplet="$2"
  local triplet_dir="$node_modules_dir/koffi/build/koffi/$triplet"

  mkdir -p "$triplet_dir"
  printf 'fake native addon for %s\n' "$triplet" >"$triplet_dir/koffi.node"
}

test_prunes_only_non_macos_triplets() {
  local node_modules_dir="$TMP_DIR/node_modules"

  make_koffi_triplet "$node_modules_dir" darwin_arm64
  make_koffi_triplet "$node_modules_dir" darwin_x64
  make_koffi_triplet "$node_modules_dir" linux_x64
  make_koffi_triplet "$node_modules_dir" win32_x64

  openclaw_prune_bundled_koffi_non_macos "$node_modules_dir"

  [[ -f "$node_modules_dir/koffi/build/koffi/darwin_arm64/koffi.node" ]] || fail "darwin_arm64 addon was pruned"
  [[ -f "$node_modules_dir/koffi/build/koffi/darwin_x64/koffi.node" ]] || fail "darwin_x64 addon was pruned"
  [[ ! -e "$node_modules_dir/koffi/build/koffi/linux_x64" ]] || fail "linux_x64 addon was kept"
  [[ ! -e "$node_modules_dir/koffi/build/koffi/win32_x64" ]] || fail "win32_x64 addon was kept"

  pass "prunes only non-macOS Koffi triplets"
}

test_noops_when_koffi_absent() {
  local node_modules_dir="$TMP_DIR/no-koffi-node-modules"

  mkdir -p "$node_modules_dir"
  openclaw_prune_bundled_koffi_non_macos "$node_modules_dir"

  pass "noops when Koffi is absent"
}

test_prunes_pnpm_virtual_store_koffi() {
  local node_modules_dir="$TMP_DIR/pnpm-node-modules"
  local koffi_pkg_dir="$node_modules_dir/.pnpm/koffi@2.15.1/node_modules"

  make_koffi_triplet "$koffi_pkg_dir" darwin_arm64
  make_koffi_triplet "$koffi_pkg_dir" darwin_x64
  make_koffi_triplet "$koffi_pkg_dir" linux_arm64
  make_koffi_triplet "$koffi_pkg_dir" openbsd_x64

  openclaw_prune_bundled_koffi_non_macos "$node_modules_dir"

  [[ -f "$koffi_pkg_dir/koffi/build/koffi/darwin_arm64/koffi.node" ]] || fail "pnpm darwin_arm64 addon was pruned"
  [[ -f "$koffi_pkg_dir/koffi/build/koffi/darwin_x64/koffi.node" ]] || fail "pnpm darwin_x64 addon was pruned"
  [[ ! -e "$koffi_pkg_dir/koffi/build/koffi/linux_arm64" ]] || fail "pnpm linux_arm64 addon was kept"
  [[ ! -e "$koffi_pkg_dir/koffi/build/koffi/openbsd_x64" ]] || fail "pnpm openbsd_x64 addon was kept"

  pass "prunes pnpm virtual-store Koffi triplets"
}

test_fails_when_required_macos_triplet_missing() {
  local node_modules_dir="$TMP_DIR/missing-macos-node-modules"

  make_koffi_triplet "$node_modules_dir" darwin_arm64
  make_koffi_triplet "$node_modules_dir" linux_x64

  if openclaw_prune_bundled_koffi_non_macos "$node_modules_dir" >/dev/null 2>&1; then
    fail "expected missing darwin_x64 addon to fail"
  fi

  pass "fails when required macOS Koffi triplet is missing"
}

test_prunes_node_modules_development_payloads() {
  local node_modules_dir="$TMP_DIR/dev-payload-node-modules"

  mkdir -p "$node_modules_dir/pkg/docs" \
    "$node_modules_dir/pkg/dist/doc" \
    "$node_modules_dir/pkg/src" \
    "$node_modules_dir/pkg/test" \
    "$node_modules_dir/pkg/examples" \
    "$node_modules_dir/pkg/benchmarks" \
    "$node_modules_dir/unknown/docs" \
    "$node_modules_dir/upgraded/docs" \
    "$node_modules_dir/exported/dist/esm/examples"
  printf 'runtime code\n' >"$node_modules_dir/pkg/src/index.js"
  printf '{"name":"pino","version":"9.14.0"}\n' >"$node_modules_dir/pkg/package.json"
  printf 'runtime module\n' >"$node_modules_dir/pkg/dist/doc/Document.js"
  printf 'notes\n' >"$node_modules_dir/pkg/docs/readme.md"
  printf 'spec\n' >"$node_modules_dir/pkg/test/spec.js"
  printf 'sample\n' >"$node_modules_dir/pkg/examples/sample.js"
  printf 'bench\n' >"$node_modules_dir/pkg/benchmarks/bench.js"
  printf '{"name":"unknown-package"}\n' >"$node_modules_dir/unknown/package.json"
  printf 'keep me\n' >"$node_modules_dir/unknown/docs/runtime.txt"
  printf '{"name":"pino","version":"99.0.0"}\n' >"$node_modules_dir/upgraded/package.json"
  printf 'reaudit me\n' >"$node_modules_dir/upgraded/docs/runtime.txt"
  printf '{"type":"module"}\n' >"$node_modules_dir/exported/dist/esm/package.json"
  printf 'exported runtime\n' >"$node_modules_dir/exported/dist/esm/examples/runtime.js"

  openclaw_prune_bundled_node_modules_development_payloads "$node_modules_dir"

  [[ -f "$node_modules_dir/pkg/src/index.js" ]] || fail "runtime source was pruned"
  [[ -f "$node_modules_dir/pkg/package.json" ]] || fail "package metadata was pruned"
  [[ -f "$node_modules_dir/pkg/dist/doc/Document.js" ]] || fail "nested runtime doc directory was pruned"
  [[ -f "$node_modules_dir/unknown/docs/runtime.txt" ]] || fail "unknown package docs were pruned"
  [[ -f "$node_modules_dir/upgraded/docs/runtime.txt" ]] || fail "unaudited package version docs were pruned"
  [[ -f "$node_modules_dir/exported/dist/esm/examples/runtime.js" ]] || fail "exported runtime examples were pruned"
  [[ ! -e "$node_modules_dir/pkg/docs" ]] || fail "docs payload was kept"
  [[ ! -e "$node_modules_dir/pkg/test" ]] || fail "test payload was kept"
  [[ ! -e "$node_modules_dir/pkg/examples" ]] || fail "examples payload was kept"
  [[ ! -e "$node_modules_dir/pkg/benchmarks" ]] || fail "benchmarks payload was kept"

  pass "prunes node_modules development payloads"
}

test_dedupes_identical_plugin_sdk_assets() {
  local dist_dir="$TMP_DIR/duplicate-assets-dist"

  mkdir -p "$dist_dir/assets/nested" "$dist_dir/plugin-sdk/assets/nested"
  printf 'native bytes\n' >"$dist_dir/assets/matrix-sdk-crypto.darwin-arm64.node"
  printf 'native bytes\n' >"$dist_dir/plugin-sdk/assets/matrix-sdk-crypto.darwin-arm64.node"
  printf 'asset\n' >"$dist_dir/assets/nested/chunk.js"
  printf 'asset\n' >"$dist_dir/plugin-sdk/assets/nested/chunk.js"

  openclaw_dedupe_bundled_dist_assets "$dist_dir"

  [[ -L "$dist_dir/plugin-sdk/assets" ]] || fail "plugin SDK assets were not replaced by a symlink"
  [[ "$(readlink "$dist_dir/plugin-sdk/assets")" == "../assets" ]] || fail "plugin SDK assets symlink target is wrong"
  [[ -f "$dist_dir/plugin-sdk/assets/nested/chunk.js" ]] || fail "symlinked plugin SDK asset is unreadable"
  [[ -f "$dist_dir/assets/matrix-sdk-crypto.darwin-arm64.node" ]] || fail "canonical asset was pruned"

  pass "dedupes identical plugin SDK assets"
}

test_keeps_different_plugin_sdk_assets() {
  local dist_dir="$TMP_DIR/different-assets-dist"

  mkdir -p "$dist_dir/assets" "$dist_dir/plugin-sdk/assets"
  printf 'canonical\n' >"$dist_dir/assets/chunk.js"
  printf 'plugin-specific\n' >"$dist_dir/plugin-sdk/assets/chunk.js"

  openclaw_dedupe_bundled_dist_assets "$dist_dir"

  [[ ! -L "$dist_dir/plugin-sdk/assets" ]] || fail "different plugin SDK assets were symlinked"
  [[ -f "$dist_dir/plugin-sdk/assets/chunk.js" ]] || fail "different plugin SDK asset was pruned"
  [[ "$(cat "$dist_dir/plugin-sdk/assets/chunk.js")" == "plugin-specific" ]] || fail "different plugin SDK asset content changed"

  pass "keeps different plugin SDK assets"
}

test_prune_helper_participates_in_runtime_cache_key() {
  if ! grep -Fq 'hash_consumer_runtime_path "scripts/lib/macos-runtime-prune.sh"' \
    "$ROOT_DIR/scripts/package-mac-app.sh"; then
    fail "macOS runtime prune helper is missing from the consumer runtime cache key"
  fi

  pass "includes prune helper in runtime cache key"
}

test_prunes_only_non_macos_triplets
test_noops_when_koffi_absent
test_prunes_pnpm_virtual_store_koffi
test_fails_when_required_macos_triplet_missing
test_prunes_node_modules_development_payloads
test_dedupes_identical_plugin_sdk_assets
test_keeps_different_plugin_sdk_assets
test_prune_helper_participates_in_runtime_cache_key
