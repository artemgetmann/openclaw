#!/usr/bin/env bash

# Fixture tests for the real Sparkle E2E control flow. The harness still reads
# actual app bundles/plists/manifests and runs its normal preflight/apply
# functions; only external trust, process, launchd, defaults, and Telegram
# commands are replaced with deterministic shims under the fixture root.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS="$ROOT_DIR/scripts/jarvis-sparkle-update-e2e.sh"
TEST_TMP="$(mktemp -d "${TMPDIR:-/tmp}/jarvis-sparkle-e2e-test.XXXXXX")"
TEST_TMP="$(cd "$TEST_TMP" && pwd -P)"
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM

OLD_COMMIT="1111111111111111111111111111111111111111"
NEW_COMMIT="2222222222222222222222222222222222222222"
PROTECTED_COMMIT="4444444444444444444444444444444444444444"
OLD_VERSION="2026.7.14.1"
NEW_VERSION="2026.7.15.1"
OLD_BUILD="2026071401"
NEW_BUILD="2026071501"
PROTECTED_BUILD="2026071402"
CANONICAL_FEED="https://github.com/artemgetmann/openclaw/releases/latest/download/jarvis-appcast.xml"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

pass() {
  printf 'PASS: %s\n' "$*"
}

write_app() {
  local app="$1"
  local version="$2"
  local build="$3"
  local commit="$4"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/OpenClawRuntime/openclaw"

  cat >"$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>ai.jarvis.mac</string>
  <key>CFBundleExecutable</key><string>OpenClaw</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$build</string>
  <key>SUFeedURL</key><string>$CANONICAL_FEED</string>
  <key>SUPublicEDKey</key><string>FIXTURESPARKLEPUBLICKEY</string>
</dict></plist>
EOF
  cat >"$app/Contents/Resources/OpenClawRuntime/manifest.json" <<EOF
{"format":1,"bundleVersion":"$build","gitCommit":"$commit","nodeVersion":"22.22.1","uvVersion":"0.9.21"}
EOF
  printf '{"name":"openclaw","version":"%s"}\n' "$version" >"$app/Contents/Resources/OpenClawRuntime/openclaw/package.json"
  printf 'strict-valid\n' >"$app/.fixture-codesign"
  printf 'strict-valid\n' >"$app/.fixture-gatekeeper"
  printf 'FIXTURETEAM\n' >"$app/.fixture-team"
  printf '%s\n' "$commit" >"$app/.fixture-cdhash"

  cat >"$app/Contents/MacOS/OpenClaw" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
app="${0%/Contents/MacOS/OpenClaw}"
"${OPENCLAW_SPARKLE_E2E_TEST_ROOT:?}/bin/app-hook" "$app"
trap 'exit 0' TERM INT HUP
while :; do sleep 1; done
EOF
  chmod +x "$app/Contents/MacOS/OpenClaw"
}

write_gateway_plist() {
  local fixture="$1"
  local state="$fixture/live/Jarvis/.jarvis"
  local plist="$fixture/live/LaunchAgents/ai.jarvis.gateway.plist"
  mkdir -p "$(dirname "$plist")"
  cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ai.jarvis.gateway</string>
  <key>ProgramArguments</key><array>
    <string>$state/tools/node/bin/node</string>
    <string>$state/lib/openclaw-bundled/dist/index.js</string>
    <string>gateway</string><string>run</string>
  </array>
  <key>WorkingDirectory</key><string>$state/lib/openclaw-bundled</string>
  <key>EnvironmentVariables</key><dict>
    <key>OPENCLAW_STATE_DIR</key><string>$state</string>
    <key>OPENCLAW_CONFIG_PATH</key><string>$state/openclaw.json</string>
    <key>OPENCLAW_LAUNCHD_LABEL</key><string>ai.jarvis.gateway</string>
    <key>OPENCLAW_PROFILE</key><string>consumer</string>
  </dict>
</dict></plist>
EOF
}

write_shims() {
  local fixture="$1"
  mkdir -p "$fixture/bin" "$fixture/control" "$fixture/logs"

  cat >"$fixture/bin/codesign" <<'EOF'
#!/usr/bin/env bash
app="${!#}"
grep -qx 'strict-valid' "$app/.fixture-codesign" || exit 1
team="$(cat "$app/.fixture-team")"
case "$*" in
  *'-dv'*)
    printf 'TeamIdentifier=%s\n' "$team" >&2
    printf 'CDHash=%s\n' "$(cat "$app/.fixture-cdhash")" >&2
    ;;
  *'-r-'*) printf 'designated => identifier "ai.jarvis.mac" and anchor apple generic and certificate leaf[subject.OU] = "%s"\n' "$team" >&2 ;;
esac
EOF

  cat >"$fixture/bin/spctl" <<'EOF'
#!/usr/bin/env bash
app="${!#}"
grep -qx 'strict-valid' "$app/.fixture-gatekeeper"
EOF

  cat >"$fixture/bin/curl" <<'EOF'
#!/usr/bin/env bash
cat "${OPENCLAW_SPARKLE_E2E_TEST_ROOT:?}/feed.xml"
EOF

  cat >"$fixture/bin/ps" <<'EOF'
#!/usr/bin/env bash
cat "${OPENCLAW_SPARKLE_E2E_TEST_ROOT:?}/control/processes"
EOF

  cat >"$fixture/bin/df" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

# Keep disk-gate fixtures independent of host free space. Sixteen GiB clears
# the normal artifact-relative floor, while the 999999 GiB negative case still
# exercises the harness's real insufficient-disk calculation and error path.
[[ "$#" == "2" && "$1" == "-Pk" ]]
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
printf 'fixture     33554432    0    16777216  0%%       %s\n' "$2"
EOF

  cat >"$fixture/bin/ditto" <<'EOF'
#!/usr/bin/env bash
set -e
source_path="$1"
destination="$2"
mkdir -p "$(dirname "$destination")"
cp -R "$source_path" "$destination"
printf 'ditto %s %s\n' "$source_path" "$destination" >>"${OPENCLAW_SPARKLE_E2E_TEST_ROOT:?}/logs/actions"
EOF

  cat >"$fixture/bin/defaults" <<'EOF'
#!/usr/bin/env bash
set -e
root="${OPENCLAW_SPARKLE_E2E_TEST_ROOT:?}"
plist="$root/live/Preferences/ai.jarvis.mac.plist"
command="$1"
domain="${2:-}"
case "$command" in
  write)
    mkdir -p "$(dirname "$plist")"
    printf '%s=%s %s\n' "$3" "${4:-}" "${5:-}" >>"$plist"
    printf 'defaults write %s\n' "$3" >>"$root/logs/actions"
    ;;
  import)
    [[ ! -e "$root/control/defaults-import-fail" ]] || exit 41
    cp "$3" "$plist"
    printf 'defaults import\n' >>"$root/logs/actions"
    ;;
  delete)
    rm -f "$plist"
    printf 'defaults delete\n' >>"$root/logs/actions"
    ;;
  *) exit 2 ;;
esac
EOF

  cat >"$fixture/bin/app-hook" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
