#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/openclaw-runtime-payloads.sh"

fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-gog-signature-test.XXXXXX")"
trap 'rm -rf "$fixture_root"' EXIT

# The verifier is deliberately dependency-injected so CI can prove every
# fail-closed branch without needing a real Apple certificate fixture.
mkdir -p \
  "$fixture_root/openclaw/tools/gog/darwin-arm64" \
  "$fixture_root/openclaw/tools/gog/darwin-x86_64"
touch \
  "$fixture_root/openclaw/tools/gog/darwin-arm64/gog" \
  "$fixture_root/openclaw/tools/gog/darwin-x86_64/gog"

cat >"$fixture_root/codesign" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "--verify" ]]; then
  [[ "${STUB_SIGNATURE_VALID:-1}" == "1" ]]
  exit
fi
cat >&2 <<EOF
Identifier=${STUB_IDENTIFIER:-com.steipete.gogcli.gog}
TeamIdentifier=${STUB_TEAM_ID:-Y5PE65HELJ}
EOF
SH
chmod +x "$fixture_root/codesign"

cat >"$fixture_root/lipo" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "$2" in
  */darwin-arm64/gog)
    printf 'arm64\n'
    ;;
  */darwin-x86_64/gog)
    printf 'x86_64\n'
    ;;
  *)
    exit 1
    ;;
esac
SH
chmod +x "$fixture_root/lipo"

arm64_gog="$fixture_root/openclaw/tools/gog/darwin-arm64/gog"
x86_64_gog="$fixture_root/openclaw/tools/gog/darwin-x86_64/gog"

openclaw_runtime_payload_is_vendor_signed_gog "$arm64_gog"
openclaw_runtime_payload_is_vendor_signed_gog "$x86_64_gog"
openclaw_verify_vendor_signed_gog "$arm64_gog" "$fixture_root/codesign" "$fixture_root/lipo"
openclaw_verify_vendor_signed_gog "$x86_64_gog" "$fixture_root/codesign" "$fixture_root/lipo"

if STUB_TEAM_ID=WRONG \
  openclaw_verify_vendor_signed_gog "$arm64_gog" "$fixture_root/codesign" "$fixture_root/lipo" \
  >/dev/null 2>&1; then
  echo "ERROR: unexpected Gog Team ID passed verification" >&2
  exit 1
fi

if STUB_IDENTIFIER=wrong.identifier \
  openclaw_verify_vendor_signed_gog "$arm64_gog" "$fixture_root/codesign" "$fixture_root/lipo" \
  >/dev/null 2>&1; then
  echo "ERROR: unexpected Gog identifier passed verification" >&2
  exit 1
fi

if STUB_SIGNATURE_VALID=0 \
  openclaw_verify_vendor_signed_gog "$arm64_gog" "$fixture_root/codesign" "$fixture_root/lipo" \
  >/dev/null 2>&1; then
  echo "ERROR: invalid Gog signature passed verification" >&2
  exit 1
fi

if openclaw_runtime_payload_is_vendor_signed_gog \
  "$fixture_root/openclaw/tools/other/darwin-arm64/gog"; then
  echo "ERROR: non-Gog runtime path was treated as a vendor-signing exception" >&2
  exit 1
fi

echo "Gog vendor signature tests passed"
