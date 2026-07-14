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

openclaw_jarvis_release_worktree_name() {
  printf '%s\n' "${OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME:-jarvis-release-current}"
}

openclaw_jarvis_release_home_clone() {
  printf '%s\n' "${OPENCLAW_MAIN_HOME_CLONE:-/Users/user/Programming_Projects/openclaw}"
}

openclaw_jarvis_release_worktree_path() {
  local home_clone
  local release_name

  home_clone="$(openclaw_jarvis_release_home_clone)"
  release_name="$(openclaw_jarvis_release_worktree_name)"
  printf '%s/.worktrees/%s\n' "$home_clone" "$release_name"
}

openclaw_jarvis_release_worktree_branch() {
  printf 'codex/%s\n' "$(openclaw_jarvis_release_worktree_name)"
}

openclaw_physical_path() {
  local path="$1"
  (cd "$path" && pwd -P)
}

openclaw_require_jarvis_release_worktree() {
  local root="$1"
  local expected_path_override="${2:-}"
  local expected_branch_override="${3:-}"
  local expected_path expected_branch
  local current_path expected_physical
  local current_branch
  local failed=0

  expected_path="${expected_path_override:-$(openclaw_jarvis_release_worktree_path)}"
  expected_branch="${expected_branch_override:-$(openclaw_jarvis_release_worktree_branch)}"
  current_path="$(openclaw_physical_path "$root")"
  expected_physical="$(openclaw_physical_path "$expected_path" 2>/dev/null || printf '%s\n' "$expected_path")"
  current_branch="$(git -C "$root" branch --show-current 2>/dev/null || true)"

  # Public Jarvis packaging is intentionally tied to one warmed lane. A random
  # worktree can be made "warm" too, but that scatters artifacts, receipts, and
  # release proof. Fail before package/notary/publish work starts.
  if [[ "$current_path" != "$expected_physical" ]]; then
    echo "jarvis_release_worktree=current_path_mismatch" >&2
    failed=1
  fi

  if [[ "$current_branch" != "$expected_branch" ]]; then
    echo "jarvis_release_worktree=current_branch_mismatch" >&2
    failed=1
  fi

  if [[ "$failed" != "0" ]]; then
    cat >&2 <<EOF
ERROR: Jarvis public release packaging must run from the blessed warmed release worktree.

Current path:  $current_path
Expected path: $expected_physical
Current branch:  ${current_branch:-detached}
Expected branch: $expected_branch

Prepare and enter the release lane first:
  cd "$(openclaw_jarvis_release_home_clone)"
  bash scripts/jarvis-release-worktree.sh
EOF
    exit 1
  fi

  echo "jarvis_release_worktree=ok"
  echo "jarvis_release_worktree_path=$current_path"
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

Refresh the blessed release worktree before app-building release phases:
  cd "$(openclaw_jarvis_release_home_clone)"
  bash scripts/jarvis-release-worktree.sh

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

openclaw_read_bundle_marketing_version() {
  local app_path="$1"
  local info_plist="$app_path/Contents/Info.plist"

  if [[ ! -f "$info_plist" ]]; then
    printf '%s\n' ""
    return 0
  fi

  /usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$info_plist" 2>/dev/null || printf '%s\n' ""
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

openclaw_parse_marketing_version() {
  local value="$1"
  local prerelease_rank

  # Jarvis marketing versions use a numeric CalVer base with an optional
  # alpha.N or beta.N suffix. Give stable the highest rank so a same-base
  # prerelease can never replace an installed stable release.
  if [[ "$value" =~ ^([0-9]+([.][0-9]+)*)[-.](alpha|beta)[.]([0-9]+)$ ]]; then
    case "${BASH_REMATCH[3]}" in
      alpha) prerelease_rank="0" ;;
      beta) prerelease_rank="1" ;;
    esac
    printf '%s|%s|%s\n' "${BASH_REMATCH[1]}" "$prerelease_rank" "${BASH_REMATCH[4]}"
    return 0
  fi

  if [[ "$value" =~ ^[0-9]+([.][0-9]+)*$ ]]; then
    printf '%s|2|0\n' "$value"
    return 0
  fi

  echo "ERROR: unsupported Jarvis CFBundleShortVersionString '$value'; expected numeric CalVer with optional alpha.N or beta.N suffix." >&2
  return 1
}