root="${OPENCLAW_SPARKLE_E2E_TEST_ROOT:?}"
app="$1"
next_info=""
count_file="$root/control/launch-count"
count=0
[[ ! -f "$count_file" ]] || count="$(cat "$count_file")"
count=$((count + 1))
printf '%s\n' "$count" >"$count_file"
printf 'app launch %s\n' "$count" >>"$root/logs/actions"

# Model Sparkle's per-run cache entry. A successful framework-owned cleanup
# removes it on relaunch; the harness itself must never delete cache entries.
mkdir -p "$root/live/Caches/ai.jarvis.mac/org.sparkle-project.Sparkle/run-created"
printf 'staged\n' >"$root/live/Caches/ai.jarvis.mac/org.sparkle-project.Sparkle/run-created/payload"

if [[ "$count" == "1" && ! -e "$root/control/no-transition" ]]; then
  new="$root/apps/new/Jarvis.app"
  next_info="$app/Contents/Info.plist.fixture-next"

  # wait_for_disposable_update treats the target version/build in Info.plist as
  # the completed-update signal. Stage that signal first, but publish it only
  # after every payload and signing fixture has reached its final state. This
  # models Sparkle's completed bundle replacement and prevents the harness from
  # observing a new version paired with stale signer metadata.
  cp "$new/Contents/Info.plist" "$next_info"
  cp "$new/Contents/Resources/OpenClawRuntime/manifest.json" "$app/Contents/Resources/OpenClawRuntime/manifest.json"
  cp "$new/Contents/Resources/OpenClawRuntime/openclaw/package.json" "$app/Contents/Resources/OpenClawRuntime/openclaw/package.json"
  cp "$new/.fixture-codesign" "$app/.fixture-codesign"
  cp "$new/.fixture-gatekeeper" "$app/.fixture-gatekeeper"
  cp "$new/.fixture-team" "$app/.fixture-team"
  cp "$new/.fixture-cdhash" "$app/.fixture-cdhash"
  if [[ -e "$root/control/post-update-foreign-team" ]]; then
    printf 'OTHERTEAM\n' >"$app/.fixture-team"
  fi
  if [[ -e "$root/control/post-update-cdhash-drift" ]]; then
    printf '8888888888888888888888888888888888888888\n' >"$app/.fixture-cdhash"
  fi

fi

if [[ "$count" -ge "2" ]]; then
  rm -rf "$root/live/Caches/ai.jarvis.mac/org.sparkle-project.Sparkle/run-created"
fi

# This entry is intentionally unattributed: it appears after the snapshot and
# must survive the harness cleanup regardless of process inspection.
if [[ -e "$root/control/foreign-cache-entry" ]]; then
  mkdir -p "$root/live/Caches/ai.jarvis.mac/org.sparkle-project.Sparkle/foreign-entry"
  printf 'foreign\n' >"$root/live/Caches/ai.jarvis.mac/org.sparkle-project.Sparkle/foreign-entry/payload"
fi

# Only the explicit second launch seeds the live managed receipt. This catches
# a harness that accidentally substitutes the candidate bundle manifest.
if [[ "$count" -ge "2" && ! -e "$root/control/no-reseed" ]]; then
  mkdir -p "$root/live/Jarvis/.jarvis"
  cp "$app/Contents/Resources/OpenClawRuntime/manifest.json" \
    "$root/live/Jarvis/.jarvis/.consumer-bundled-runtime.json"
  printf 'managed manifest reseeded\n' >>"$root/logs/actions"
fi

if [[ -n "$next_info" ]]; then
  # Publish the completion marker after every first-launch side effect,
  # including intentionally foreign cache residue. Readers therefore see
  # either the old marker or a fully settled synthetic Sparkle transaction.
  mv "$next_info" "$app/Contents/Info.plist"
fi
EOF

  cat >"$fixture/bin/launchctl" <<'EOF'
#!/usr/bin/env bash
set -e
root="${OPENCLAW_SPARKLE_E2E_TEST_ROOT:?}"
state="$root/control/gateway-state"
command="$1"
case "$command" in
  print)
    loaded="$(sed -n 's/^loaded=//p' "$state")"
    pid="$(sed -n 's/^pid=//p' "$state")"
    [[ "$loaded" == "1" ]] || exit 113
    printf 'state = running\npid = %s\n' "$pid"
    ;;
  bootout)
    printf 'loaded=0\npid=\n' >"$state"
    printf 'launchctl bootout\n' >>"$root/logs/actions"
    ;;
  bootstrap)
    [[ "$3" == "$root/live/LaunchAgents/ai.jarvis.gateway.plist" ]]
    printf 'loaded=1\npid=202\n' >"$state"
    printf 'launchctl bootstrap\n' >>"$root/logs/actions"
    ;;
  *) exit 2 ;;
esac
EOF

  cat >"$fixture/bin/prove-jarvis-runtime" <<'EOF'
#!/usr/bin/env bash
set -e
root="${OPENCLAW_SPARKLE_E2E_TEST_ROOT:?}"
[[ ! -e "$root/control/prove-fail" ]] || exit 31
if [[ "$*" == *'--runtime-source jarvis-break-glass-hotfix'* ]]; then
  commit="$(jq -r '.protectedRuntimeGitCommit' "$root/live/Jarvis/.jarvis/.consumer-bundled-runtime.protection.json")"
  source='jarvis-break-glass-hotfix'
  [[ ! -e "$root/control/protected-proof-drift" ]] || commit='7777777777777777777777777777777777777777'
else
  commit="$(jq -r '.gitCommit' "$root/live/Jarvis/.jarvis/.consumer-bundled-runtime.json")"
  source='jarvis-managed-bundle'
fi
printf '[prove-jarvis-runtime] jarvis_runtime_proof=true\n'
printf '[prove-jarvis-runtime] service_label=ai.jarvis.gateway\n'
printf '[prove-jarvis-runtime] runtime_source=%s\n' "$source"
printf '[prove-jarvis-runtime] runtime_commit=%s\n' "$commit"
EOF

  cat >"$fixture/bin/openclaw" <<'EOF'
#!/usr/bin/env bash
set -e
root="${OPENCLAW_SPARKLE_E2E_TEST_ROOT:?}"
printf 'openclaw %s\n' "$*" >>"$root/logs/actions"
case "$*" in
  *'telegram-user precheck'*) printf '{"ok":true}\n' ;;
  *'telegram-user send'*)
    nonce="$(printf '%s\n' "$*" | sed -E 's/.*Reply exactly ([A-Z0-9_]+).*/\1/')"
    printf '%s\n' "$nonce" >"$root/control/telegram-nonce"
    printf '{"message":{"message_id":501,"sender_id":777}}\n'
    ;;
  *'telegram-user wait'*)
    [[ "$*" != *'--sender-id'* ]] || exit 9
    [[ "$*" == *'--after-id 501'* ]] || exit 10
    nonce="$(cat "$root/control/telegram-nonce")"
    if [[ -e "$root/control/telegram-embedded-reply" ]]; then
      printf '{"matched":{"message_id":502,"text":"quoted %s suffix"}}\n' "$nonce"
    else
      printf '{"matched":{"message_id":502,"text":"%s"}}\n' "$nonce"
    fi
    ;;
  *) exit 2 ;;
