#!/usr/bin/env bash

# Shared guardrails for the Jarvis macOS release lane.
#
# These helpers deliberately avoid writing repo-tracked files. The prewarm
# proof lives under Git's per-worktree metadata directory, so a clean release
# checkout stays clean while still carrying durable local warmup evidence.

openclaw_macos_release_sha256_file() {
  local file_path="$1"

  if [[ ! -f "$file_path" ]]; then
    printf '%s\n' "missing"
    return 0
  fi

  /usr/bin/shasum -a 256 "$file_path" | /usr/bin/awk '{ print $1 }'
}

openclaw_macos_release_head() {
  local root="$1"
  git -C "$root" rev-parse HEAD
}

openclaw_macos_prewarm_proof_path() {
  local root="$1"
  local proof_path

  proof_path="$(git -C "$root" rev-parse --git-path openclaw/prewarm-macos.env)"
  if [[ "$proof_path" != /* ]]; then
    proof_path="$root/$proof_path"
  fi
  printf '%s\n' "$proof_path"
}

openclaw_macos_package_resolved_sha256() {
  local root="$1"
  openclaw_macos_release_sha256_file "$root/apps/macos/Package.resolved"
}

openclaw_macos_pnpm_lock_sha256() {
  local root="$1"
  openclaw_macos_release_sha256_file "$root/pnpm-lock.yaml"
}

openclaw_write_macos_prewarm_proof() {
  local root="$1"
  local proof_path proof_tmp
  local node_version swift_version

  proof_path="$(openclaw_macos_prewarm_proof_path "$root")"
  mkdir -p "$(dirname "$proof_path")"
  proof_tmp="${proof_path}.$$"

  node_version="$(node --version 2>/dev/null || printf '%s\n' "unknown")"
  swift_version="$(swift --version 2>/dev/null | /usr/bin/head -n 1 || printf '%s\n' "unknown")"

  {
    printf 'PREWARM_KIND=%q\n' "macos"
    printf 'PREWARM_HEAD=%q\n' "$(openclaw_macos_release_head "$root")"
    printf 'PREWARM_NODE_VERSION=%q\n' "$node_version"
    printf 'PREWARM_SWIFT_VERSION=%q\n' "$swift_version"
    printf 'PREWARM_PNPM_LOCK_SHA256=%q\n' "$(openclaw_macos_pnpm_lock_sha256 "$root")"
    printf 'PREWARM_PACKAGE_RESOLVED_SHA256=%q\n' "$(openclaw_macos_package_resolved_sha256 "$root")"
    printf 'PREWARM_CREATED_AT=%q\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  } >"$proof_tmp"

  mv "$proof_tmp" "$proof_path"
  echo "prewarm_proof=$proof_path"
}

openclaw_release_env_value() {
  local file_path="$1"
  local key="$2"

  if [[ ! -f "$file_path" ]]; then
    printf '%s\n' ""
    return 0
  fi

  /usr/bin/sed -n "s/^${key}=//p" "$file_path" | /usr/bin/head -n 1
}

openclaw_validate_macos_prewarm_proof() {
  local root="$1"
  local proof_path
  local expected_head expected_pnpm_hash expected_package_hash
  local proof_kind proof_head proof_pnpm_hash proof_package_hash
  local failed=0

  proof_path="$(openclaw_macos_prewarm_proof_path "$root")"
  if [[ ! -f "$proof_path" ]]; then
    echo "macos_prewarm_proof=missing"
    echo "macos_prewarm_proof_path=$proof_path"
    return 1
  fi

  expected_head="$(openclaw_macos_release_head "$root")"
  expected_pnpm_hash="$(openclaw_macos_pnpm_lock_sha256 "$root")"
  expected_package_hash="$(openclaw_macos_package_resolved_sha256 "$root")"

  proof_kind="$(openclaw_release_env_value "$proof_path" "PREWARM_KIND")"
  proof_head="$(openclaw_release_env_value "$proof_path" "PREWARM_HEAD")"
  proof_pnpm_hash="$(openclaw_release_env_value "$proof_path" "PREWARM_PNPM_LOCK_SHA256")"
  proof_package_hash="$(openclaw_release_env_value "$proof_path" "PREWARM_PACKAGE_RESOLVED_SHA256")"

  # The release build spends most of its time after dependency resolution. Make
  # the cheap identity checks exact, so stale worktrees fail before they burn
  # another notarization-sized chunk of time.
  if [[ "$proof_kind" != "macos" ]]; then
    echo "macos_prewarm_kind=${proof_kind:-missing}"
    failed=1
  fi
  if [[ "$proof_head" != "$expected_head" ]]; then
    echo "macos_prewarm_head=${proof_head:-missing}"
    echo "current_head=$expected_head"
    failed=1
  fi
  if [[ "$proof_pnpm_hash" != "$expected_pnpm_hash" ]]; then
    echo "macos_prewarm_pnpm_lock_sha256=${proof_pnpm_hash:-missing}"
    echo "current_pnpm_lock_sha256=$expected_pnpm_hash"
    failed=1
  fi
  if [[ "$proof_package_hash" != "$expected_package_hash" ]]; then
    echo "macos_prewarm_package_resolved_sha256=${proof_package_hash:-missing}"
    echo "current_package_resolved_sha256=$expected_package_hash"
    failed=1
  fi

  if [[ "$failed" != "0" ]]; then
    echo "macos_prewarm_proof_path=$proof_path"
    return 1
  fi

  echo "macos_prewarm=ok"
  echo "macos_prewarm_proof_path=$proof_path"
}

openclaw_require_macos_prewarm_proof() {
  local root="$1"

  if [[ "${ALLOW_COLD_RELEASE_LANE:-0}" == "1" ]]; then
    echo "WARN: ALLOW_COLD_RELEASE_LANE=1 bypassed macOS prewarm proof." >&2
    return 0
  fi

  if openclaw_validate_macos_prewarm_proof "$root"; then
    return 0
  fi

  cat >&2 <<EOF
ERROR: cold or stale macOS release lane.

Run the blessed warmup before app-building release phases:
  bash scripts/prewarm-worktree.sh --root "\$PWD" --macos

Emergency override only:
  ALLOW_COLD_RELEASE_LANE=1 bash scripts/package-openclaw-mac-dist.sh ...
EOF
  exit 1
}

openclaw_read_bundle_version() {
  local app_path="$1"
  local info_plist="$app_path/Contents/Info.plist"

  if [[ ! -f "$info_plist" ]]; then
    printf '%s\n' ""
    return 0
  fi

  /usr/libexec/PlistBuddy -c "Print CFBundleVersion" "$info_plist" 2>/dev/null || printf '%s\n' ""
}

openclaw_compare_bundle_versions() {
  local left="$1"
  local right="$2"

  /usr/bin/perl -e '
    sub splitv {
      my ($value) = @_;
      return split(/[._-]/, $value);
    }
    my @left = splitv($ARGV[0]);
    my @right = splitv($ARGV[1]);
    my $max = @left > @right ? scalar(@left) : scalar(@right);
    for (my $i = 0; $i < $max; $i++) {
      my $a = defined $left[$i] ? $left[$i] : 0;
      my $b = defined $right[$i] ? $right[$i] : 0;
      my $cmp = 0;
      if ($a =~ /^\d+$/ && $b =~ /^\d+$/) {
        $cmp = $a <=> $b;
      } else {
        $cmp = "$a" cmp "$b";
      }
      if ($cmp < 0) { print "-1\n"; exit 0; }
      if ($cmp > 0) { print "1\n"; exit 0; }
    }
    print "0\n";
  ' "$left" "$right"
}

openclaw_require_incremental_sparkle_build() {
  local built_app_path="$1"
  local installed_app_path="${2:-${OPENCLAW_INSTALLED_JARVIS_APP_PATH:-/Applications/Jarvis.app}}"
  local built_build installed_build comparison

  if [[ "${ALLOW_NON_INCREMENTAL_SPARKLE_BUILD:-0}" == "1" ]]; then
    echo "WARN: ALLOW_NON_INCREMENTAL_SPARKLE_BUILD=1 bypassed installed Jarvis build comparison." >&2
    return 0
  fi

  if [[ ! -d "$installed_app_path" ]]; then
    echo "sparkle_installed_app=missing"
    return 0
  fi

  built_build="$(openclaw_read_bundle_version "$built_app_path")"
  installed_build="$(openclaw_read_bundle_version "$installed_app_path")"

  if [[ -z "$built_build" ]]; then
    echo "ERROR: built Jarvis app is missing CFBundleVersion: $built_app_path" >&2
    exit 1
  fi
  if [[ -z "$installed_build" ]]; then
    echo "ERROR: installed Jarvis app is missing CFBundleVersion: $installed_app_path" >&2
    echo "Set ALLOW_NON_INCREMENTAL_SPARKLE_BUILD=1 only if you intentionally want to bypass this Sparkle update guard." >&2
    exit 1
  fi

  comparison="$(openclaw_compare_bundle_versions "$installed_build" "$built_build")"
  if [[ "$comparison" == "0" || "$comparison" == "1" ]]; then
    cat >&2 <<EOF
ERROR: built Jarvis CFBundleVersion is not newer than the installed app.

Built app:     $built_app_path
Built build:   $built_build
Installed app: $installed_app_path
Installed:     $installed_build

Sparkle will not offer an update unless the new CFBundleVersion is higher.
Bump APP_BUILD/APP_VERSION, or use ALLOW_NON_INCREMENTAL_SPARKLE_BUILD=1 only for an intentional republish.
EOF
    exit 1
  fi

  echo "sparkle_build_incremental=ok"
  echo "sparkle_built_build=$built_build"
  echo "sparkle_installed_build=$installed_build"
}
