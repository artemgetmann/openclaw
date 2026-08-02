#!/bin/bash

# Focused acceptance harness for an already-published Jarvis Sparkle update.
# The default path is deliberately read-only. Only --apply may copy/launch an
# app, change the ai.jarvis.mac preferences domain, or restart ai.jarvis.gateway.
set -Eeuo pipefail
# Do not inherit an operator PATH for proof or cleanup commands. The only
# non-system executable used below (Node) is selected from a fixed allowlist.
PATH="/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ORIGINAL_ARGS=("$@")
CANONICAL_FEED_URL="https://github.com/artemgetmann/openclaw/releases/latest/download/jarvis-appcast.xml"
GATEWAY_LABEL="ai.jarvis.gateway"
PREFERENCES_DOMAIN="ai.jarvis.mac"
OFFICIAL_BUNDLE_ID="ai.jarvis.mac"
OFFICIAL_TEAM_ID="SKDYY4SBVV"

MODE="preflight"
OLD_APP=""
NEW_APP=""
INSTALLED_APP="/Applications/Jarvis.app"
TELEGRAM_CHAT=""
EXPECTED_COMMIT=""
SCRATCH_ROOT="${TMPDIR:-/tmp}"
TIMEOUT_SECONDS="${JARVIS_SPARKLE_E2E_TIMEOUT_SECONDS:-900}"
DOWNLOAD_GRACE_SECONDS="${JARVIS_SPARKLE_E2E_DOWNLOAD_GRACE_SECONDS:-120}"
MIN_FREE_GB="${JARVIS_SPARKLE_E2E_MIN_FREE_GB:-12}"
TEST_ROOT=""
PROTECTED_HOTFIX_RECEIPT=""

JARVIS_HOME="${HOME}/Library/Application Support/Jarvis"
JARVIS_STATE_DIR="${JARVIS_HOME}/.jarvis"
MANAGED_MANIFEST="${JARVIS_STATE_DIR}/.consumer-bundled-runtime.json"
PROTECTION_MARKER="${JARVIS_STATE_DIR}/.consumer-bundled-runtime.protection.json"
GATEWAY_PLIST="${HOME}/Library/LaunchAgents/${GATEWAY_LABEL}.plist"
PREFERENCES_PLIST="${HOME}/Library/Preferences/${PREFERENCES_DOMAIN}.plist"
SPARKLE_CACHE_ROOT="${HOME}/Library/Caches/${PREFERENCES_DOMAIN}/org.sparkle-project.Sparkle"

# Production paths are fixed so environment variables cannot replace trust
# checks or live-effecting commands. configure_test_root permits shims only
# behind the explicit test-mode + isolated-root gate.
PLUTIL_BIN="/usr/bin/plutil"
CODESIGN_BIN="/usr/bin/codesign"
SPCTL_BIN="/usr/sbin/spctl"
CURL_BIN="/usr/bin/curl"
JQ_BIN="/usr/bin/jq"
PS_BIN="/bin/ps"
DF_BIN="/bin/df"
DU_BIN="/usr/bin/du"
DEFAULTS_BIN="/usr/bin/defaults"
DITTO_BIN="/usr/bin/ditto"
LAUNCHCTL_BIN="/bin/launchctl"
OPENCLAW_BIN="${JARVIS_STATE_DIR}/bin/openclaw"
PROVE_RUNTIME_SCRIPT="${ROOT_DIR}/scripts/prove-jarvis-runtime.sh"
BASH_BIN="/bin/bash"
if [[ -x /opt/homebrew/bin/node ]]; then
  NODE_BIN="/opt/homebrew/bin/node"
elif [[ -x /usr/local/bin/node ]]; then
  NODE_BIN="/usr/local/bin/node"
else
  NODE_BIN="/usr/bin/node"
fi

RUN_DIR=""
RUN_SENTINEL=""
DISPOSABLE_APP=""
PREFERENCES_BACKUP=""
PREFERENCES_EXISTED=0
GATEWAY_RESTART_STARTED=0
GATEWAY_RESTART_FINISHED=0
APP_PIDS=""
SPARKLE_CACHE_SNAPSHOT=""
BASELINE_MODE="normal-signed"

OLD_VERSION=""
OLD_BUILD=""
OLD_COMMIT=""
NEW_VERSION=""
NEW_BUILD=""
NEW_COMMIT=""

log() {
  printf '[jarvis-sparkle-e2e] %s\n' "$*"
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  bash scripts/jarvis-sparkle-update-e2e.sh \
    --old-app /path/to/old/Jarvis.app \
    --new-app /path/to/new/Jarvis.app [options]

Options:
  --apply                  Mutate a disposable copy and the managed Jarvis runtime.
  --scratch-root PATH      Parent for the sentinel-owned disposable run.
  --telegram-chat CHAT     Optional Telegram-as-user nonce proof; runs last.
  --expected-commit SHA    Exact release/package commit expected in the new app.
  --protected-hotfix-compatibility-receipt PATH
                           Short-lived receipt for one exact protected private
                           baseline and one exact signed public target.
  --timeout SECONDS        Per-transition timeout (default: 900).
  --download-grace SECONDS Wait before asking the old app to terminate (default: 120).
  --min-free-gb GB         Minimum actual free space (default: 12).

Test-only:
  --test-root PATH         Remap live paths. Requires OPENCLAW_SPARKLE_E2E_TEST_MODE=1.

Without --apply, every check is read-only and no run directory is created.
EOF
}

require_arg_value() {
  [[ "$#" -ge 2 && -n "$2" ]] || die "$1 requires a value"
}

parse_args() {
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --apply)
        MODE="apply"
        shift
        ;;
      --old-app)
        require_arg_value "$@"
        OLD_APP="$2"
        shift 2
        ;;
      --new-app|--expected-new-app)
        require_arg_value "$@"
        NEW_APP="$2"
        shift 2
        ;;
      --scratch-root)
        require_arg_value "$@"
        SCRATCH_ROOT="$2"
        shift 2
        ;;
      --telegram-chat)
        require_arg_value "$@"
        TELEGRAM_CHAT="$2"
        shift 2
        ;;
      --expected-commit)
        require_arg_value "$@"
        EXPECTED_COMMIT="$2"
        shift 2
        ;;
      --protected-hotfix-compatibility-receipt)
        require_arg_value "$@"
        PROTECTED_HOTFIX_RECEIPT="$2"
        shift 2
        ;;
      --timeout)
        require_arg_value "$@"
        TIMEOUT_SECONDS="$2"
        shift 2
        ;;
      --download-grace)
        require_arg_value "$@"
        DOWNLOAD_GRACE_SECONDS="$2"
        shift 2
        ;;
      --min-free-gb)
        require_arg_value "$@"
        MIN_FREE_GB="$2"
        shift 2
        ;;
      --test-root)
        require_arg_value "$@"
        TEST_ROOT="$2"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "unknown argument: $1"
        ;;
    esac
  done
}

is_unsigned_integer() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

require_readable_file() {
  [[ -f "$1" && -r "$1" ]] || die "preflight blocked: missing or unreadable $2: $1"
}

plist_value() {
  "$PLUTIL_BIN" -extract "$1" raw -o - "$2" 2>/dev/null || true
}

app_plist_value() {
  local app="$1"
  local key="$2"
  plist_value "$key" "$app/Contents/Info.plist"
}

manifest_value() {
  local manifest="$1"
  local expression="$2"
  "$JQ_BIN" -r "$expression" "$manifest"
}

manifest_build() {
  manifest_value "$1" '.bundleVersion // empty'
}