esac
EOF

  chmod +x "$fixture/bin/"*
}

make_fixture() {
  local fixture="$1"
  mkdir -p "$fixture/apps/old" "$fixture/apps/new" "$fixture/apps/installed"
  write_app "$fixture/apps/old/Jarvis.app" "$OLD_VERSION" "$OLD_BUILD" "$OLD_COMMIT"
  write_app "$fixture/apps/new/Jarvis.app" "$NEW_VERSION" "$NEW_BUILD" "$NEW_COMMIT"
  cp -R "$fixture/apps/old/Jarvis.app" "$fixture/apps/installed/Jarvis.app"
  mkdir -p "$fixture/live/Jarvis/.jarvis" "$fixture/live/Preferences"
  mkdir -p "$fixture/live/Caches/ai.jarvis.mac/org.sparkle-project.Sparkle/preexisting"
  printf 'keep\n' >"$fixture/live/Caches/ai.jarvis.mac/org.sparkle-project.Sparkle/preexisting/payload"
  cp "$fixture/apps/old/Jarvis.app/Contents/Resources/OpenClawRuntime/manifest.json" \
    "$fixture/live/Jarvis/.jarvis/.consumer-bundled-runtime.json"
  printf 'unrelatedKey=preserve-me\n' >"$fixture/live/Preferences/ai.jarvis.mac.plist"
  write_gateway_plist "$fixture"
  write_shims "$fixture"
  : >"$fixture/control/processes"
  printf 'loaded=1\npid=101\n' >"$fixture/control/gateway-state"
  cat >"$fixture/feed.xml" <<EOF
<?xml version="1.0"?><rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel>
<item><title>Jarvis $NEW_VERSION</title><sparkle:version>$NEW_BUILD</sparkle:version><sparkle:shortVersionString>$NEW_VERSION</sparkle:shortVersionString><enclosure url="https://github.com/artemgetmann/openclaw/releases/download/v-fixture/Jarvis.zip" length="123456789" sparkle:edSignature="YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYQ==" /></item>
<item><title>Jarvis $OLD_VERSION</title><sparkle:version>$OLD_BUILD</sparkle:version><sparkle:shortVersionString>$OLD_VERSION</sparkle:shortVersionString><enclosure url="https://example.invalid/Jarvis.zip" /></item>
</channel></rss>
EOF
}

write_protected_receipt() {
  local fixture="$1"
  local state="$fixture/live/Jarvis/.jarvis"
  local marker="$state/.consumer-bundled-runtime.protection.json"
  local backup="$state/.consumer-bundled-runtime.json.backup.fixture"
  local requirement='identifier "ai.jarvis.mac" and anchor apple generic and certificate leaf[subject.OU] = "FIXTURETEAM"'
  local requirement_hash
  local issued_at
  local expires_at
  local protected_build
  local protected_commit
  requirement_hash="$(printf '%s' "$requirement" | shasum -a 256 | awk '{print $1}')"
  issued_at="$(node -e 'process.stdout.write(new Date(Date.now() - 60000).toISOString())')"
  expires_at="$(node -e 'process.stdout.write(new Date(Date.now() + 3600000).toISOString())')"
  protected_build="$(jq -r '.bundleVersion' "$backup")"
  protected_commit="$(jq -r '.gitCommit' "$backup")"

  jq -n \
    --arg issuedAt "$issued_at" \
    --arg expiresAt "$expires_at" \
    --arg installedCommit "$OLD_COMMIT" \
    --arg installedCdHash "$OLD_COMMIT" \
    --arg requirementHash "$requirement_hash" \
    --arg compatibilityManifestSha256 "$(shasum -a 256 "$state/.consumer-bundled-runtime.json" | awk '{print $1}')" \
    --arg backupManifestSha256 "$(shasum -a 256 "$backup" | awk '{print $1}')" \
    --arg protectionMarkerSha256 "$(shasum -a 256 "$marker" | awk '{print $1}')" \
    --arg markerSource "$fixture/apps/installed/Jarvis.app" \
    --arg protectedBuild "$protected_build" \
    --arg protectedCommit "$protected_commit" \
    --arg targetCommit "$NEW_COMMIT" \
    --arg feedURL "$CANONICAL_FEED" \
    --arg targetCdHash "$NEW_COMMIT" \
    --arg sparkleKeyHash "$(printf '%s' 'FIXTURESPARKLEPUBLICKEY' | shasum -a 256 | awk '{print $1}')" \
    --arg enclosureURL "https://github.com/artemgetmann/openclaw/releases/download/v-fixture/Jarvis.zip" \
    --arg enclosureLength "123456789" \
    --arg enclosureSignatureHash "$(printf '%s' 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYQ==' | shasum -a 256 | awk '{print $1}')" \
    '{
      schemaVersion: 1,
      kind: "jarvis-sparkle-protected-hotfix-baseline-compatibility",
      receiptId: "fixture-protected-hotfix-transition",
      issuedAt: $issuedAt,
      expiresAt: $expiresAt,
      intent: {operation: "sparkle-n-to-n-plus-1", oneTimeUse: true, feedURL: $feedURL},
      installedApp: {
        bundleIdentifier: "ai.jarvis.mac",
        version: "2026.7.14.1",
        build: "2026071401",
        gitCommit: $installedCommit,
        teamIdentifier: "FIXTURETEAM",
        designatedRequirementSha256: $requirementHash,
        codeDirectoryHash: $installedCdHash
      },
      protectedRuntime: {
        runtimeSource: "jarvis-break-glass-hotfix",
        gitCommit: $protectedCommit,
        bundleVersion: $protectedBuild,
        compatibilityManifestGitCommit: $installedCommit,
        compatibilityManifestBundleVersion: "2026071401",
        compatibilityManifestSource: $markerSource,
        compatibilityManifestSha256: $compatibilityManifestSha256,
        backupManifestSha256: $backupManifestSha256,
        protectionMarkerSha256: $protectionMarkerSha256
      },
      targetRelease: {
        bundleIdentifier: "ai.jarvis.mac",
        version: "2026.7.15.1",
        build: "2026071501",
        gitCommit: $targetCommit,
        feedURL: $feedURL,
        teamIdentifier: "FIXTURETEAM",
        designatedRequirementSha256: $requirementHash,
        codeDirectoryHash: $targetCdHash,
        sparklePublicEdKeySha256: $sparkleKeyHash,
        enclosureURL: $enclosureURL,
        enclosureLength: $enclosureLength,
        enclosureEdSignatureSha256: $enclosureSignatureHash
      }
    }' >"$fixture/protected-hotfix-receipt.json"
}

