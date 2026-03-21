#!/usr/bin/env bash
set -euo pipefail

# Browser Use is a separate browser stack from OpenClaw, so we keep its setup
# explicit and reproducible instead of trusting global PATH state. This helper:
# 1) creates a repo-local Python 3.12 venv
# 2) installs Browser Use into that venv
# 3) clones the user's real Chrome profile into a throwaway user-data-dir
# 4) gives us a one-command benchmark path once a Browser Use API key exists

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VENV_DIR="${BROWSER_USE_VENV_DIR:-$ROOT_DIR/.venv-browser-use}"
PYTHON_VERSION="${BROWSER_USE_PYTHON_VERSION:-3.12}"
SOURCE_CHROME_DIR="${OPENCLAW_SOURCE_CHROME_DIR:-$HOME/Library/Application Support/Google/Chrome}"
SOURCE_PROFILE_NAME="${OPENCLAW_SOURCE_PROFILE_NAME:-Profile 4}"
CLONE_CHROME_DIR="${BROWSER_USE_CLONE_CHROME_DIR:-/tmp/browser-use-profile4-clone}"

usage() {
  cat <<'EOF'
Usage:
  scripts/repro/browser-use-profile4-clone.sh setup
  scripts/repro/browser-use-profile4-clone.sh doctor
  scripts/repro/browser-use-profile4-clone.sh prepare-profile
  scripts/repro/browser-use-profile4-clone.sh run-emirates

Commands:
  setup
    Create/update a repo-local Browser Use venv pinned to Python 3.12 and
    install Browser Use into it.

  doctor
    Run Browser Use's own diagnostics so we can distinguish local install
    problems from missing API-key access.

  prepare-profile
    Clone the user's real Chrome profile into a throwaway user-data-dir for
    Browser Use experiments.

  run-emirates
    Run the March 22 Emirates benchmark against the cloned Chrome profile.
    Requires BROWSER_USE_API_KEY to be set in the environment.
EOF
}

ensure_setup() {
  cd "$ROOT_DIR"

  # We pin Browser Use to a repo-local venv so benchmark results do not depend
  # on whichever global CLI version happens to be installed on this machine.
  uv venv "$VENV_DIR" --python "$PYTHON_VERSION"
  uv pip install --python "$VENV_DIR/bin/python" --upgrade browser-use
}

prepare_profile() {
  cd "$ROOT_DIR"

  # Browser Use can point at a local Chrome profile dir directly. We still use
  # a clone so we can preserve the user's real session state without letting the
  # benchmark mutate their day-to-day browser files.
  rm -rf "$CLONE_CHROME_DIR"
  mkdir -p "$CLONE_CHROME_DIR"
  cp "${SOURCE_CHROME_DIR}/Local State" "${CLONE_CHROME_DIR}/Local State"
  rsync -a --delete \
    "${SOURCE_CHROME_DIR}/${SOURCE_PROFILE_NAME}/" \
    "${CLONE_CHROME_DIR}/${SOURCE_PROFILE_NAME}/"

  echo "Prepared Browser Use clone profile:"
  echo "  source: ${SOURCE_PROFILE_NAME}"
  echo "  clone:  ${CLONE_CHROME_DIR}"
}

doctor() {
  cd "$ROOT_DIR"

  if [ ! -x "$VENV_DIR/bin/browser-use" ]; then
    echo "Browser Use venv is missing. Run 'setup' first." >&2
    exit 1
  fi

  # Browser Use has a built-in doctor command, so use the source of truth
  # instead of inventing our own checklist every time this lane gets revisited.
  "$VENV_DIR/bin/browser-use" doctor
}

run_emirates() {
  cd "$ROOT_DIR"

  if [ ! -x "$VENV_DIR/bin/browser-use" ]; then
    echo "Browser Use venv is missing. Run 'setup' first." >&2
    exit 1
  fi

  if [ -z "${BROWSER_USE_API_KEY:-}" ]; then
    echo "BROWSER_USE_API_KEY is missing. Export it first." >&2
    exit 1
  fi

  if [ ! -d "$CLONE_CHROME_DIR/$SOURCE_PROFILE_NAME" ]; then
    echo "Clone profile is missing. Run 'prepare-profile' first." >&2
    exit 1
  fi

  # We run against the cloned real profile, not the user's live Chrome. This
  # keeps the comparison apples-to-apples with the OpenClaw cloned-profile lane.
  "$VENV_DIR/bin/browser-use" \
    --user-data-dir "$CLONE_CHROME_DIR" \
    --profile-directory "$SOURCE_PROFILE_NAME" \
    --model bu-latest \
    -p "Open emirates.com. Search one-way flights from Denpasar (DPS) to Dubai (DXB) for March 22, 2026. Stop as soon as visible flight options load. Report the top visible options and any obvious constraints. Do not purchase anything."
}

cmd="${1:-}"
case "$cmd" in
  setup)
    ensure_setup
    ;;
  doctor)
    doctor
    ;;
  prepare-profile)
    prepare_profile
    ;;
  run-emirates)
    run_emirates
    ;;
  *)
    usage
    exit 1
    ;;
esac