manifest_commit() {
  manifest_value "$1" '.gitCommit // empty'
}

app_manifest_path() {
  printf '%s/Contents/Resources/OpenClawRuntime/manifest.json\n' "$1"
}

app_package_path() {
  printf '%s/Contents/Resources/OpenClawRuntime/openclaw/package.json\n' "$1"
}

read_app_truth() {
  local app="$1"
  local prefix="$2"
  local manifest
  local package
  local version
  local build
  local commit
  local package_version
  local bundle_id

  [[ -d "$app" ]] || die "preflight blocked: missing $prefix app baseline: $app"
  require_readable_file "$app/Contents/Info.plist" "$prefix app Info.plist"

  version="$(app_plist_value "$app" CFBundleShortVersionString)"
  build="$(app_plist_value "$app" CFBundleVersion)"
  [[ -n "$version" ]] || die "preflight blocked: $prefix app has no marketing version"
  is_unsigned_integer "$build" || die "preflight blocked: $prefix app has invalid build: ${build:-missing}"

  manifest="$(app_manifest_path "$app")"
  package="$(app_package_path "$app")"
  require_readable_file "$manifest" "$prefix bundled runtime manifest"
  require_readable_file "$package" "$prefix bundled package metadata"
  commit="$(manifest_commit "$manifest")"
  package_version="$(manifest_value "$package" '.version // empty')"
  bundle_id="$(app_plist_value "$app" CFBundleIdentifier)"
  [[ "$bundle_id" == "$OFFICIAL_BUNDLE_ID" ]] || \
    die "preflight blocked: $prefix app bundle id is not $OFFICIAL_BUNDLE_ID"
  [[ "$commit" =~ ^[0-9a-fA-F]{7,40}$ ]] || die "preflight blocked: $prefix manifest has invalid gitCommit"
  [[ "$(manifest_build "$manifest")" == "$build" ]] || die "preflight blocked: $prefix manifest bundleVersion does not match app build"
  [[ "$package_version" == "$version" ]] || die "preflight blocked: $prefix package version does not match app version"

  eval "${prefix}_VERSION=\$version"
  eval "${prefix}_BUILD=\$build"
  eval "${prefix}_COMMIT=\$commit"
}

verify_strict_app_trust() {
  local app="$1"
  local label="$2"

  "$CODESIGN_BIN" --verify --deep --strict --verbose=2 "$app" >/dev/null 2>&1 || \
    die "preflight blocked: $label app failed strict codesign: $app"
  "$SPCTL_BIN" --assess --type execute --verbose=2 "$app" >/dev/null 2>&1 || \
    die "preflight blocked: $label app failed Gatekeeper assessment: $app"
}

verify_strict_codesign() {
  local app="$1"
  local label="$2"

  "$CODESIGN_BIN" --verify --deep --strict --verbose=2 "$app" >/dev/null 2>&1 || \
    die "preflight blocked: $label app failed strict codesign: $app"
}

gatekeeper_accepts() {
  "$SPCTL_BIN" --assess --type execute --verbose=2 "$1" >/dev/null 2>&1
}

app_team_identifier() {
  local app="$1"
  "$CODESIGN_BIN" -dv --verbose=4 "$app" 2>&1 | sed -n 's/^TeamIdentifier=//p' | head -n 1
}

app_designated_requirement() {
  local app="$1"
  "$CODESIGN_BIN" -d -r- "$app" 2>&1 | sed -n 's/^designated => //p' | head -n 1
}

app_code_directory_hash() {
  local app="$1"
  "$CODESIGN_BIN" -dv --verbose=4 "$app" 2>&1 | sed -n 's/^CDHash=//p' | head -n 1
}

sha256_file() {
  /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}'
}

sha256_text() {
  printf '%s' "$1" | /usr/bin/shasum -a 256 | /usr/bin/awk '{print $1}'
}

verify_one_official_signing_identity() {
  local app="$1"
  local label="$2"
  local team
  local requirement

  [[ "$(app_plist_value "$app" CFBundleIdentifier)" == "$OFFICIAL_BUNDLE_ID" ]] || \
    die "preflight blocked: $label app bundle id is not $OFFICIAL_BUNDLE_ID"
  team="$(app_team_identifier "$app")"
  requirement="$(app_designated_requirement "$app")"
  [[ "$team" == "$OFFICIAL_TEAM_ID" ]] || \
    die "preflight blocked: $label app TeamIdentifier is not the pinned Jarvis team"
  [[ "$requirement" == *"identifier \"$OFFICIAL_BUNDLE_ID\""* && "$requirement" == *"$OFFICIAL_TEAM_ID"* ]] || \
    die "preflight blocked: $label app designated requirement is not pinned to Jarvis identity"
}

verify_official_signing_identity() {
  local old_team
  local new_team
  local installed_team
  local old_requirement
  local new_requirement
  local installed_requirement

  verify_one_official_signing_identity "$OLD_APP" old
  verify_one_official_signing_identity "$NEW_APP" new
  verify_one_official_signing_identity "$INSTALLED_APP" installed

  old_team="$(app_team_identifier "$OLD_APP")"
  new_team="$(app_team_identifier "$NEW_APP")"
  installed_team="$(app_team_identifier "$INSTALLED_APP")"
  old_requirement="$(app_designated_requirement "$OLD_APP")"
  new_requirement="$(app_designated_requirement "$NEW_APP")"
  installed_requirement="$(app_designated_requirement "$INSTALLED_APP")"

  [[ "$old_team" == "$new_team" && "$old_team" == "$installed_team" ]] || \
    die "preflight blocked: old/new/installed apps do not share one signing TeamIdentifier"
  [[ -n "$old_requirement" && "$old_requirement" == "$new_requirement" && "$old_requirement" == "$installed_requirement" ]] || \
    die "preflight blocked: old/new/installed apps do not share one designated requirement"
}

verify_latest_public_feed() {
  local feed_body
  local proof
  local feed_old
  local feed_new

  feed_old="$(app_plist_value "$OLD_APP" SUFeedURL)"
  feed_new="$(app_plist_value "$NEW_APP" SUFeedURL)"
  [[ "$feed_old" == "$CANONICAL_FEED_URL" && "$feed_new" == "$CANONICAL_FEED_URL" ]] || \
    die "preflight blocked: old/new apps are not pinned to the canonical Jarvis appcast"

  feed_body="$("$CURL_BIN" --fail --location --silent --show-error --max-time 30 "$CANONICAL_FEED_URL")" || \
    die "preflight blocked: latest public appcast is unavailable"

  # Sparkle consumes the first item as latest. Match only that item so an older
  # historical item cannot accidentally satisfy the acceptance gate.
  proof="$(OPENCLAW_SPARKLE_FEED_BODY="$feed_body" "$NODE_BIN" --input-type=module - "$NEW_VERSION" "$NEW_BUILD" <<'NODE'
const [expectedVersion, expectedBuild] = process.argv.slice(2);
const xml = process.env.OPENCLAW_SPARKLE_FEED_BODY ?? "";
const item = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/i)?.[0] ?? "";
const text = (name) => item.match(new RegExp(`<${name}[^>]*>([^<]+)</${name}>`, "i"))?.[1]?.trim() ?? "";
const enclosure = item.match(/<enclosure\b[^>]*\burl=["']([^"']+)["'][^>]*>/i)?.[1] ?? "";
const version = text("sparkle:shortVersionString");
const build = text("sparkle:version");
if (version !== expectedVersion || build !== expectedBuild || !/^https:\/\/.+\/Jarvis\.zip(?:\?|$)/.test(enclosure)) {
  process.exit(1);
}
process.stdout.write(`version=${version} build=${build} enclosure=${enclosure}`);
NODE
  )" || die "preflight blocked: latest public appcast item does not match the candidate app"

  log "proof.public_feed=ok $proof"
}