protect_fixture() {
  local fixture="$1"
  local state="$fixture/live/Jarvis/.jarvis"
  local backup="$state/.consumer-bundled-runtime.json.backup.fixture"
  printf 'gatekeeper-rejected\n' >"$fixture/apps/old/Jarvis.app/.fixture-gatekeeper"
  printf 'gatekeeper-rejected\n' >"$fixture/apps/installed/Jarvis.app/.fixture-gatekeeper"
  printf '{"format":1,"bundleVersion":"%s","gitCommit":"%s"}\n' "$PROTECTED_BUILD" "$PROTECTED_COMMIT" >"$backup"
  cat >"$state/.consumer-bundled-runtime.protection.json" <<EOF
{"format":1,"protectedRuntimeGitCommit":"$PROTECTED_COMMIT","compatibilityManifestGitCommit":"$OLD_COMMIT","compatibilityManifestBundleVersion":"$OLD_BUILD","compatibilityManifestSource":"$fixture/apps/installed/Jarvis.app","backupPath":"$backup","createdAt":"2026-08-02T00:00:00Z"}
EOF
  write_protected_receipt "$fixture"
}

protect_signed_app_fixture() {
  local fixture="$1"

  # Keep the exact public app Gatekeeper-valid while installing the same
  # protected-runtime provenance used by the private-hotfix fixture.
  protect_fixture "$fixture"
  printf 'strict-valid\n' >"$fixture/apps/old/Jarvis.app/.fixture-gatekeeper"
  printf 'strict-valid\n' >"$fixture/apps/installed/Jarvis.app/.fixture-gatekeeper"
}

harness_env() {
  local fixture="$1"
  shift
  # The production heavy-work wrapper deliberately lowers scheduling priority.
  # Keep fixture deadlines wide enough that host contention does not masquerade
  # as a Sparkle transition failure.
  OPENCLAW_SPARKLE_E2E_TEST_MODE=1 \
  OPENCLAW_SPARKLE_E2E_TEST_ROOT="$fixture" \
  OPENCLAW_CODESIGN_BIN="$fixture/bin/codesign" \
  OPENCLAW_SPCTL_BIN="$fixture/bin/spctl" \
  OPENCLAW_CURL_BIN="$fixture/bin/curl" \
  OPENCLAW_PS_BIN="$fixture/bin/ps" \
  OPENCLAW_DF_BIN="$fixture/bin/df" \
  OPENCLAW_DEFAULTS_BIN="$fixture/bin/defaults" \
  OPENCLAW_DITTO_BIN="$fixture/bin/ditto" \
  OPENCLAW_LAUNCHCTL_BIN="$fixture/bin/launchctl" \
  OPENCLAW_JARVIS_CLI_BIN="$fixture/bin/openclaw" \
  OPENCLAW_PROVE_JARVIS_RUNTIME_SCRIPT="$fixture/bin/prove-jarvis-runtime" \
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$fixture/control/canonical-release.lock" \
    "$HARNESS" \
      --test-root "$fixture" \
      --old-app "$fixture/apps/old/Jarvis.app" \
      --new-app "$fixture/apps/new/Jarvis.app" \
      --expected-commit "$NEW_COMMIT" \
      --scratch-root "$fixture/runs" \
      --min-free-gb "${JARVIS_TEST_MIN_FREE_GB:-0}" \
      --download-grace 1 \
      --timeout "${JARVIS_TEST_TIMEOUT_SECONDS:-60}" \
      "$@"
}

run_expect_fail() {
  local label="$1"
  local fixture="$2"
  local expected="$3"
  shift 3
  local output
  local status
  set +e
  output="$(harness_env "$fixture" "$@" 2>&1)"
  status="$?"
  set -e
  [[ "$status" -ne 0 ]] || fail "$label unexpectedly passed"
  [[ "$output" == *"$expected"* ]] || {
    printf '%s\n' "$output" >&2
    fail "$label failed for the wrong reason; expected: $expected"
  }
  [[ ! -e "$fixture/runs" ]] || {
    find "$fixture/runs" -mindepth 1 -print -quit | grep -q . && fail "$label wrote a run before preflight completed"
  }
  pass "$label"
}

fixture_hashes() {
  local fixture="$1"
  find "$fixture" -type f -print0 | sort -z | xargs -0 shasum -a 256
}

mkdir -p "$TEST_TMP/base/runs"
make_fixture "$TEST_TMP/base"

bash -n "$HARNESS"
pass "harness parses"

# Production mode must ignore every proof-command override. A nonexistent jq
# override would fail before argument validation if the test seam leaked.
set +e
override_output="$(OPENCLAW_JQ_BIN=/definitely/not/jq OPENCLAW_DF_BIN=/definitely/not/df "$HARNESS" 2>&1)"
override_status="$?"
set -e
[[ "$override_status" -ne 0 && "$override_output" == *"--old-app and --new-app are required"* ]] || \
  fail "production mode accepted a test command override"
pass "production command paths cannot be overridden"
grep -q '^PATH="/usr/bin:/bin:/usr/sbin:/sbin"$' "$HARNESS" || fail "production PATH is not pinned"
grep -q '^DF_BIN="/bin/df"$' "$HARNESS" || fail "production df binary is not pinned"
grep -q 'NODE_BIN="/opt/homebrew/bin/node"' "$HARNESS" || fail "Node proof binary is not allowlisted"
grep -q 'BASH_BIN="/bin/bash"' "$HARNESS" || fail "runtime proof shell is not pinned"
grep -q 'env -i HOME="$HOME" PATH="$PATH" "$BASH_BIN" "$PROVE_RUNTIME_SCRIPT"' "$HARNESS" || \
  fail "production protected-runtime proof does not strip ambient overrides"
pass "production PATH and proof interpreters are pinned"

before="$(fixture_hashes "$TEST_TMP/base")"
preflight_output="$(harness_env "$TEST_TMP/base")"
after="$(fixture_hashes "$TEST_TMP/base")"
[[ "$before" == "$after" ]] || fail "default preflight wrote fixture state"
[[ "$preflight_output" == *"preflight=passed mode=preflight mutation=disabled"* ]] || fail "default preflight did not pass read-only"
[[ "$preflight_output" == *"proof.managed_runtime=pending_apply"* ]] || fail "preflight overstated managed runtime proof"
pass "default actual preflight is read-only"

copy_case() {
  local name="$1"
  cp -R "$TEST_TMP/base" "$TEST_TMP/$name"
  # The plist contains absolute managed-runtime paths, so each copied case
  # must receive its own identity instead of accidentally failing on base paths.
  write_gateway_plist "$TEST_TMP/$name"
  printf '%s\n' "$TEST_TMP/$name"
}

case_root="$(copy_case protected-exact)"
protect_fixture "$case_root"
before="$(fixture_hashes "$case_root")"
protected_output="$(harness_env "$case_root" --protected-hotfix-compatibility-receipt "$case_root/protected-hotfix-receipt.json")"
after="$(fixture_hashes "$case_root")"
[[ "$before" == "$after" ]] || fail "accepted protected-hotfix preflight wrote fixture state"
[[ "$protected_output" == *"baseline_mode=accepted_protected_hotfix_compatibility_receipt"* ]] || \
  fail "exact protected-hotfix receipt was not distinguished in proof output"
[[ "$protected_output" == *"proof.protected_runtime=receipt_and_live_bound commit=$PROTECTED_COMMIT"* ]] || \
  fail "accepted receipt omitted protected runtime identity"
pass "exact protected-hotfix compatibility receipt is accepted read-only"

