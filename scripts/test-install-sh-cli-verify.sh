#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

mkdir -p "$TEST_DIR/old/bin" "$TEST_DIR/new/bin"
TEST_PATH="$TEST_DIR/old/bin:$TEST_DIR/new/bin:/usr/bin:/bin"

# Fake Node binaries make the test independent of the host Node version while
# preserving the real /usr/bin/env lookup used by installed CLI entrypoints.
for runtime in old new; do
  version="18.20.0"
  [[ "$runtime" == "new" ]] && version="24.15.0"
  cat > "$TEST_DIR/$runtime/bin/node" <<EOF
#!/usr/bin/env bash
if [[ "\$1" == "-p" ]]; then
  printf '%s\\n' "$version"
elif [[ "\$2" == "--version" ]]; then
  printf 'openclaw 2026.7.1\\n'
elif [[ "\$2" == "--help" ]]; then
  printf 'help\\n'
else
  printf 'unexpected node invocation\\n' >&2
  exit 1
fi
EOF
  chmod +x "$TEST_DIR/$runtime/bin/node"
done

cat > "$TEST_DIR/old/bin/openclaw" <<'EOF'
#!/usr/bin/env node
EOF
chmod +x "$TEST_DIR/old/bin/openclaw"

PATH="$TEST_PATH" \
  bash -c '
    source "$1/scripts/docker/install-sh-common/cli-verify.sh"
    verify_installed_cli openclaw 2026.7.1
  ' bash "$ROOT_DIR" >"$TEST_DIR/success.log"

grep -F "cli=openclaw installed=2026.7.1 expected=2026.7.1" "$TEST_DIR/success.log" >/dev/null

cat > "$TEST_DIR/new/bin/node" <<'EOF'
#!/usr/bin/env bash
printf 'Node.js cannot start this package: requires Node >=24.15.0\n' >&2
exit 1
EOF
chmod +x "$TEST_DIR/new/bin/node"

if OPENCLAW_NODE_BIN="$TEST_DIR/new/bin/node" PATH="$TEST_PATH" \
  bash -c '
    source "$1/scripts/docker/install-sh-common/cli-verify.sh"
    verify_installed_cli openclaw 2026.7.1
  ' bash "$ROOT_DIR" >"$TEST_DIR/failure.log" 2>&1; then
  echo "expected CLI verification to fail" >&2
  exit 1
fi

grep -F "Node.js cannot start this package: requires Node >=24.15.0" "$TEST_DIR/failure.log" >/dev/null
echo "OK"
