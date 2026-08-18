#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
shim="$script_dir/xurl-agent-shim.sh"
installer="$script_dir/install-xurl-agent-shim.sh"
fixture_dir="$(mktemp -d)"
trap 'rm -rf -- "$fixture_dir"' EXIT

fake_real="$fixture_dir/real-xurl"
fake_log="$fixture_dir/real.log"
cat >"$fake_real" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$XURL_TEST_LOG"
printf '{"ok":true}\n'
EOF
chmod +x "$fake_real"

run_shim() {
  XURL_REAL_BIN="$fake_real" XURL_TEST_LOG="$fake_log" "$shim" "$@"
}

expect_ok() {
  local expected="$1"
  shift
  local output
  output="$(run_shim "$@" 2>&1)" || { echo "FAIL: expected success: $*" >&2; exit 1; }
  [[ "$output" == *"$expected"* ]] || { echo "FAIL: missing '$expected': $output" >&2; exit 1; }
}

expect_fail() {
  local expected="$1"
  shift
  local output
  if output="$(run_shim "$@" 2>&1)"; then
    echo "FAIL: expected refusal: $*" >&2
    exit 1
  fi
  [[ "$output" == *"$expected"* ]] || { echo "FAIL: missing refusal '$expected': $output" >&2; exit 1; }
}

: >"$fake_log"
expect_ok '"ok":true' search openclaw
[[ "$(<"$fake_log")" == "search openclaw -n 10" ]] || { echo "FAIL: guarded default was not forwarded" >&2; exit 1; }

: >"$fake_log"
expect_ok '"ok":true' posts openai
[[ "$(<"$fake_log")" == "posts openai -n 10" ]] || { echo "FAIL: guarded posts read was not forwarded" >&2; exit 1; }

: >"$fake_log"
expect_ok '"ok":true' --app jarvis-x-read --auth oauth2 search openclaw
[[ "$(<"$fake_log")" == "--app jarvis-x-read --auth oauth2 search openclaw -n 10" ]] || { echo "FAIL: guarded global flags were not forwarded" >&2; exit 1; }

: >"$fake_log"
expect_fail 'Get fresh user confirmation' search openclaw -n 25
[[ ! -s "$fake_log" ]] || { echo "FAIL: over-limit read reached the real CLI" >&2; exit 1; }

: >"$fake_log"
expect_ok '"ok":true' --approved-max 25 search openclaw -n25
[[ "$(<"$fake_log")" == "search openclaw -n25" ]] || { echo "FAIL: approved compact limit was not forwarded" >&2; exit 1; }

expect_fail 'direct raw xurl reads are blocked' /2/tweets/search/recent
expect_fail 'forbidden in agent sessions' search openclaw --verbose
expect_fail 'unrecognized xurl command is blocked' future-paid-read openclaw
expect_fail 'only valid for guarded read shortcuts' --approved-max 25 post test
expect_ok '"ok":true' --version
expect_ok '"ok":true' -X POST /2/tweets -d '{"text":"test"}'
expect_ok '"ok":true' --method POST /2/tweets -d '{"text":"test"}'
expect_ok '"ok":true' --method=POST /2/tweets -d '{"text":"test"}'
expect_ok '"ok":true' /2/tweets -d '{"text":"test"}'
expect_ok '"ok":true' /2/media -F upload.jpg
expect_fail 'direct raw xurl reads are blocked' -X GET /2/tweets -d '{"text":"test"}'

# Prove installation is reversible without touching the user's real PATH.
install_target="$fixture_dir/bin/xurl"
install_state="$fixture_dir/state"
mkdir -p "$(dirname -- "$install_target")"
ln -s "$fake_real" "$install_target"

XURL_REAL_BIN="$fake_real" \
XURL_AGENT_SHIM_SOURCE="$shim" \
XURL_AGENT_SHIM_TARGET="$install_target" \
XURL_AGENT_SHIM_STATE_DIR="$install_state" \
PATH="$(dirname -- "$install_target"):$PATH" \
  "$installer"

[[ "$(realpath "$install_target")" == "$(realpath "$shim")" ]] || { echo "FAIL: installer did not activate shim" >&2; exit 1; }

XURL_AGENT_SHIM_SOURCE="$shim" \
XURL_AGENT_SHIM_TARGET="$install_target" \
XURL_AGENT_SHIM_STATE_DIR="$install_state" \
PATH="$(dirname -- "$install_target"):$PATH" \
  "$installer" --status >/dev/null

XURL_AGENT_SHIM_SOURCE="$shim" \
XURL_AGENT_SHIM_TARGET="$install_target" \
XURL_AGENT_SHIM_STATE_DIR="$install_state" \
PATH="$(dirname -- "$install_target"):$PATH" \
  "$installer" --uninstall

[[ "$(realpath "$install_target")" == "$(realpath "$fake_real")" ]] || { echo "FAIL: uninstall did not restore original xurl" >&2; exit 1; }

# A target directory after another xurl must fail instead of claiming inactive
# enforcement. The existing command remains untouched.
inactive_target="$fixture_dir/inactive/xurl"
mkdir -p "$(dirname -- "$inactive_target")"
ln -s "$fake_real" "$inactive_target"
if XURL_REAL_BIN="$fake_real" \
  XURL_AGENT_SHIM_SOURCE="$shim" \
  XURL_AGENT_SHIM_TARGET="$inactive_target" \
  XURL_AGENT_SHIM_STATE_DIR="$fixture_dir/inactive-state" \
  PATH="$(dirname -- "$install_target"):$(dirname -- "$inactive_target"):$PATH" \
  "$installer" 2>"$fixture_dir/inactive.err"; then
  echo "FAIL: installer accepted an inactive PATH location" >&2
  exit 1
fi
grep -q 'refusing inactive install' "$fixture_dir/inactive.err" || { echo "FAIL: inactive PATH refusal was unclear" >&2; exit 1; }

# Managed upgrades retain the pre-shim rollback receipt even if the shared
# skill source moves to a different path.
upgrade_target="$fixture_dir/upgrade-bin/xurl"
upgrade_state="$fixture_dir/upgrade-state"
old_shim="$fixture_dir/old/xurl-agent-shim.sh"
mkdir -p "$(dirname -- "$upgrade_target")" "$(dirname -- "$old_shim")"
cp "$shim" "$old_shim"
chmod +x "$old_shim"
ln -s "$fake_real" "$upgrade_target"

XURL_REAL_BIN="$fake_real" XURL_AGENT_SHIM_SOURCE="$old_shim" XURL_AGENT_SHIM_TARGET="$upgrade_target" \
  XURL_AGENT_SHIM_STATE_DIR="$upgrade_state" PATH="$(dirname -- "$upgrade_target"):$PATH" "$installer" >/dev/null
XURL_REAL_BIN="$fake_real" XURL_AGENT_SHIM_SOURCE="$shim" XURL_AGENT_SHIM_TARGET="$upgrade_target" \
  XURL_AGENT_SHIM_STATE_DIR="$upgrade_state" PATH="$(dirname -- "$upgrade_target"):$PATH" "$installer" >/dev/null
[[ "$(<"$upgrade_state/original-link")" == "$fake_real" ]] || { echo "FAIL: managed upgrade overwrote rollback state" >&2; exit 1; }

echo "xurl agent shim tests passed"