case_root="$(copy_case signed-app-protected-runtime)"
protect_signed_app_fixture "$case_root"
signed_protected_output="$(harness_env "$case_root" --protected-hotfix-compatibility-receipt "$case_root/protected-hotfix-receipt.json")"
[[ "$signed_protected_output" == *"baseline_mode=accepted_signed_app_protected_runtime_compatibility_receipt"* ]] || \
  fail "signed installed app plus protected runtime receipt was not accepted explicitly"
[[ "$signed_protected_output" == *"proof.protected_runtime=receipt_and_live_bound commit=$PROTECTED_COMMIT"* ]] || \
  fail "signed installed app receipt omitted protected runtime identity"
pass "signed installed app plus protected runtime receipt is accepted read-only"

case_root="$(copy_case signed-app-protected-runtime-drift)"
protect_signed_app_fixture "$case_root"
: >"$case_root/control/protected-proof-drift"
run_expect_fail "signed app protected runtime drift blocks" "$case_root" "live protected runtime proof did not return the exact receipt identity" \
  --protected-hotfix-compatibility-receipt "$case_root/protected-hotfix-receipt.json"

case_root="$(copy_case signed-app-protected-runtime-extra-field)"
protect_signed_app_fixture "$case_root"
jq '.protectedRuntime.allowSignedAppBypass = true' "$case_root/protected-hotfix-receipt.json" >"$case_root/receipt.tmp"
mv "$case_root/receipt.tmp" "$case_root/protected-hotfix-receipt.json"
run_expect_fail "signed app protected receipt extra field blocks" "$case_root" "protectedRuntime has missing or ambiguous fields" \
  --protected-hotfix-compatibility-receipt "$case_root/protected-hotfix-receipt.json"

case_root="$(copy_case protected-target-older-than-runtime)"
protect_fixture "$case_root"
printf '{"format":1,"bundleVersion":"2026071601","gitCommit":"%s"}\n' "$PROTECTED_COMMIT" \
  >"$case_root/live/Jarvis/.jarvis/.consumer-bundled-runtime.json.backup.fixture"
write_protected_receipt "$case_root"
run_expect_fail "target older than protected runtime blocks" "$case_root" "target release build is not newer than protected runtime build" \
  --protected-hotfix-compatibility-receipt "$case_root/protected-hotfix-receipt.json"

case_root="$(copy_case protected-live-runtime-drift)"
protect_fixture "$case_root"
: >"$case_root/control/protected-proof-drift"
run_expect_fail "live protected runtime drift blocks" "$case_root" "live protected runtime proof did not return the exact receipt identity" \
  --protected-hotfix-compatibility-receipt "$case_root/protected-hotfix-receipt.json"

case_root="$(copy_case protected-missing-receipt)"
protect_fixture "$case_root"
run_expect_fail "Gatekeeper failure without receipt blocks" "$case_root" "failed Gatekeeper without a valid protected-hotfix compatibility receipt"

case_root="$(copy_case protected-unsigned)"
protect_fixture "$case_root"
printf 'invalid\n' >"$case_root/apps/installed/Jarvis.app/.fixture-codesign"
run_expect_fail "receipt cannot authorize unsigned installed app" "$case_root" "installed app failed strict codesign" \
  --protected-hotfix-compatibility-receipt "$case_root/protected-hotfix-receipt.json"

case_root="$(copy_case protected-unrelated-private-build)"
protect_fixture "$case_root"
sed -i.bak "s/$OLD_COMMIT/5555555555555555555555555555555555555555/" \
  "$case_root/apps/installed/Jarvis.app/Contents/Resources/OpenClawRuntime/manifest.json"
rm -f "$case_root/apps/installed/Jarvis.app/Contents/Resources/OpenClawRuntime/manifest.json.bak"
run_expect_fail "receipt rejects unrelated private build" "$case_root" "installed/live mismatch" \
  --protected-hotfix-compatibility-receipt "$case_root/protected-hotfix-receipt.json"

case_root="$(copy_case protected-signing-drift)"
protect_fixture "$case_root"
printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' >"$case_root/apps/installed/Jarvis.app/.fixture-cdhash"
run_expect_fail "receipt rejects private signing identity drift" "$case_root" "signing identities differ" \
  --protected-hotfix-compatibility-receipt "$case_root/protected-hotfix-receipt.json"

case_root="$(copy_case protected-target-signing-incompatible)"
protect_fixture "$case_root"
printf 'OTHERTEAM\n' >"$case_root/apps/old/Jarvis.app/.fixture-team"
printf 'OTHERTEAM\n' >"$case_root/apps/installed/Jarvis.app/.fixture-team"
run_expect_fail "receipt rejects Sparkle-incompatible private signing identity" "$case_root" "incompatible with the signed public target" \
  --protected-hotfix-compatibility-receipt "$case_root/protected-hotfix-receipt.json"

case_root="$(copy_case protected-missing-sparkle-key)"
protect_fixture "$case_root"
/usr/libexec/PlistBuddy -c 'Delete :SUPublicEDKey' "$case_root/apps/installed/Jarvis.app/Contents/Info.plist"
run_expect_fail "receipt rejects missing private Sparkle public key" "$case_root" "Sparkle public key is missing or incompatible" \
  --protected-hotfix-compatibility-receipt "$case_root/protected-hotfix-receipt.json"

case_root="$(copy_case protected-mismatched-sparkle-key)"
protect_fixture "$case_root"
/usr/libexec/PlistBuddy -c 'Set :SUPublicEDKey OTHERFIXTURESPARKLEKEY' "$case_root/apps/old/Jarvis.app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :SUPublicEDKey OTHERFIXTURESPARKLEKEY' "$case_root/apps/installed/Jarvis.app/Contents/Info.plist"
run_expect_fail "receipt rejects private Sparkle public key mismatch" "$case_root" "Sparkle public key is missing or incompatible" \
  --protected-hotfix-compatibility-receipt "$case_root/protected-hotfix-receipt.json"

case_root="$(copy_case protected-target-code-directory-drift)"
protect_fixture "$case_root"
printf '7777777777777777777777777777777777777777\n' >"$case_root/apps/new/Jarvis.app/.fixture-cdhash"
run_expect_fail "receipt rejects target CodeDirectory drift" "$case_root" "targetRelease.codeDirectoryHash mismatch" \
  --protected-hotfix-compatibility-receipt "$case_root/protected-hotfix-receipt.json"

case_root="$(copy_case protected-feed-length-drift)"
protect_fixture "$case_root"
sed -i.bak 's/length="123456789"/length="987654321"/' "$case_root/feed.xml"
rm -f "$case_root/feed.xml.bak"
run_expect_fail "receipt rejects appcast enclosure length drift" "$case_root" "targetRelease.enclosureLength mismatch" \
  --protected-hotfix-compatibility-receipt "$case_root/protected-hotfix-receipt.json"

case_root="$(copy_case protected-feed-signature-drift)"
protect_fixture "$case_root"
sed -i.bak 's/YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYQ==/YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYg==/' "$case_root/feed.xml"
rm -f "$case_root/feed.xml.bak"
run_expect_fail "receipt rejects appcast EdDSA signature drift" "$case_root" "targetRelease.enclosureEdSignatureSha256 mismatch" \
  --protected-hotfix-compatibility-receipt "$case_root/protected-hotfix-receipt.json"

