#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/github-release-upload-preflight.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

ROUTE_STUB="$TMP_DIR/route-stub.sh"
CURL_STUB="$TMP_DIR/curl-stub.sh"
TEST_OUT="$TMP_DIR/preflight.out"
TEST_ERR="$TMP_DIR/preflight.err"

cat >"$ROUTE_STUB" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${OPENCLAW_TEST_ROUTE_INTERFACE:-en0}" in
  none)
    exit 1
    ;;
  *)
    printf '   route to: %s\ninterface: %s\n' "$1" "${OPENCLAW_TEST_ROUTE_INTERFACE:-en0}"
    ;;
esac
EOF

cat >"$CURL_STUB" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "${OPENCLAW_TEST_HTTP_STATUS:-200}"
EOF

chmod +x "$ROUTE_STUB" "$CURL_STUB"

run_case() {
  local name="$1"
  local expect="$2"
  local route_interface="$3"
  local http_status="$4"
  local allow_slow="${5:-0}"

  set +e
  (
    export OPENCLAW_GITHUB_UPLOAD_PREFLIGHT_ROUTE_STUB="$ROUTE_STUB"
    export OPENCLAW_GITHUB_UPLOAD_PREFLIGHT_CURL_STUB="$CURL_STUB"
    export OPENCLAW_TEST_ROUTE_INTERFACE="$route_interface"
    export OPENCLAW_TEST_HTTP_STATUS="$http_status"
    if [[ "$allow_slow" == "1" ]]; then
      export ALLOW_SLOW_RELEASE_UPLOAD=1
    else
      unset ALLOW_SLOW_RELEASE_UPLOAD
    fi
    github_release_upload_preflight
  ) >"$TEST_OUT" 2>"$TEST_ERR"
  local status=$?
  set -e

  if [[ "$expect" == "pass" && "$status" -ne 0 ]]; then
    echo "FAIL: $name expected pass, got status $status" >&2
    cat "$TEST_ERR" >&2
    exit 1
  fi

  if [[ "$expect" == "fail" && "$status" -eq 0 ]]; then
    echo "FAIL: $name expected fail, got pass" >&2
    cat "$TEST_OUT" >&2
    exit 1
  fi

  echo "PASS: $name"
}

run_case "normal interface passes" pass en0 200
run_case "tunnel interface fails fast" fail utun4 200
run_case "override allows tunnel interface" pass utun4 200 1
run_case "unknown route fails fast" fail none 200
run_case "unreachable GitHub probe fails" fail en0 000
