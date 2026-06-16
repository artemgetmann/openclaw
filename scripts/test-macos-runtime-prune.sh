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

test_fails_when_required_macos_triplet_missing() {
  local node_modules_dir="$TMP_DIR/missing-macos-node-modules"

  make_koffi_triplet "$node_modules_dir" darwin_arm64
  make_koffi_triplet "$node_modules_dir" linux_x64

  if openclaw_prune_bundled_koffi_non_macos "$node_modules_dir" >/dev/null 2>&1; then
    fail "expected missing darwin_x64 addon to fail"
  fi

  pass "fails when required macOS Koffi triplet is missing"
}

test_prunes_only_non_macos_triplets
test_noops_when_koffi_absent
test_fails_when_required_macos_triplet_missing