case_root="$(copy_case protected-feed-url-drift)"
protect_fixture "$case_root"
sed -i.bak 's#releases/download/v-fixture/Jarvis.zip#releases/download/v-other/Jarvis.zip#' "$case_root/feed.xml"
rm -f "$case_root/feed.xml.bak"
run_expect_fail "receipt rejects appcast enclosure URL drift" "$case_root" "targetRelease.enclosureURL mismatch" \
  --protected-hotfix-compatibility-receipt "$case_root/protected-hotfix-receipt.json"

case_root="$(copy_case protected-stale)"
protect_fixture "$case_root"
jq '.expiresAt = "2000-01-01T00:00:00.000Z"' "$case_root/protected-hotfix-receipt.json" >"$case_root/receipt.tmp"
mv "$case_root/receipt.tmp" "$case_root/protected-hotfix-receipt.json"
run_expect_fail "stale protected receipt blocks" "$case_root" "receipt is stale" \
  --protected-hotfix-compatibility-receipt "$case_root/protected-hotfix-receipt.json"

case_root="$(copy_case protected-target-drift)"
protect_fixture "$case_root"
jq '.targetRelease.build = "9999999999"' "$case_root/protected-hotfix-receipt.json" >"$case_root/receipt.tmp"
mv "$case_root/receipt.tmp" "$case_root/protected-hotfix-receipt.json"
run_expect_fail "protected receipt target drift blocks" "$case_root" "targetRelease.build mismatch" \
  --protected-hotfix-compatibility-receipt "$case_root/protected-hotfix-receipt.json"

case_root="$(copy_case protected-ambiguous-schema)"
protect_fixture "$case_root"
jq '.allowAnyUnsignedApp = true' "$case_root/protected-hotfix-receipt.json" >"$case_root/receipt.tmp"
mv "$case_root/receipt.tmp" "$case_root/protected-hotfix-receipt.json"
run_expect_fail "ambiguous protected receipt schema blocks" "$case_root" "receipt has missing or ambiguous fields" \
  --protected-hotfix-compatibility-receipt "$case_root/protected-hotfix-receipt.json"

case_root="$(copy_case protected-missing-marker)"
protect_fixture "$case_root"
rm -f "$case_root/live/Jarvis/.jarvis/.consumer-bundled-runtime.protection.json"
run_expect_fail "missing protected provenance blocks" "$case_root" "protected-hotfix protection marker" \
  --protected-hotfix-compatibility-receipt "$case_root/protected-hotfix-receipt.json"

case_root="$(copy_case protected-backup-drift)"
protect_fixture "$case_root"
printf '{"format":1,"bundleVersion":"%s","gitCommit":"%s"}\n' "$PROTECTED_BUILD" \
  "6666666666666666666666666666666666666666" >"$case_root/live/Jarvis/.jarvis/.consumer-bundled-runtime.json.backup.fixture"
run_expect_fail "protected backup drift blocks" "$case_root" "backupManifestSha256 mismatch" \
  --protected-hotfix-compatibility-receipt "$case_root/protected-hotfix-receipt.json"

case_root="$(copy_case protected-replay)"
protect_fixture "$case_root"
harness_env "$case_root" --apply --protected-hotfix-compatibility-receipt "$case_root/protected-hotfix-receipt.json" >/dev/null
run_expect_fail "protected receipt replay after transition blocks" "$case_root" "protectedRuntime.compatibilityManifestGitCommit mismatch" \
  --protected-hotfix-compatibility-receipt "$case_root/protected-hotfix-receipt.json"

case_root="$(copy_case protected-post-update-target-drift)"
protect_fixture "$case_root"
: >"$case_root/control/post-update-cdhash-drift"
run_expect_fail "protected apply rejects a downloaded target with CodeDirectory drift" "$case_root" "updated disposable CodeDirectory hash does not match" \
  --apply --protected-hotfix-compatibility-receipt "$case_root/protected-hotfix-receipt.json"

case_root="$(copy_case test-mode-fail-shut)"
set +e
test_mode_output="$(OPENCLAW_SPARKLE_E2E_TEST_MODE=1 "$HARNESS" \
  --test-root "$case_root" \
  --old-app "$case_root/apps/old/Jarvis.app" \
  --new-app "$case_root/apps/new/Jarvis.app" \
  --expected-commit "$NEW_COMMIT" \
  --scratch-root "$case_root/runs" \
  --apply 2>&1)"
test_mode_status="$?"
set -e
[[ "$test_mode_status" -ne 0 && "$test_mode_output" == *"test mode requires OPENCLAW_CODESIGN_BIN"* ]] || \
  fail "test mode fell through to non-fixture commands"
[[ ! -e "$case_root/control/launch-count" ]] || fail "fail-shut test mode launched an app"
pass "test mode requires fixture-local proof and mutation commands"

case_root="$(copy_case test-mode-symlink-escape)"
ln -sf /bin/true "$case_root/bin/escaped-launchctl"
set +e
symlink_output="$(OPENCLAW_SPARKLE_E2E_TEST_MODE=1 \
  OPENCLAW_CODESIGN_BIN="$case_root/bin/codesign" \
  OPENCLAW_SPCTL_BIN="$case_root/bin/spctl" \
  OPENCLAW_CURL_BIN="$case_root/bin/curl" \
  OPENCLAW_PS_BIN="$case_root/bin/ps" \
  OPENCLAW_DF_BIN="$case_root/bin/df" \
  OPENCLAW_DEFAULTS_BIN="$case_root/bin/defaults" \
  OPENCLAW_DITTO_BIN="$case_root/bin/ditto" \
  OPENCLAW_LAUNCHCTL_BIN="$case_root/bin/escaped-launchctl" \
  OPENCLAW_JARVIS_CLI_BIN="$case_root/bin/openclaw" \
  OPENCLAW_PROVE_JARVIS_RUNTIME_SCRIPT="$case_root/bin/prove-jarvis-runtime" \
  "$HARNESS" --test-root "$case_root" 2>&1)"
symlink_status="$?"
set -e
[[ "$symlink_status" -ne 0 && "$symlink_output" == *"OPENCLAW_LAUNCHCTL_BIN"* ]] || \
  fail "test-mode command symlink escaped the fixture root"
pass "test mode rejects command symlink escapes"

case_root="$(copy_case test-mode-df-symlink-escape)"
ln -sf /bin/df "$case_root/bin/escaped-df"
set +e
df_symlink_output="$(OPENCLAW_SPARKLE_E2E_TEST_MODE=1 \
  OPENCLAW_CODESIGN_BIN="$case_root/bin/codesign" \
  OPENCLAW_SPCTL_BIN="$case_root/bin/spctl" \
  OPENCLAW_CURL_BIN="$case_root/bin/curl" \
  OPENCLAW_PS_BIN="$case_root/bin/ps" \
  OPENCLAW_DF_BIN="$case_root/bin/escaped-df" \
  OPENCLAW_DEFAULTS_BIN="$case_root/bin/defaults" \
  OPENCLAW_DITTO_BIN="$case_root/bin/ditto" \
  OPENCLAW_LAUNCHCTL_BIN="$case_root/bin/launchctl" \
  OPENCLAW_JARVIS_CLI_BIN="$case_root/bin/openclaw" \
  OPENCLAW_PROVE_JARVIS_RUNTIME_SCRIPT="$case_root/bin/prove-jarvis-runtime" \
  "$HARNESS" --test-root "$case_root" 2>&1)"
