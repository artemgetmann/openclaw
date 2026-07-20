#!/usr/bin/env bash
set -euo pipefail

# Verify every release-required native artifact declared by skill metadata.
# This runs both on staged/cache payloads and on the final signed app so missing
# or stale local capabilities cannot be hidden behind a valid skill hash.

MANIFEST_PATH="${1:-}"
PACKAGE_ROOT="${2:-}"
REQUIRE_SIGNED="${3:-}"

if [[ -z "$MANIFEST_PATH" || -z "$PACKAGE_ROOT" ]]; then
  echo "Usage: scripts/verify-consumer-packaged-artifacts.sh <capabilities-manifest> <openclaw-package-root> [--require-signed]" >&2
  exit 2
fi

json_field() {
  local artifact_json="$1"
  local field="$2"
  node -e '
    const artifact = JSON.parse(process.argv[1]);
    const value = artifact[process.argv[2]];
    if (typeof value !== "string" || !value) process.exit(2);
    process.stdout.write(value);
  ' "$artifact_json" "$field"
}

verify_macos_app() {
  local artifact_json="$1"
  local artifact_id artifact_path executable_path expected_bundle_id expected_version
  local license_path receipt_path source_repo source_ref app_path executable info_plist actual_bundle_id actual_version
  local actual_archs required_arch

  artifact_id="$(json_field "$artifact_json" id)"
  artifact_path="$(json_field "$artifact_json" path)"
  executable_path="$(json_field "$artifact_json" executable)"
  expected_bundle_id="$(json_field "$artifact_json" bundleIdentifier)"
  expected_version="$(json_field "$artifact_json" version)"
  license_path="$(json_field "$artifact_json" licensePath)"
  receipt_path="$(json_field "$artifact_json" receiptPath)"
  source_repo="$(json_field "$artifact_json" sourceRepo)"
  source_ref="$(json_field "$artifact_json" sourceRef)"
  app_path="$PACKAGE_ROOT/$artifact_path"
  executable="$app_path/$executable_path"
  info_plist="$app_path/Contents/Info.plist"

  if [[ ! -x "$executable" || ! -f "$info_plist" ]]; then
    echo "ERROR: required consumer artifact $artifact_id is incomplete: $app_path" >&2
    exit 1
  fi
  actual_bundle_id="$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$info_plist")"
  actual_version="$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$info_plist")"
  if [[ "$actual_bundle_id" != "$expected_bundle_id" || "$actual_version" != "$expected_version" ]]; then
    echo "ERROR: required consumer artifact $artifact_id identity is stale." >&2
    echo "  bundle=$actual_bundle_id expected=$expected_bundle_id" >&2
    echo "  version=$actual_version expected=$expected_version" >&2
    exit 1
  fi

  actual_archs="$(/usr/bin/lipo -archs "$executable")"
  while IFS= read -r required_arch; do
    [[ -n "$required_arch" ]] || continue
    if [[ " $actual_archs " != *" $required_arch "* ]]; then
      echo "ERROR: required consumer artifact $artifact_id lacks architecture $required_arch (has: $actual_archs)" >&2
      exit 1
    fi
  done < <(
    node -e '
      const artifact = JSON.parse(process.argv[1]);
      for (const arch of artifact.architectures ?? []) console.log(arch);
    ' "$artifact_json"
  )

  if [[ ! -s "$app_path/$license_path" ]]; then
    echo "ERROR: required consumer artifact $artifact_id is missing its license notice" >&2
    exit 1
  fi
  node -e '
    const fs = require("node:fs");
    const [receiptPath, expectedRepo, expectedRef] = process.argv.slice(1);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    if (
      receipt.format !== 1 ||
      receipt.sourceRepo !== expectedRepo ||
      receipt.sourceRef !== expectedRef
    ) {
      throw new Error(`stale packaged artifact receipt: ${receiptPath}`);
    }
  ' "$app_path/$receipt_path" "$source_repo" "$source_ref"

  if [[ "$REQUIRE_SIGNED" == "--require-signed" ]]; then
    codesign --verify --strict "$app_path"
  fi
}

artifact_count=0
while IFS= read -r encoded_artifact; do
  [[ -n "$encoded_artifact" ]] || continue
  artifact_count=$((artifact_count + 1))
  artifact_json="$(printf '%s' "$encoded_artifact" | base64 --decode)"
  artifact_kind="$(json_field "$artifact_json" kind)"
  case "$artifact_kind" in
    macos-app)
      verify_macos_app "$artifact_json"
      ;;
    *)
      echo "ERROR: no verifier for required consumer artifact kind: $artifact_kind" >&2
      exit 1
      ;;
  esac
done < <(
  node -e '
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (manifest.format !== 1 || !Array.isArray(manifest.packagedArtifacts)) {
      throw new Error(`capabilities manifest lacks packagedArtifacts: ${process.argv[1]}`);
    }
    for (const artifact of manifest.packagedArtifacts) {
      if (artifact.requirement === "consumer-release") {
        process.stdout.write(`${Buffer.from(JSON.stringify(artifact)).toString("base64")}\n`);
      }
    }
  ' "$MANIFEST_PATH"
)

if [[ "$artifact_count" -eq 0 ]]; then
  echo "ERROR: capabilities manifest declares no consumer-release packaged artifacts" >&2
  exit 1
fi