openclaw_compare_marketing_versions() {
  local left="$1"
  local right="$2"
  local left_parsed right_parsed
  local left_base left_rank left_prerelease
  local right_base right_rank right_prerelease
  local comparison

  left_parsed="$(openclaw_parse_marketing_version "$left")" || return 1
  right_parsed="$(openclaw_parse_marketing_version "$right")" || return 1
  IFS='|' read -r left_base left_rank left_prerelease <<<"$left_parsed"
  IFS='|' read -r right_base right_rank right_prerelease <<<"$right_parsed"

  comparison="$(openclaw_compare_bundle_versions "$left_base" "$right_base")"
  if [[ "$comparison" != "0" ]]; then
    printf '%s\n' "$comparison"
    return 0
  fi

  # Only compare channel rank and prerelease number after the CalVer base
  # matches. The generic comparator remains unchanged for CFBundleVersion.
  openclaw_compare_bundle_versions \
    "$left_rank.$left_prerelease" \
    "$right_rank.$right_prerelease"
}

openclaw_require_incremental_sparkle_build() {
  local built_app_path="$1"
  local installed_app_path="${2:-${OPENCLAW_INSTALLED_JARVIS_APP_PATH:-/Applications/Jarvis.app}}"
  local built_version installed_version version_comparison
  local built_build installed_build build_comparison

  if [[ "${ALLOW_NON_INCREMENTAL_SPARKLE_BUILD:-0}" == "1" ]]; then
    echo "WARN: ALLOW_NON_INCREMENTAL_SPARKLE_BUILD=1 bypassed installed Jarvis version/build comparison." >&2
    return 0
  fi

  if [[ ! -d "$installed_app_path" ]]; then
    echo "sparkle_installed_app=missing"
    return 0
  fi

  built_version="$(openclaw_read_bundle_marketing_version "$built_app_path")"
  installed_version="$(openclaw_read_bundle_marketing_version "$installed_app_path")"

  # Build numbers drive Sparkle eligibility, but About displays the marketing
  # version. Guard both identities so a larger build cannot visibly downgrade
  # an installed Jarvis release through stale APP_VERSION metadata.
  if [[ -z "$built_version" ]]; then
    echo "ERROR: built Jarvis app is missing CFBundleShortVersionString: $built_app_path" >&2
    exit 1
  fi
  if [[ -z "$installed_version" ]]; then
    echo "ERROR: installed Jarvis app is missing CFBundleShortVersionString: $installed_app_path" >&2
    echo "Set ALLOW_NON_INCREMENTAL_SPARKLE_BUILD=1 only if you intentionally want to bypass this Jarvis version/build guard." >&2
    exit 1
  fi

  version_comparison="$(openclaw_compare_marketing_versions "$installed_version" "$built_version")"
  if [[ "$version_comparison" == "1" ]]; then
    cat >&2 <<EOF
ERROR: built Jarvis CFBundleShortVersionString is older than the installed app.

Built app:         $built_app_path
Built version:     $built_version
Installed app:     $installed_app_path
Installed version: $installed_version

A higher CFBundleVersion cannot make a marketing-version downgrade safe.
Bump APP_VERSION to at least $installed_version, or use ALLOW_NON_INCREMENTAL_SPARKLE_BUILD=1 only for an intentional emergency bypass.
EOF
    exit 1
  fi

  built_build="$(openclaw_read_bundle_version "$built_app_path")"
  installed_build="$(openclaw_read_bundle_version "$installed_app_path")"
  if [[ -z "$built_build" ]]; then
    echo "ERROR: built Jarvis app is missing CFBundleVersion: $built_app_path" >&2
    exit 1
  fi
  if [[ -z "$installed_build" ]]; then
    echo "ERROR: installed Jarvis app is missing CFBundleVersion: $installed_app_path" >&2
    echo "Set ALLOW_NON_INCREMENTAL_SPARKLE_BUILD=1 only if you intentionally want to bypass this Jarvis version/build guard." >&2
    exit 1
  fi

  build_comparison="$(openclaw_compare_bundle_versions "$installed_build" "$built_build")"
  if [[ "$build_comparison" == "0" || "$build_comparison" == "1" ]]; then
    cat >&2 <<EOF
ERROR: built Jarvis CFBundleVersion is not newer than the installed app.

Built app:     $built_app_path
Built build:   $built_build
Installed app: $installed_app_path
Installed:     $installed_build

Sparkle will not offer an update unless the new CFBundleVersion is higher.
Bump APP_BUILD, or use ALLOW_NON_INCREMENTAL_SPARKLE_BUILD=1 only for an intentional emergency bypass.
EOF
    exit 1
  fi

  echo "sparkle_build_incremental=ok"
  echo "sparkle_built_version=$built_version"
  echo "sparkle_installed_version=$installed_version"
  echo "sparkle_built_build=$built_build"
  echo "sparkle_installed_build=$installed_build"
}