df_symlink_status="$?"
set -e
[[ "$df_symlink_status" -ne 0 && "$df_symlink_output" == *"OPENCLAW_DF_BIN"* ]] || \
  fail "test-mode df symlink escaped the fixture root"
pass "test mode rejects df symlink escapes"

case_root="$(copy_case missing-old)"
rm -rf "$case_root/apps/old/Jarvis.app"
run_expect_fail "missing old baseline blocks" "$case_root" "missing OLD app baseline"

case_root="$(copy_case bad-old-signature)"
printf 'invalid\n' >"$case_root/apps/old/Jarvis.app/.fixture-codesign"
run_expect_fail "invalid old codesign blocks" "$case_root" "old app failed strict codesign"

case_root="$(copy_case bad-new-gatekeeper)"
printf 'invalid\n' >"$case_root/apps/new/Jarvis.app/.fixture-gatekeeper"
run_expect_fail "invalid new Gatekeeper blocks" "$case_root" "new app failed Gatekeeper"

case_root="$(copy_case wrong-signer)"
printf 'OTHERTEAM\n' >"$case_root/apps/new/Jarvis.app/.fixture-team"
run_expect_fail "wrong candidate signer blocks" "$case_root" "TeamIdentifier is not the pinned Jarvis team"

case_root="$(copy_case all-foreign-signers)"
for app in old new installed; do
  printf 'OTHERTEAM\n' >"$case_root/apps/$app/Jarvis.app/.fixture-team"
done
run_expect_fail "consistently foreign signer blocks" "$case_root" "TeamIdentifier is not the pinned Jarvis team"

case_root="$(copy_case wrong-bundle-id)"
/usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier ai.example.not-jarvis' "$case_root/apps/new/Jarvis.app/Contents/Info.plist"
run_expect_fail "wrong candidate bundle id blocks" "$case_root" "NEW app bundle id is not ai.jarvis.mac"

case_root="$(copy_case bad-installed)"
/usr/libexec/PlistBuddy -c 'Set :CFBundleVersion 2026071400' "$case_root/apps/installed/Jarvis.app/Contents/Info.plist"
run_expect_fail "installed app version/build mismatch blocks" "$case_root" "INSTALLED manifest bundleVersion does not match app build"

case_root="$(copy_case bad-candidate-commit)"
sed -i.bak "s/$NEW_COMMIT/3333333333333333333333333333333333333333/" "$case_root/apps/new/Jarvis.app/Contents/Resources/OpenClawRuntime/manifest.json"
rm -f "$case_root/apps/new/Jarvis.app/Contents/Resources/OpenClawRuntime/manifest.json.bak"
run_expect_fail "candidate package commit mismatch blocks" "$case_root" "candidate bundled package commit does not match"

case_root="$(copy_case bad-feed)"
sed -i.bak "s#<sparkle:version>$NEW_BUILD</sparkle:version>#<sparkle:version>9999999999</sparkle:version>#" "$case_root/feed.xml"
rm -f "$case_root/feed.xml.bak"
run_expect_fail "latest public appcast mismatch blocks" "$case_root" "latest public appcast item does not match"

case_root="$(copy_case managed-newer)"
printf '{"format":1,"bundleVersion":"9999999999","gitCommit":"%s"}\n' "$NEW_COMMIT" >"$case_root/live/Jarvis/.jarvis/.consumer-bundled-runtime.json"
run_expect_fail "newer managed manifest blocks" "$case_root" "live managed manifest is newer or mismatched"

case_root="$(copy_case managed-mismatch)"
printf '{"format":1,"bundleVersion":"%s","gitCommit":"3333333333333333333333333333333333333333"}\n' "$OLD_BUILD" >"$case_root/live/Jarvis/.jarvis/.consumer-bundled-runtime.json"
run_expect_fail "mismatched managed manifest blocks" "$case_root" "live managed manifest is newer or mismatched"

case_root="$(copy_case debug-owner)"
printf '404 /tmp/Debug Jarvis.app/Contents/MacOS/OpenClaw\n' >"$case_root/control/processes"
run_expect_fail "active debug Jarvis app blocks" "$case_root" "quit every Jarvis/OpenClaw app"

case_root="$(copy_case unrelated-sparkle-owner)"
printf '403 /Applications/Astropad Workbench.app/Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate\n' >"$case_root/control/processes"
harness_env "$case_root" >/dev/null
pass "unrelated application Sparkle helper does not block"

case_root="$(copy_case jarvis-sparkle-owner)"
printf '404 /Users/fixture/Library/Caches/ai.jarvis.mac/org.sparkle-project.Sparkle/InstallerLauncher /Applications/Jarvis.app\n' >"$case_root/control/processes"
run_expect_fail "active Jarvis Sparkle helper blocks" "$case_root" "quit every Jarvis/OpenClaw app"

case_root="$(copy_case package-owner)"
printf '405 bash scripts/package-openclaw-mac-dist.sh --phase full\n' >"$case_root/control/processes"
run_expect_fail "active packaging owner blocks" "$case_root" "quit every Jarvis/OpenClaw app"

case_root="$(copy_case release-owner)"
mkdir -p "$case_root/control/canonical-release.lock"
printf 'pid=406\ncontext=public-release-orchestration\n' >"$case_root/control/canonical-release.lock/owner"
run_expect_fail "canonical release lock blocks inspect-only" "$case_root" "canonical release owner exists"
[[ -f "$case_root/control/canonical-release.lock/owner" ]] || fail "lock inspection mutated the owner"

case_root="$(copy_case disk-low)"
set +e
disk_output="$(JARVIS_TEST_MIN_FREE_GB=999999 harness_env "$case_root" 2>&1)"
disk_status="$?"
set -e
[[ "$disk_status" -ne 0 && "$disk_output" == *"insufficient disk"* ]] || fail "insufficient actual disk gate did not block"
pass "insufficient actual disk blocks"

case_root="$(copy_case unsafe-scratch)"
run_expect_fail "live Jarvis scratch root blocks" "$case_root" "scratch root may not target" \
  --scratch-root "$case_root/live/Jarvis"

case_root="$(copy_case no-reseed)"
: >"$case_root/control/no-reseed"
run_expect_fail "candidate manifest cannot substitute for live managed polling" "$case_root" "live managed manifest did not reseed" --apply

case_root="$(copy_case post-update-foreign-signer)"
: >"$case_root/control/post-update-foreign-team"
set +e
signer_output="$(harness_env "$case_root" --apply 2>&1)"
signer_status="$?"
set -e
[[ "$signer_status" -ne 0 && "$signer_output" == *"updated-disposable app TeamIdentifier is not the pinned Jarvis team"* ]] || \
  fail "post-update foreign signer was not rejected"
pass "post-update app signer is revalidated"

