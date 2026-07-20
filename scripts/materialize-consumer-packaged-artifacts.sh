#!/usr/bin/env bash
set -euo pipefail

# Materialize native payloads declared by bundled skill metadata. The manifest
# is the single source of truth: this helper contains build mechanics, but no
# independently maintained ref, version, bundle ID, or destination path.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
MANIFEST_PATH="${1:-}"
PACKAGE_ROOT="${2:-}"

# Each packaging process owns an isolated checkout. Parallel release jobs must
# never fetch, checkout, or build in the same mutable Git tree. Interrupted
# jobs remain under the canonical runs/ bucket, where the existing build-cache
# cleanup lane can discover them.
source "$ROOT_DIR/scripts/lib/build-artifacts.sh"
BUILD_RUN_ROOT="$(openclaw_build_run_root "consumer-packaged-artifacts")"
cleanup_build_run() {
  rm -rf "$BUILD_RUN_ROOT"
}
trap cleanup_build_run EXIT

if [[ -z "$MANIFEST_PATH" || -z "$PACKAGE_ROOT" ]]; then
  echo "Usage: scripts/materialize-consumer-packaged-artifacts.sh <capabilities-manifest> <openclaw-package-root>" >&2
  exit 2
fi
if [[ ! -f "$MANIFEST_PATH" ]]; then
  echo "ERROR: capabilities manifest missing: $MANIFEST_PATH" >&2
  exit 1
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

materialize_open_computer_use() {
  local artifact_json="$1"
  local artifact_path executable_path source_repo source_ref license_source license_path receipt_path
  local checkout_root built_app destination_app head_commit
  local -a build_command=()

  artifact_path="$(json_field "$artifact_json" path)"
  executable_path="$(json_field "$artifact_json" executable)"
  source_repo="$(json_field "$artifact_json" sourceRepo)"
  source_ref="$(json_field "$artifact_json" sourceRef)"
  license_source="$(json_field "$artifact_json" licenseSource)"
  license_path="$(json_field "$artifact_json" licensePath)"
  receipt_path="$(json_field "$artifact_json" receiptPath)"
  checkout_root="$BUILD_RUN_ROOT/open-computer-use-$source_ref"
  built_app="$checkout_root/dist/Open Computer Use.app"
  destination_app="$PACKAGE_ROOT/$artifact_path"

  # Clone into the process-owned run root so ambient branches, local patches,
  # and concurrent package jobs cannot influence the release payload.
  git clone --no-checkout "$source_repo" "$checkout_root"
  git -C "$checkout_root" fetch --force origin "$source_ref"
  git -C "$checkout_root" checkout --detach --force "$source_ref"
  head_commit="$(git -C "$checkout_root" rev-parse HEAD)"
  if [[ "$head_commit" != "$source_ref" ]]; then
    echo "ERROR: Open Computer Use checkout resolved $head_commit, expected $source_ref" >&2
    exit 1
  fi

  while IFS= read -r -d '' build_arg; do
    build_command+=("$build_arg")
  done < <(
    node -e '
      const artifact = JSON.parse(process.argv[1]);
      for (const arg of artifact.buildCommand ?? []) process.stdout.write(`${arg}\0`);
    ' "$artifact_json"
  )
  if [[ "${#build_command[@]}" -eq 0 ]]; then
    echo "ERROR: Open Computer Use build command is empty in $MANIFEST_PATH" >&2
    exit 1
  fi

  echo "📦 Building pinned Open Computer Use release app ($source_ref)"
  (
    cd "$checkout_root"
    # The outer Jarvis signing lane owns the final identity. Building unsigned
    # here avoids silently preserving an arbitrary local developer signature.
    OPEN_COMPUTER_USE_CODESIGN_MODE=none "${build_command[@]}"
  )
  if [[ ! -x "$built_app/$executable_path" ]]; then
    echo "ERROR: pinned Open Computer Use build did not produce $built_app/$executable_path" >&2
    exit 1
  fi

  # Swift's linker leaves an ad-hoc signature on each architecture even when
  # the release build requests no distribution signature. Normalize the
  # universal helper to genuinely unsigned before it enters Jarvis; the outer
  # signing lane then applies one stable identity instead of replacing nested
  # per-architecture linker signatures in place.
  if ! codesign --remove-signature "$built_app/$executable_path"; then
    echo "ERROR: failed to remove linker signature from pinned Open Computer Use build" >&2
    exit 1
  fi
  if codesign -d "$built_app/$executable_path" >/dev/null 2>&1; then
    echo "ERROR: pinned Open Computer Use executable remains signed before packaging" >&2
    exit 1
  fi

  if [[ ! -f "$checkout_root/$license_source" ]]; then
    echo "ERROR: pinned Open Computer Use source is missing license: $license_source" >&2
    exit 1
  fi

  rm -rf "$destination_app"
  mkdir -p "$(dirname "$destination_app")"
  /usr/bin/ditto "$built_app" "$destination_app"
  mkdir -p "$(dirname "$destination_app/$license_path")"
  cp "$checkout_root/$license_source" "$destination_app/$license_path"
  mkdir -p "$(dirname "$destination_app/$receipt_path")"
  node -e '
    const fs = require("node:fs");
    const [receiptPath, sourceRepo, sourceRef] = process.argv.slice(1);
    fs.writeFileSync(
      receiptPath,
      `${JSON.stringify({ format: 1, sourceRepo, sourceRef }, null, 2)}\n`,
    );
  ' "$destination_app/$receipt_path" "$source_repo" "$source_ref"
}

artifact_count=0
while IFS= read -r encoded_artifact; do
  [[ -n "$encoded_artifact" ]] || continue
  artifact_count=$((artifact_count + 1))
  artifact_json="$(printf '%s' "$encoded_artifact" | base64 --decode)"
  artifact_id="$(json_field "$artifact_json" id)"
  artifact_kind="$(json_field "$artifact_json" kind)"

  case "$artifact_kind:$artifact_id" in
    macos-app:open-computer-use)
      materialize_open_computer_use "$artifact_json"
      ;;
    *)
      echo "ERROR: no materializer for required consumer artifact $artifact_kind:$artifact_id" >&2
      exit 1
      ;;
  esac
done < <(
  node -e '
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const artifact of manifest.packagedArtifacts ?? []) {
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

"$ROOT_DIR/scripts/verify-consumer-packaged-artifacts.sh" "$MANIFEST_PATH" "$PACKAGE_ROOT"