verify_installed_baseline() {
  local installed_version
  local installed_build

  [[ -d "$INSTALLED_APP" ]] || die "preflight blocked: installed app baseline is missing: $INSTALLED_APP"
  installed_version="$(app_plist_value "$INSTALLED_APP" CFBundleShortVersionString)"
  installed_build="$(app_plist_value "$INSTALLED_APP" CFBundleVersion)"
  [[ "$(app_plist_value "$INSTALLED_APP" CFBundleIdentifier)" == "$OFFICIAL_BUNDLE_ID" ]] || \
    die "preflight blocked: installed app bundle id is not $OFFICIAL_BUNDLE_ID"
  [[ "$installed_version" == "$OLD_VERSION" && "$installed_build" == "$OLD_BUILD" ]] || \
    die "preflight blocked: installed app is not the declared old baseline"
  verify_strict_codesign "$INSTALLED_APP" installed
  gatekeeper_accepts "$INSTALLED_APP" || \
    die "preflight blocked: installed app failed Gatekeeper without a valid protected-hotfix compatibility receipt"

  log "baseline_mode=normal_signed"
  log "proof.installed_app=normal_signed_baseline version=$installed_version build=$installed_build"
}

verify_protected_hotfix_compatibility_receipt() {
  local installed_team
  local installed_requirement
  local installed_cdhash
  local old_team
  local old_requirement
  local old_cdhash
  local compatibility_commit
  local compatibility_build
  local protected_commit
  local marker_compatibility_commit
  local marker_compatibility_build
  local marker_source
  local backup_path
  local backup_commit
  local backup_build
  local live_proof
  local receipt_proof

  [[ -f "$PROTECTED_HOTFIX_RECEIPT" && -r "$PROTECTED_HOTFIX_RECEIPT" && ! -L "$PROTECTED_HOTFIX_RECEIPT" ]] || \
    die "preflight blocked: protected-hotfix compatibility receipt is missing, unreadable, or a symlink"

  # A receipt is never an unsigned-app bypass. Both private-baseline copies must
  # still have intact code signatures; only their Gatekeeper verdict may fail.
  verify_strict_codesign "$OLD_APP" old
  verify_strict_codesign "$INSTALLED_APP" installed
  if gatekeeper_accepts "$INSTALLED_APP"; then
    die "preflight blocked: normal signed baseline detected; protected-hotfix compatibility receipt is not applicable"
  fi

  [[ "$OLD_VERSION" == "$INSTALLED_VERSION" && "$OLD_BUILD" == "$INSTALLED_BUILD" && "$OLD_COMMIT" == "$INSTALLED_COMMIT" ]] || \
    die "preflight blocked: installed/live mismatch: protected installed app is not the declared old baseline"

  installed_team="$(app_team_identifier "$INSTALLED_APP")"
  installed_requirement="$(app_designated_requirement "$INSTALLED_APP")"
  installed_cdhash="$(app_code_directory_hash "$INSTALLED_APP")"
  old_team="$(app_team_identifier "$OLD_APP")"
  old_requirement="$(app_designated_requirement "$OLD_APP")"
  old_cdhash="$(app_code_directory_hash "$OLD_APP")"
  [[ -n "$installed_team" && -n "$installed_requirement" && "$installed_cdhash" =~ ^[0-9a-fA-F]{40}$ ]] || \
    die "preflight blocked: protected installed app has missing or ambiguous code-signing provenance"
  [[ "$old_team" == "$installed_team" && "$old_requirement" == "$installed_requirement" && "$old_cdhash" == "$installed_cdhash" ]] || \
    die "preflight blocked: installed/live mismatch: old and installed private app signing identities differ"

  require_readable_file "$MANAGED_MANIFEST" "protected-hotfix compatibility manifest"
  require_readable_file "$PROTECTION_MARKER" "protected-hotfix protection marker"
  compatibility_commit="$(manifest_commit "$MANAGED_MANIFEST")"
  compatibility_build="$(manifest_build "$MANAGED_MANIFEST")"
  protected_commit="$(manifest_value "$PROTECTION_MARKER" '.protectedRuntimeGitCommit // empty')"
  marker_compatibility_commit="$(manifest_value "$PROTECTION_MARKER" '.compatibilityManifestGitCommit // empty')"
  marker_compatibility_build="$(manifest_value "$PROTECTION_MARKER" '.compatibilityManifestBundleVersion // empty')"
  marker_source="$(manifest_value "$PROTECTION_MARKER" '.compatibilityManifestSource // empty')"
  backup_path="$(manifest_value "$PROTECTION_MARKER" '.backupPath // empty')"
  [[ "$backup_path" == /* ]] || die "preflight blocked: protected-hotfix backup provenance is missing or ambiguous"
  require_readable_file "$backup_path" "protected-hotfix backup receipt"
  backup_commit="$(manifest_commit "$backup_path")"
  backup_build="$(manifest_build "$backup_path")"

  # Node validates exact keys as well as values. Rejecting unknown fields keeps
  # future receipt versions from silently acquiring broader authority.
  receipt_proof="$({
    OPENCLAW_RECEIPT_PATH="$PROTECTED_HOTFIX_RECEIPT" \
    "$NODE_BIN" --input-type=module - \
      "$INSTALLED_VERSION" "$INSTALLED_BUILD" "$INSTALLED_COMMIT" \
      "$installed_team" "$(sha256_text "$installed_requirement")" "$installed_cdhash" \
      "$compatibility_commit" "$compatibility_build" "$(sha256_file "$MANAGED_MANIFEST")" \
      "$protected_commit" "$marker_compatibility_commit" "$marker_compatibility_build" "$marker_source" \
      "$backup_commit" "$backup_build" "$(sha256_file "$backup_path")" "$(sha256_file "$PROTECTION_MARKER")" \
      "$NEW_VERSION" "$NEW_BUILD" "$NEW_COMMIT" "$CANONICAL_FEED_URL" <<'NODE'
import fs from "node:fs";

const values = process.argv.slice(2);
const [
  installedVersion, installedBuild, installedCommit, installedTeam, requirementSha256, codeDirectoryHash,
  compatibilityCommit, compatibilityBuild, compatibilityManifestSha256,
  protectedCommit, markerCompatibilityCommit, markerCompatibilityBuild, markerSource,
  backupCommit, backupBuild, backupManifestSha256, protectionMarkerSha256,
  targetVersion, targetBuild, targetCommit, canonicalFeedURL,
] = values;
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
const exactKeys = (value, keys, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} has missing or ambiguous fields`);
};
const exact = (actual, expected, label) => {
  if (actual !== expected) fail(`${label} mismatch`);
};
const fullCommit = (value, label) => {
  if (!/^[0-9a-f]{40}$/i.test(value)) fail(`${label} must be one full git commit`);
};
let receipt;
try {
  receipt = JSON.parse(fs.readFileSync(process.env.OPENCLAW_RECEIPT_PATH, "utf8"));
} catch {
  fail("receipt is not valid readable JSON");
}
exactKeys(receipt, ["schemaVersion", "kind", "receiptId", "issuedAt", "expiresAt", "intent", "installedApp", "protectedRuntime", "targetRelease"], "receipt");
exact(receipt.schemaVersion, 1, "schemaVersion");
exact(receipt.kind, "jarvis-sparkle-protected-hotfix-baseline-compatibility", "kind");
if (!/^[a-z0-9][a-z0-9._-]{7,127}$/.test(receipt.receiptId)) fail("receiptId is invalid");

const issuedAt = Date.parse(receipt.issuedAt);
const expiresAt = Date.parse(receipt.expiresAt);
const now = Date.now();
if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) fail("receipt timestamps are invalid");
if (issuedAt > now + 5 * 60_000) fail("receipt is not yet valid");
if (expiresAt <= now) fail("receipt is stale");
if (expiresAt <= issuedAt || expiresAt - issuedAt > 7 * 24 * 60 * 60_000) fail("receipt validity window is invalid");

exactKeys(receipt.intent, ["operation", "oneTimeUse", "feedURL"], "intent");
exact(receipt.intent.operation, "sparkle-n-to-n-plus-1", "intent.operation");
exact(receipt.intent.oneTimeUse, true, "intent.oneTimeUse");
exact(receipt.intent.feedURL, canonicalFeedURL, "intent.feedURL");

exactKeys(receipt.installedApp, ["bundleIdentifier", "version", "build", "gitCommit", "teamIdentifier", "designatedRequirementSha256", "codeDirectoryHash"], "installedApp");
exact(receipt.installedApp.bundleIdentifier, "ai.jarvis.mac", "installedApp.bundleIdentifier");
exact(receipt.installedApp.version, installedVersion, "installedApp.version");
exact(receipt.installedApp.build, installedBuild, "installedApp.build");
exact(receipt.installedApp.gitCommit, installedCommit, "installedApp.gitCommit");
exact(receipt.installedApp.teamIdentifier, installedTeam, "installedApp.teamIdentifier");
exact(receipt.installedApp.designatedRequirementSha256, requirementSha256, "installedApp.designatedRequirementSha256");
exact(receipt.installedApp.codeDirectoryHash, codeDirectoryHash, "installedApp.codeDirectoryHash");

exactKeys(receipt.protectedRuntime, ["runtimeSource", "gitCommit", "bundleVersion", "compatibilityManifestGitCommit", "compatibilityManifestBundleVersion", "compatibilityManifestSource", "compatibilityManifestSha256", "backupManifestSha256", "protectionMarkerSha256"], "protectedRuntime");
exact(receipt.protectedRuntime.runtimeSource, "jarvis-break-glass-hotfix", "protectedRuntime.runtimeSource");
exact(receipt.protectedRuntime.gitCommit, protectedCommit, "protectedRuntime.gitCommit");
exact(receipt.protectedRuntime.bundleVersion, backupBuild, "protectedRuntime.bundleVersion");
exact(receipt.protectedRuntime.compatibilityManifestGitCommit, compatibilityCommit, "protectedRuntime.compatibilityManifestGitCommit");
exact(receipt.protectedRuntime.compatibilityManifestBundleVersion, compatibilityBuild, "protectedRuntime.compatibilityManifestBundleVersion");
exact(receipt.protectedRuntime.compatibilityManifestSource, markerSource, "protectedRuntime.compatibilityManifestSource");
exact(receipt.protectedRuntime.compatibilityManifestSha256, compatibilityManifestSha256, "protectedRuntime.compatibilityManifestSha256");
exact(receipt.protectedRuntime.backupManifestSha256, backupManifestSha256, "protectedRuntime.backupManifestSha256");
exact(receipt.protectedRuntime.protectionMarkerSha256, protectionMarkerSha256, "protectedRuntime.protectionMarkerSha256");
if (!/^\d+$/.test(backupBuild) || !/^\d+$/.test(targetBuild)) fail("protected or target build is invalid");
if (BigInt(targetBuild) <= BigInt(backupBuild)) fail("target release build is not newer than protected runtime build");

exactKeys(receipt.targetRelease, ["bundleIdentifier", "version", "build", "gitCommit", "feedURL"], "targetRelease");
exact(receipt.targetRelease.bundleIdentifier, "ai.jarvis.mac", "targetRelease.bundleIdentifier");
exact(receipt.targetRelease.version, targetVersion, "targetRelease.version");
exact(receipt.targetRelease.build, targetBuild, "targetRelease.build");
exact(receipt.targetRelease.gitCommit, targetCommit, "targetRelease.gitCommit");
exact(receipt.targetRelease.feedURL, canonicalFeedURL, "targetRelease.feedURL");

for (const [value, label] of [[installedCommit, "installed commit"], [protectedCommit, "protected runtime commit"], [backupCommit, "backup commit"], [targetCommit, "target commit"]]) fullCommit(value, label);
exact(markerCompatibilityCommit, compatibilityCommit, "protection marker compatibility commit");
exact(markerCompatibilityBuild, compatibilityBuild, "protection marker compatibility build");
exact(markerSource, process.env.OPENCLAW_EXPECTED_INSTALLED_APP, "protection marker source");
exact(backupCommit, protectedCommit, "backup protected commit");
exact(compatibilityCommit, installedCommit, "compatibility installed commit");
exact(compatibilityBuild, installedBuild, "compatibility installed build");
process.stdout.write(`receipt_id=${receipt.receiptId}`);
NODE
  } 2>&1)" || die "preflight blocked: protected-hotfix compatibility receipt rejected: $receipt_proof"

  # Static receipts prove the protection chain, not the daemon currently bound
  # to ai.jarvis.gateway. Reuse the canonical read-only proof so a stale marker
  # cannot authorize overwriting an unrelated live runtime.
  live_proof="$($BASH_BIN "$PROVE_RUNTIME_SCRIPT" \
    --runtime-source jarvis-break-glass-hotfix \
    --expected-commit "$protected_commit" 2>&1)" || \
    die "preflight blocked: live protected runtime proof failed for receipt commit $protected_commit"
  [[ "$live_proof" == *"jarvis_runtime_proof=true"* && \
    "$live_proof" == *"runtime_source=jarvis-break-glass-hotfix"* && \
    "$live_proof" == *"runtime_commit=$protected_commit"* ]] || \
    die "preflight blocked: live protected runtime proof did not return the exact receipt identity"

  BASELINE_MODE="protected-hotfix-compatibility-receipt"
  log "baseline_mode=accepted_protected_hotfix_compatibility_receipt $receipt_proof receipt_sha256=$(sha256_file "$PROTECTED_HOTFIX_RECEIPT")"
  log "proof.installed_app=accepted_protected_hotfix_compatibility_receipt version=$INSTALLED_VERSION build=$INSTALLED_BUILD commit=$INSTALLED_COMMIT"
  log "proof.protected_runtime=receipt_and_live_bound commit=$protected_commit backup_build=$backup_build"
}

verify_live_managed_baseline() {
  local live_build
  local live_commit

  require_readable_file "$MANAGED_MANIFEST" "live managed runtime manifest"
  live_build="$(manifest_build "$MANAGED_MANIFEST")"
  live_commit="$(manifest_commit "$MANAGED_MANIFEST")"

  # Exact old-baseline equality is the safe rule. Merely being numerically
  # older is insufficient because a debug runtime can carry unrelated code.
  [[ "$live_build" == "$OLD_BUILD" && "$live_commit" == "$OLD_COMMIT" ]] || \
    die "preflight blocked: live managed manifest is newer or mismatched from the old package baseline"
}

verify_gateway_plist_identity() {
  local expected_node="${JARVIS_STATE_DIR}/tools/node/bin/node"
  local expected_entry="${JARVIS_STATE_DIR}/lib/openclaw-bundled/dist/index.js"
  local expected_workdir="${JARVIS_STATE_DIR}/lib/openclaw-bundled"
  local label
  local program
  local entrypoint
  local workdir

  require_readable_file "$GATEWAY_PLIST" "ai.jarvis.gateway LaunchAgent plist"
  label="$(plist_value Label "$GATEWAY_PLIST")"
  program="$(plist_value ProgramArguments.0 "$GATEWAY_PLIST")"
  entrypoint="$(plist_value ProgramArguments.1 "$GATEWAY_PLIST")"
  workdir="$(plist_value WorkingDirectory "$GATEWAY_PLIST")"

  [[ "$label" == "$GATEWAY_LABEL" ]] || die "preflight blocked: gateway plist label is not $GATEWAY_LABEL"
  [[ "$program" == "$expected_node" && "$entrypoint" == "$expected_entry" ]] || \
    die "preflight blocked: gateway plist program does not target the Jarvis managed runtime"
  [[ "$workdir" == "$expected_workdir" ]] || die "preflight blocked: gateway plist working directory mismatch"
  [[ "$(plist_value EnvironmentVariables.OPENCLAW_STATE_DIR "$GATEWAY_PLIST")" == "$JARVIS_STATE_DIR" ]] || \
    die "preflight blocked: gateway plist OPENCLAW_STATE_DIR mismatch"
  [[ "$(plist_value EnvironmentVariables.OPENCLAW_CONFIG_PATH "$GATEWAY_PLIST")" == "$JARVIS_STATE_DIR/openclaw.json" ]] || \
    die "preflight blocked: gateway plist OPENCLAW_CONFIG_PATH mismatch"
  [[ "$(plist_value EnvironmentVariables.OPENCLAW_LAUNCHD_LABEL "$GATEWAY_PLIST")" == "$GATEWAY_LABEL" ]] || \
    die "preflight blocked: gateway plist launch label environment mismatch"
  [[ "$(plist_value EnvironmentVariables.OPENCLAW_PROFILE "$GATEWAY_PLIST")" == "consumer" ]] || \
    die "preflight blocked: gateway plist profile is not consumer"
}

canonical_release_lock_path() {
  if [[ -n "${OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE:-}" ]]; then
    [[ -n "$TEST_ROOT" ]] || die "release lock path override is test-only"
    printf '%s\n' "$OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE"
    return
  fi

  local common_dir
  local common_physical
  local identity
  common_dir="$(git -C "$ROOT_DIR" rev-parse --git-common-dir)"
  [[ "$common_dir" == /* ]] || common_dir="$ROOT_DIR/$common_dir"
  common_physical="$(cd "$common_dir" && pwd -P)"
  identity="$(printf '%s' "$common_physical" | /usr/bin/cksum | /usr/bin/awk '{print $1 "-" $2}')"
  printf '/tmp/openclaw-jarvis-release-locks-%s/%s.lock\n' "$(id -u)" "$identity"
}

inspect_release_and_process_owners() {
  local lock_path
  local blockers
  lock_path="$(canonical_release_lock_path)"

  # Inspection is intentionally simpler and safer than the release lock
  # library: this harness never acquires, reclaims, removes, or rewrites it.
  if [[ -e "$lock_path" ]]; then
    local owner_context="unknown"
    if [[ -r "$lock_path/owner" ]]; then
      owner_context="$(sed -n 's/^context=//p' "$lock_path/owner" | head -n 1)"
    fi
    die "preflight blocked: canonical release owner exists (inspect-only): ${owner_context:-unknown}"
  fi
  log "release_lock=clear inspection=read-only path=$lock_path"

  blockers="$(current_app_package_or_sparkle_owners)"
  [[ -z "$blockers" ]] || \
    die "preflight blocked: quit every Jarvis/OpenClaw app and wait for Sparkle/package owners to exit before this exclusive acceptance run"
}

current_app_package_or_sparkle_owners() {
  "$PS_BIN" -axo pid=,command= | awk -v self="$$" '
    $1 == self { next }
    /\.app\/Contents\/MacOS\// && /(Jarvis|OpenClaw)/ { print; next }
    /(package-openclaw-mac-dist|jarvis-public-release|package-consumer-mac-app|package-jarvis-consumer-rc)\.sh/ { print; next }
    /(org\.sparkle-project\.Sparkle|Autoupdate|InstallerLauncher|InstallerStatus|Sparkle.*Downloader)/ { print }
  '
}

verify_actual_disk_headroom() {
  local free_kb
  local old_kb
  local new_kb
  local calculated_kb
  local minimum_kb
  local required_kb

  [[ -d "$SCRATCH_ROOT" ]] || die "preflight blocked: scratch root does not exist: $SCRATCH_ROOT"
  free_kb="$("$DF_BIN" -Pk "$SCRATCH_ROOT" | awk 'NR == 2 {print $4}')"
  old_kb="$("$DU_BIN" -sk "$OLD_APP" | awk '{print $1}')"
  new_kb="$("$DU_BIN" -sk "$NEW_APP" | awk '{print $1}')"
  is_unsigned_integer "$free_kb" && is_unsigned_integer "$old_kb" && is_unsigned_integer "$new_kb" || \
    die "preflight blocked: unable to measure actual free space and app sizes"
  is_unsigned_integer "$MIN_FREE_GB" || die "preflight blocked: --min-free-gb must be an integer"

  # Sparkle may temporarily hold old, downloaded, expanded, and rollback copies.
  # Keep a fixed floor as well as an artifact-relative floor to avoid the GB leak
  # seen during the incident turning into a half-finished acceptance run.
  calculated_kb=$((old_kb * 2 + new_kb * 3 + 2 * 1024 * 1024))
  minimum_kb=$((MIN_FREE_GB * 1024 * 1024))
  required_kb="$calculated_kb"
  (( minimum_kb > required_kb )) && required_kb="$minimum_kb"
  (( free_kb >= required_kb )) || \
    die "preflight blocked: insufficient disk (free_kb=$free_kb required_kb=$required_kb)"
  log "disk_preflight=ok free_kb=$free_kb required_kb=$required_kb"
}

verify_safe_scratch_root() {
  local physical
  local app
  local app_physical
  local jarvis_physical
  local user_library_physical

  [[ "$SCRATCH_ROOT" == /* && -d "$SCRATCH_ROOT" ]] || \
    die "preflight blocked: --scratch-root must be an existing absolute directory"
  physical="$(cd "$SCRATCH_ROOT" && pwd -P)"
  jarvis_physical="$(cd "$JARVIS_HOME" && pwd -P)"
  user_library_physical="$(cd "$HOME/Library" && pwd -P)"

  case "$physical" in
    /|/Applications|/Applications/*|"$jarvis_physical"|"$jarvis_physical"/*|"$user_library_physical"|"$user_library_physical"/*)
      die "preflight blocked: scratch root may not target /Applications or live user Library state"
      ;;
  esac

  for app in "$OLD_APP" "$NEW_APP" "$INSTALLED_APP"; do
    app_physical="$(cd "$app" && pwd -P)"
    case "$physical" in
      "$app_physical"|"$app_physical"/*)
        die "preflight blocked: scratch root may not be inside an app bundle"
        ;;
    esac
  done

  SCRATCH_ROOT="$physical"
}

configure_test_root() {
  local command_var
  local command_path
  local command_physical
  local test_root_physical
  [[ -z "$TEST_ROOT" ]] && return
  [[ "${OPENCLAW_SPARKLE_E2E_TEST_MODE:-0}" == "1" ]] || die "--test-root requires OPENCLAW_SPARKLE_E2E_TEST_MODE=1"
  [[ "$TEST_ROOT" == /* && -d "$TEST_ROOT" ]] || die "--test-root must be an existing absolute directory"
  test_root_physical="$(cd "$TEST_ROOT" && pwd -P)"
  case "$test_root_physical" in
    /Applications|/Applications/*|"${HOME}/Library/Application Support/Jarvis"|"${HOME}/Library/Application Support/Jarvis"/*)
      die "refusing a live Jarvis path as --test-root"
      ;;
  esac
  TEST_ROOT="$test_root_physical"

  # Test mode fails shut: every command capable of forging proof or changing
  # state must be an executable owned by this isolated fixture root. Merely
  # setting the test-mode flag can never fall through to live system tools.
  for command_var in \
    OPENCLAW_CODESIGN_BIN OPENCLAW_SPCTL_BIN OPENCLAW_CURL_BIN \
    OPENCLAW_PS_BIN OPENCLAW_DF_BIN OPENCLAW_DEFAULTS_BIN OPENCLAW_DITTO_BIN \
    OPENCLAW_LAUNCHCTL_BIN OPENCLAW_JARVIS_CLI_BIN \
    OPENCLAW_PROVE_JARVIS_RUNTIME_SCRIPT; do
    command_path="${!command_var:-}"
    command_physical="$(realpath "$command_path" 2>/dev/null || true)"
    [[ "$command_physical" == "$test_root_physical"/bin/* && -x "$command_physical" ]] || \
      die "test mode requires $command_var to be an executable under --test-root/bin"
  done

  JARVIS_HOME="$TEST_ROOT/live/Jarvis"
  JARVIS_STATE_DIR="$JARVIS_HOME/.jarvis"
  INSTALLED_APP="$TEST_ROOT/apps/installed/Jarvis.app"
  MANAGED_MANIFEST="$JARVIS_STATE_DIR/.consumer-bundled-runtime.json"
  PROTECTION_MARKER="$JARVIS_STATE_DIR/.consumer-bundled-runtime.protection.json"
  GATEWAY_PLIST="$TEST_ROOT/live/LaunchAgents/$GATEWAY_LABEL.plist"
  PREFERENCES_PLIST="$TEST_ROOT/live/Preferences/$PREFERENCES_DOMAIN.plist"
  SPARKLE_CACHE_ROOT="$TEST_ROOT/live/Caches/$PREFERENCES_DOMAIN/org.sparkle-project.Sparkle"
  CODESIGN_BIN="${OPENCLAW_CODESIGN_BIN:-$CODESIGN_BIN}"
  SPCTL_BIN="${OPENCLAW_SPCTL_BIN:-$SPCTL_BIN}"
  CURL_BIN="${OPENCLAW_CURL_BIN:-$CURL_BIN}"
  PS_BIN="${OPENCLAW_PS_BIN:-$PS_BIN}"
  DF_BIN="${OPENCLAW_DF_BIN:-$DF_BIN}"
  DEFAULTS_BIN="${OPENCLAW_DEFAULTS_BIN:-$DEFAULTS_BIN}"
  DITTO_BIN="${OPENCLAW_DITTO_BIN:-$DITTO_BIN}"
  LAUNCHCTL_BIN="${OPENCLAW_LAUNCHCTL_BIN:-$LAUNCHCTL_BIN}"
  OPENCLAW_BIN="${OPENCLAW_JARVIS_CLI_BIN:-$TEST_ROOT/bin/openclaw}"
  PROVE_RUNTIME_SCRIPT="${OPENCLAW_PROVE_JARVIS_RUNTIME_SCRIPT:-$TEST_ROOT/bin/prove-jarvis-runtime}"
  OFFICIAL_TEAM_ID="FIXTURETEAM"
}

run_preflight() {
  command -v "$JQ_BIN" >/dev/null 2>&1 || die "preflight blocked: jq is unavailable"
  [[ -n "$OLD_APP" && -n "$NEW_APP" ]] || die "--old-app and --new-app are required"
  is_unsigned_integer "$TIMEOUT_SECONDS" || die "--timeout must be an integer"
  is_unsigned_integer "$DOWNLOAD_GRACE_SECONDS" || die "--download-grace must be an integer"

  read_app_truth "$OLD_APP" OLD
  read_app_truth "$NEW_APP" NEW
  read_app_truth "$INSTALLED_APP" INSTALLED
  (( NEW_BUILD > OLD_BUILD )) || die "preflight blocked: candidate build is not strictly newer than old build"
  [[ "$NEW_COMMIT" != "$OLD_COMMIT" ]] || die "preflight blocked: candidate package commit did not change"
  [[ "$EXPECTED_COMMIT" =~ ^[0-9a-fA-F]{7,40}$ ]] || die "--expected-commit must be a 7-40 character git commit"
  [[ "$NEW_COMMIT" == "$EXPECTED_COMMIT"* || "$EXPECTED_COMMIT" == "$NEW_COMMIT"* ]] || \
    die "preflight blocked: candidate bundled package commit does not match --expected-commit"

  verify_strict_app_trust "$NEW_APP" new
  verify_one_official_signing_identity "$NEW_APP" new
  if [[ -n "$PROTECTED_HOTFIX_RECEIPT" ]]; then
    OPENCLAW_EXPECTED_INSTALLED_APP="$INSTALLED_APP" verify_protected_hotfix_compatibility_receipt
  else
    verify_installed_baseline
    verify_strict_app_trust "$OLD_APP" old
    verify_official_signing_identity
  fi
  verify_latest_public_feed
  if [[ "$BASELINE_MODE" == "normal-signed" ]]; then
    verify_live_managed_baseline
  fi
  verify_gateway_plist_identity
  inspect_release_and_process_owners
  verify_safe_scratch_root
  verify_actual_disk_headroom

  log "preflight=passed mode=$MODE mutation=$([[ "$MODE" == apply ]] && printf enabled || printf disabled)"
  if [[ "$MODE" != "apply" ]]; then
    log "proof.sparkle_transition=pending_apply"
    log "proof.managed_runtime=pending_apply"
    log "proof.gateway=pending_apply"
    log "proof.telegram=$([[ -n "$TELEGRAM_CHAT" ]] && printf pending_apply || printf skipped)"
  fi
}

record_app_pid() {
  local pid="$1"
  APP_PIDS="${APP_PIDS}${APP_PIDS:+ }${pid}"
}

stop_tracked_apps() {
  local pid
  local deadline
  for pid in $APP_PIDS; do
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill -TERM "$pid" >/dev/null 2>&1 || true
      deadline=$((SECONDS + 5))
      while kill -0 "$pid" >/dev/null 2>&1 && (( SECONDS < deadline )); do
        sleep 1
      done
      # A stuck disposable app must not remain alive while its bundle is
      # removed. KILL is bounded to the exact PID launched by this invocation.
      if kill -0 "$pid" >/dev/null 2>&1; then
        kill -KILL "$pid" >/dev/null 2>&1 || true
      fi
      wait "$pid" >/dev/null 2>&1 || true
    fi
  done
  APP_PIDS=""
}

snapshot_sparkle_cache() {
  SPARKLE_CACHE_SNAPSHOT="$RUN_DIR/sparkle-cache.before"
  : >"$SPARKLE_CACHE_SNAPSHOT"
  [[ -d "$SPARKLE_CACHE_ROOT" ]] || return 0
  find "$SPARKLE_CACHE_ROOT" -mindepth 1 -maxdepth 1 -print | LC_ALL=C sort >"$SPARKLE_CACHE_SNAPSHOT"
}

audit_new_sparkle_cache_entries() {
  local current
  local created
  [[ -n "$SPARKLE_CACHE_SNAPSHOT" && -f "$SPARKLE_CACHE_SNAPSHOT" && -d "$SPARKLE_CACHE_ROOT" ]] || return 0
  current="$RUN_DIR/sparkle-cache.current"
  created="$RUN_DIR/sparkle-cache.created"
  find "$SPARKLE_CACHE_ROOT" -mindepth 1 -maxdepth 1 -print | LC_ALL=C sort >"$current"
  comm -13 "$SPARKLE_CACHE_SNAPSHOT" "$current" >"$created"

  [[ ! -s "$created" ]] && {
    log "sparkle_cache_residue=none"
    return 0
  }

  # "New since snapshot" is not proof of ownership. Never delete these paths:
  # a foreign updater can create an entry after the snapshot at any instant.
  log "ERROR: Sparkle left new cache entries; ownership is unattributed, so automatic deletion is refused"
  while IFS= read -r path; do
    [[ -n "$path" ]] && log "sparkle_cache_residue=$path"
  done <"$created"
  return 1
}

restore_preferences() {
  local restore_status=0
  [[ -n "$PREFERENCES_BACKUP" ]] || return 0

  if [[ "$PREFERENCES_EXISTED" == "1" ]]; then
    mkdir -p "$(dirname "$PREFERENCES_PLIST")" || restore_status="$?"
    "$DEFAULTS_BIN" import "$PREFERENCES_DOMAIN" "$PREFERENCES_BACKUP" >/dev/null 2>&1 || restore_status="$?"
    # defaults import notifies cfprefsd; the final byte-for-byte copy preserves
    # the exact plist the user had before this run.
    cp -p "$PREFERENCES_BACKUP" "$PREFERENCES_PLIST" || restore_status="$?"
  else
    "$DEFAULTS_BIN" delete "$PREFERENCES_DOMAIN" >/dev/null 2>&1 || restore_status="$?"
    rm -f "$PREFERENCES_PLIST" || restore_status="$?"
  fi
  return "$restore_status"
}

restore_gateway_after_failure() {
  [[ "$GATEWAY_RESTART_STARTED" == "1" && "$GATEWAY_RESTART_FINISHED" != "1" ]] || return 0
  [[ -r "$GATEWAY_PLIST" ]] || return 0

  # The harness never edits the LaunchAgent file. Rollback means reloading the
  # same existing exact plist, not copying over a user-owned LaunchAgent path.
  "$LAUNCHCTL_BIN" bootout "gui/$(id -u)/$GATEWAY_LABEL" >/dev/null 2>&1 || true
  "$LAUNCHCTL_BIN" bootstrap "gui/$(id -u)" "$GATEWAY_PLIST" >/dev/null 2>&1 || true
}

cleanup() {
  local status="$?"
  local cache_status=0
  local preferences_status=0
  trap - EXIT HUP INT TERM
  set +e

  stop_tracked_apps
  audit_new_sparkle_cache_entries || cache_status="$?"
  restore_preferences || preferences_status="$?"
  restore_gateway_after_failure

  # The sentinel and exact parent prefix are both required. A typo or empty
  # variable therefore cannot turn cleanup into a broad rm -rf.
  if [[ "$preferences_status" == "0" && -n "$RUN_DIR" && -f "$RUN_SENTINEL" && "$RUN_DIR" == "$SCRATCH_ROOT"/jarvis-sparkle-e2e-* ]]; then
    rm -rf "$RUN_DIR"
  elif [[ "$preferences_status" != "0" ]]; then
    log "ERROR: failed to restore Sparkle preferences; preserved rollback evidence at $RUN_DIR"
  fi
  if [[ "$status" == "0" && "$cache_status" != "0" ]]; then
    status="$cache_status"
  fi
  if [[ "$status" == "0" && "$preferences_status" != "0" ]]; then
    status="$preferences_status"
  fi
  exit "$status"
}

prepare_owned_run() {
  RUN_DIR="$(mktemp -d "$SCRATCH_ROOT/jarvis-sparkle-e2e-XXXXXX")"
  RUN_SENTINEL="$RUN_DIR/.owned-by-jarvis-sparkle-update-e2e"
  printf 'pid=%s\n' "$$" >"$RUN_SENTINEL"
  mkdir -p "$RUN_DIR/tmp" "$RUN_DIR/logs" "$RUN_DIR/preferences"
  DISPOSABLE_APP="$RUN_DIR/Jarvis.app"
  "$DITTO_BIN" "$OLD_APP" "$DISPOSABLE_APP"
  snapshot_sparkle_cache
}

backup_and_force_sparkle_preferences() {
  PREFERENCES_BACKUP="$RUN_DIR/preferences/$PREFERENCES_DOMAIN.plist"
  if [[ -f "$PREFERENCES_PLIST" ]]; then
    PREFERENCES_EXISTED=1
    cp -p "$PREFERENCES_PLIST" "$PREFERENCES_BACKUP"
  fi

  # The menu-bar app has no dependable visible window. Force Sparkle's automatic
  # path and make the previous check stale so launch schedules a real check.
  "$DEFAULTS_BIN" write "$PREFERENCES_DOMAIN" autoUpdateEnabled -bool true
  "$DEFAULTS_BIN" write "$PREFERENCES_DOMAIN" SUEnableAutomaticChecks -bool true
  "$DEFAULTS_BIN" write "$PREFERENCES_DOMAIN" SUAutomaticallyUpdate -bool true
  "$DEFAULTS_BIN" write "$PREFERENCES_DOMAIN" SUScheduledCheckInterval -int 60
  "$DEFAULTS_BIN" write "$PREFERENCES_DOMAIN" SULastCheckTime -date '2001-01-01 00:00:00 +0000'
}

launch_disposable_app() {
  local executable
  local launch_home="$HOME"
  local log_suffix="$1"
  local pid
  executable="$(app_plist_value "$DISPOSABLE_APP" CFBundleExecutable)"
  [[ -n "$executable" && -x "$DISPOSABLE_APP/Contents/MacOS/$executable" ]] || die "disposable app executable is missing"

  # Production intentionally reseeds the actual user's managed runtime. Test
  # mode receives a fixture-local HOME, closing the last live-state escape.
  if [[ -n "$TEST_ROOT" ]]; then
    launch_home="$TEST_ROOT/home"
    mkdir -p "$launch_home"
  fi
  HOME="$launch_home" CFFIXED_USER_HOME="$launch_home" TMPDIR="$RUN_DIR/tmp" \
    "$DISPOSABLE_APP/Contents/MacOS/$executable" \
    >"$RUN_DIR/logs/app-${log_suffix}.out" 2>"$RUN_DIR/logs/app-${log_suffix}.err" &
  pid="$!"
  record_app_pid "$pid"
  log "disposable_app_pid=$pid phase=$log_suffix"
}

wait_for_disposable_update() {
  local deadline=$((SECONDS + TIMEOUT_SECONDS))
  local quit_at=$((SECONDS + DOWNLOAD_GRACE_SECONDS))
  local quit_requested=0
  local version
  local build

  while (( SECONDS < deadline )); do
    version="$(app_plist_value "$DISPOSABLE_APP" CFBundleShortVersionString)"
    build="$(app_plist_value "$DISPOSABLE_APP" CFBundleVersion)"
    if [[ "$version" == "$NEW_VERSION" && "$build" == "$NEW_BUILD" ]]; then
      return 0
    fi

    # Sparkle's automatic install commonly completes when the old app exits.
    # Terminate only PIDs launched by this run; never target a bundle id broadly.
    if [[ "$quit_requested" == "0" ]] && (( SECONDS >= quit_at )); then
      stop_tracked_apps
      quit_requested=1
    fi
    sleep 2
  done
  die "Sparkle transition timed out before exact version/build appeared"
}

wait_for_live_managed_manifest() {
  local deadline=$((SECONDS + TIMEOUT_SECONDS))
  local live_build
  local live_commit

  while (( SECONDS < deadline )); do
    if [[ -r "$MANAGED_MANIFEST" ]]; then
      live_build="$(manifest_build "$MANAGED_MANIFEST")"
      live_commit="$(manifest_commit "$MANAGED_MANIFEST")"
      if [[ "$live_build" == "$NEW_BUILD" && "$live_commit" == "$NEW_COMMIT" ]]; then
        log "proof.managed_runtime=ok bundle_version=$live_build git_commit=$live_commit"
        return 0
      fi
    fi
    sleep 2
  done
  die "live managed manifest did not reseed to the candidate build and commit"
}

launchctl_pid() {
  "$LAUNCHCTL_BIN" print "gui/$(id -u)/$GATEWAY_LABEL" 2>/dev/null | awk '/pid =/ {print $3; exit}'
}

restart_and_prove_gateway() {
  local old_pid
  local new_pid=""
  local deadline
  local proof
  local proof_commit

  old_pid="$(launchctl_pid || true)"
  [[ -n "$old_pid" ]] || die "$GATEWAY_LABEL has no loaded PID before exact restart"

  GATEWAY_RESTART_STARTED=1

  "$LAUNCHCTL_BIN" bootout "gui/$(id -u)/$GATEWAY_LABEL"
  "$LAUNCHCTL_BIN" bootstrap "gui/$(id -u)" "$GATEWAY_PLIST"

  deadline=$((SECONDS + TIMEOUT_SECONDS))
  while (( SECONDS < deadline )); do
    new_pid="$(launchctl_pid || true)"
    [[ -n "$new_pid" && "$new_pid" != "$old_pid" ]] && break
    sleep 2
  done
  [[ -n "$new_pid" && "$new_pid" != "$old_pid" ]] || die "exact gateway restart did not produce a replacement PID"

  if [[ -n "$TEST_ROOT" ]]; then
    proof="$(OPENCLAW_SPARKLE_E2E_TEST_ROOT="$TEST_ROOT" "$BASH_BIN" "$PROVE_RUNTIME_SCRIPT" --expected-commit "$NEW_COMMIT")" || \
      die "managed gateway runtime proof failed"
  else
    # The shared proof helper supports its own overrides. Strip the environment
    # so none can redirect production identity checks to synthetic state.
    proof="$(env -i HOME="$HOME" PATH="$PATH" "$BASH_BIN" "$PROVE_RUNTIME_SCRIPT" --expected-commit "$NEW_COMMIT")" || \
      die "managed gateway runtime proof failed"
  fi
  [[ "$proof" == *"jarvis_runtime_proof=true"* ]] || die "gateway proof omitted jarvis_runtime_proof=true"
  [[ "$proof" == *"service_label=$GATEWAY_LABEL"* ]] || die "gateway proof omitted exact service label"
  [[ "$proof" == *"runtime_source=jarvis-managed-bundle"* ]] || die "gateway proof did not establish managed-bundle provenance"
  proof_commit="$(printf '%s\n' "$proof" | sed -n 's/.*runtime_commit=//p' | head -n 1)"
  [[ -n "$proof_commit" && ( "$proof_commit" == "$NEW_COMMIT"* || "$NEW_COMMIT" == "$proof_commit"* ) ]] || \
    die "gateway proof runtime commit does not match candidate"

  GATEWAY_RESTART_FINISHED=1
  log "proof.gateway=ok label=$GATEWAY_LABEL old_pid=$old_pid new_pid=$new_pid runtime_source=jarvis-managed-bundle"
}

json_message_id() {
  "$JQ_BIN" -r '.message.message_id // .matched.message_id // .message_id // .id // empty' <<<"$1"
}

prove_optional_telegram() {
  if [[ -z "$TELEGRAM_CHAT" ]]; then
    log "proof.telegram=skipped"
    return 0
  fi

  local nonce="JARVIS_SPARKLE_E2E_$(date +%s)_${RANDOM:-0}"
  local send_json
  local wait_json
  local sent_id
  local reply_id
  local wait_args

  "$OPENCLAW_BIN" telegram-user precheck --chat "$TELEGRAM_CHAT" --json >/dev/null
  send_json="$("$OPENCLAW_BIN" telegram-user send --chat "$TELEGRAM_CHAT" --message "Reply exactly $nonce" --json)"
  sent_id="$(json_message_id "$send_json")"
  [[ -n "$sent_id" ]] || die "Telegram send returned no message id"

  wait_args=(telegram-user wait --chat "$TELEGRAM_CHAT" --after-id "$sent_id" --contains "$nonce" --json)
  wait_json="$("$OPENCLAW_BIN" "${wait_args[@]}")"
  reply_id="$(json_message_id "$wait_json")"
  [[ -n "$reply_id" ]] || die "Telegram wait returned no reply message id"
  "$JQ_BIN" -e --arg nonce "$nonce" '(.matched.text // .message.text // .text // "") == $nonce' <<<"$wait_json" >/dev/null || \
    die "Telegram reply was not exactly the nonce"

  log "proof.telegram=ok sent_message_id=$sent_id reply_message_id=$reply_id"
}

run_apply() {
  trap cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  prepare_owned_run
  backup_and_force_sparkle_preferences
  launch_disposable_app old
  wait_for_disposable_update

  verify_strict_app_trust "$DISPOSABLE_APP" updated-disposable
  verify_one_official_signing_identity "$DISPOSABLE_APP" updated-disposable
  [[ "$(app_designated_requirement "$DISPOSABLE_APP")" == "$(app_designated_requirement "$NEW_APP")" ]] || \
    die "updated disposable designated requirement does not match the signed candidate"
  [[ "$(manifest_build "$(app_manifest_path "$DISPOSABLE_APP")")" == "$NEW_BUILD" ]] || die "updated disposable manifest build mismatch"
  [[ "$(manifest_commit "$(app_manifest_path "$DISPOSABLE_APP")")" == "$NEW_COMMIT" ]] || die "updated disposable manifest commit mismatch"
  log "proof.sparkle_transition=ok from_version=$OLD_VERSION from_build=$OLD_BUILD to_version=$NEW_VERSION to_build=$NEW_BUILD"

  # Relaunch the replaced bundle explicitly. This is the event that lets the
  # new package seed Application Support before gateway restart/proof.
  stop_tracked_apps
  launch_disposable_app reseed
  wait_for_live_managed_manifest
  restart_and_prove_gateway
  prove_optional_telegram
}

main() {
  parse_args "$@"
  configure_test_root

  if [[ "$MODE" == "apply" ]]; then
    # Inspection stays lock-free. The apply campaign owns one reservation
    # before its live preflight snapshot and keeps it across app replacement,
    # reseed, restart, rollback handling, and optional Telegram proof.
    # shellcheck source=scripts/lib/heavy-local-slot.sh
    source "$ROOT_DIR/scripts/lib/heavy-local-slot.sh"
    openclaw_heavy_local_slot_require_or_reexec \
      "jarvis-sparkle-update-e2e" \
      "$ROOT_DIR" \
      "$ROOT_DIR/scripts/jarvis-sparkle-update-e2e.sh" \
      "${ORIGINAL_ARGS[@]}"
  fi

  run_preflight
  [[ "$MODE" == "apply" ]] || return 0
  run_apply
}

main "$@"