case_root="$(copy_case apply)"
prefs_before="$(shasum -a 256 "$case_root/live/Preferences/ai.jarvis.mac.plist")"
plist_before="$(shasum -a 256 "$case_root/live/LaunchAgents/ai.jarvis.gateway.plist")"
apply_output="$(harness_env "$case_root" --apply --telegram-chat @fixture_bot)"
prefs_after="$(shasum -a 256 "$case_root/live/Preferences/ai.jarvis.mac.plist")"
plist_after="$(shasum -a 256 "$case_root/live/LaunchAgents/ai.jarvis.gateway.plist")"
[[ "$prefs_before" == "$prefs_after" ]] || fail "apply did not restore exact preference plist"
[[ "$plist_before" == "$plist_after" ]] || fail "apply changed the exact gateway plist"
[[ -f "$case_root/live/Caches/ai.jarvis.mac/org.sparkle-project.Sparkle/preexisting/payload" ]] || fail "apply removed preexisting Sparkle cache state"
[[ ! -e "$case_root/live/Caches/ai.jarvis.mac/org.sparkle-project.Sparkle/run-created" ]] || fail "apply left run-created Sparkle staging"
[[ "$(jq -r '.gitCommit' "$case_root/live/Jarvis/.jarvis/.consumer-bundled-runtime.json")" == "$NEW_COMMIT" ]] || fail "apply did not poll/reach live managed receipt"
[[ "$apply_output" == *"proof.public_feed=ok"* ]] || fail "apply omitted public_feed proof"
[[ "$apply_output" == *"proof.installed_app=normal_signed_baseline"* ]] || fail "apply omitted installed_app proof"
[[ "$apply_output" == *"proof.sparkle_transition=ok"* ]] || fail "apply omitted sparkle_transition proof"
[[ "$apply_output" == *"proof.managed_runtime=ok"* ]] || fail "apply omitted managed_runtime proof"
[[ "$apply_output" == *"proof.gateway=ok"* ]] || fail "apply omitted gateway proof"
[[ "$apply_output" == *"proof.telegram=ok sent_message_id=501 reply_message_id=502"* ]] || fail "apply omitted Telegram message-id proof"
grep -q 'app launch 2' "$case_root/logs/actions" || fail "updated app was not explicitly relaunched for reseed"
grep -q 'launchctl bootout' "$case_root/logs/actions" || fail "exact gateway bootout was not called"
grep -q 'launchctl bootstrap' "$case_root/logs/actions" || fail "exact gateway bootstrap was not called"
grep -q -- '--after-id 501' "$case_root/logs/actions" || fail "Telegram wait did not anchor after sent message id"
if grep -q -- '--sender-id' "$case_root/logs/actions"; then
  fail "Telegram wait incorrectly filtered the bot reply by outbound user sender id"
fi
find "$case_root/runs" -mindepth 1 -print -quit | grep -q . && fail "successful apply left sentinel-owned run files"
pass "apply proves all layers in order and restores owned state"

case_root="$(copy_case telegram-exact)"
: >"$case_root/control/telegram-embedded-reply"
set +e
telegram_output="$(harness_env "$case_root" --apply --telegram-chat @fixture_bot 2>&1)"
telegram_status="$?"
set -e
[[ "$telegram_status" -ne 0 && "$telegram_output" == *"Telegram reply was not exactly the nonce"* ]] || \
  fail "Telegram proof accepted a reply that merely embedded the nonce"
pass "Telegram proof requires exact nonce equality"

case_root="$(copy_case preferences-restore-failure)"
: >"$case_root/control/defaults-import-fail"
prefs_before="$(shasum -a 256 "$case_root/live/Preferences/ai.jarvis.mac.plist")"
set +e
preferences_output="$(harness_env "$case_root" --apply 2>&1)"
preferences_status="$?"
set -e
prefs_after="$(shasum -a 256 "$case_root/live/Preferences/ai.jarvis.mac.plist")"
[[ "$preferences_status" -ne 0 && "$preferences_output" == *"preserved rollback evidence"* ]] || \
  fail "preference restoration failure did not fail and preserve evidence"
[[ "$prefs_before" == "$prefs_after" ]] || fail "fallback copy did not restore exact preference bytes"
find "$case_root/runs" -mindepth 1 -maxdepth 1 -type d -print -quit | grep -q . || \
  fail "preference restoration failure deleted its only rollback backup"
pass "preference restore failure is fatal and preserves its backup"

case_root="$(copy_case foreign-cache-entry)"
: >"$case_root/control/foreign-cache-entry"
set +e
cache_output="$(harness_env "$case_root" --apply 2>&1)"
cache_status="$?"
set -e
[[ "$cache_status" -ne 0 && "$cache_output" == *"automatic deletion is refused"* ]] || \
  fail "unattributed Sparkle cache residue did not fail safely"
[[ -e "$case_root/live/Caches/ai.jarvis.mac/org.sparkle-project.Sparkle/foreign-entry/payload" ]] || \
  fail "harness deleted a foreign cache entry created after the snapshot"
pass "foreign post-snapshot cache entry is reported and preserved"

case_root="$(copy_case gateway-rollback)"
: >"$case_root/control/prove-fail"
plist_before="$(shasum -a 256 "$case_root/live/LaunchAgents/ai.jarvis.gateway.plist")"
set +e
gateway_output="$(harness_env "$case_root" --apply --timeout 30 2>&1)"
status="$?"
set -e
[[ "$status" -ne 0 ]] || fail "gateway proof failure unexpectedly passed"
[[ "$gateway_output" == *"managed gateway runtime proof failed"* ]] || {
  printf '%s\n' "$gateway_output" >&2
  fail "gateway rollback fixture failed before the intended proof boundary"
}
plist_after="$(shasum -a 256 "$case_root/live/LaunchAgents/ai.jarvis.gateway.plist")"
[[ "$plist_before" == "$plist_after" ]] || fail "gateway rollback did not restore exact plist"
[[ "$(grep -c 'launchctl bootstrap' "$case_root/logs/actions")" -ge 2 ]] || fail "gateway rollback did not reload exact plist"
pass "gateway failure trap restores and reloads exact plist"

case_root="$(copy_case signal-cleanup)"
: >"$case_root/control/no-transition"
prefs_before="$(shasum -a 256 "$case_root/live/Preferences/ai.jarvis.mac.plist")"
harness_env "$case_root" --apply --timeout 30 >/dev/null 2>&1 &
signal_pid="$!"
for _ in 1 2 3 4 5; do
  [[ -s "$case_root/control/launch-count" ]] && break
  sleep 1
done
kill -TERM "$signal_pid"
set +e
wait "$signal_pid"
signal_status="$?"
set -e
[[ "$signal_status" -ne 0 ]] || fail "signal interruption exited successfully"
prefs_after="$(shasum -a 256 "$case_root/live/Preferences/ai.jarvis.mac.plist")"
[[ "$prefs_before" == "$prefs_after" ]] || fail "signal cleanup did not restore exact preferences"
find "$case_root/runs" -mindepth 1 -print -quit | grep -q . && fail "signal cleanup left sentinel-owned run files"
pass "signal cleanup kills tracked app and removes only sentinel-owned run"

printf 'All mocked Jarvis Sparkle updater E2E tests passed.\n'
