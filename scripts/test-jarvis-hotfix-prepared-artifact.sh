#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HELPER="${ROOT_DIR}/scripts/lib/jarvis-hotfix-prepared-artifact.mjs"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/jarvis-hotfix-receipt-test.XXXXXX")"
trap 'chflags -R nouchg "${TMP_ROOT}" 2>/dev/null || true; chmod -R u+w "${TMP_ROOT}" 2>/dev/null || true; rm -rf "${TMP_ROOT}"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

pass() {
  printf 'PASS: %s\n' "$*"
}

APP="${TMP_ROOT}/Jarvis.app"
METADATA="${TMP_ROOT}/metadata.json"
RECEIPT="${TMP_ROOT}/receipt.json"
mkdir -p "${APP}/Contents/MacOS"
printf 'binary-v1\n' >"${APP}/Contents/MacOS/OpenClaw"
ln -s OpenClaw "${APP}/Contents/MacOS/JarvisGatewayWatchdog"

write_metadata() {
  local created_at="$1"
  local expires_at="$2"
  jq -n --arg createdAt "${created_at}" --arg expiresAt "${expires_at}" '{
    authority:{pr:42,mainPolicy:"exact-pr"},
    source:{gitCommit:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
    inputs:{lockfilesSha256:("b"*64),packagingScriptsSha256:("c"*64)},
    toolchain:{nodeVersion:"24.7.0",hostArchitecture:"arm64",runtimeNodeVersion:"24.7.0",runtimeUvVersion:"0.9.21",runtimeInputKey:("d"*64)},
    app:{version:"2026.8.14",build:"2026081401"},
    signing:{certificateSha1:("A"*40),certificateCommonName:"Developer ID Application: ARTEM GETMAN (SKDYY4SBVV)",teamId:"SKDYY4SBVV",requirement:"Developer ID Application with hardened runtime and exact Team ID"},
    locks:{gatewayMain:false,releaseJarvis:false},
    metrics:{prepareSeconds:300,runtimeCache:"hit",diskDeltaKiB:1024},
    createdAt:$createdAt,
    expiresAt:$expiresAt
  }' >"${METADATA}"
}

created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
expires_at="$(date -u -v+6H +%Y-%m-%dT%H:%M:%SZ)"
write_metadata "${created_at}" "${expires_at}"
chmod -R a-w "${APP}"
node "${HELPER}" create "${APP}" "${METADATA}" "${RECEIPT}" >/dev/null
chmod a-w "${RECEIPT}"
node "${HELPER}" verify "${APP}" "${RECEIPT}" >/dev/null
pass "complete read-only artifact and exact receipt verify"

TAMPER_RECEIPT="${TMP_ROOT}/tampered-receipt.json"
cp "${RECEIPT}" "${TAMPER_RECEIPT}"
chmod u+w "${TAMPER_RECEIPT}"
jq '.app.build="2026081402"' "${TAMPER_RECEIPT}" >"${TAMPER_RECEIPT}.next"
mv "${TAMPER_RECEIPT}.next" "${TAMPER_RECEIPT}"
if node "${HELPER}" verify "${APP}" "${TAMPER_RECEIPT}" >/dev/null 2>&1; then
  fail "receipt tamper unexpectedly verified"
fi
pass "receipt tamper fails closed"

TAMPER_APP="${TMP_ROOT}/Tampered.app"
cp -R "${APP}" "${TAMPER_APP}"
chmod -R u+w "${TAMPER_APP}"
printf 'tampered\n' >>"${TAMPER_APP}/Contents/MacOS/OpenClaw"
chmod -R a-w "${TAMPER_APP}"
if node "${HELPER}" verify "${TAMPER_APP}" "${RECEIPT}" >/dev/null 2>&1; then
  fail "artifact tamper unexpectedly verified"
fi
pass "artifact content tamper fails closed"

ESCAPE_ROOT="${TMP_ROOT}/escape"
mkdir -p "${ESCAPE_ROOT}/app" "${ESCAPE_ROOT}/outside"
ln -s "${ESCAPE_ROOT}/outside" "${ESCAPE_ROOT}/app/external"
if node "${HELPER}" hash-tree "${ESCAPE_ROOT}/app" >/dev/null 2>&1; then
  fail "artifact hash accepted a symlink that escapes the immutable root"
fi
ln -s "${ESCAPE_ROOT}/app" "${ESCAPE_ROOT}/app-link"
if node "${HELPER}" hash-tree "${ESCAPE_ROOT}/app-link" >/dev/null 2>&1; then
  fail "artifact hash accepted a symlink as its root"
fi
pass "artifact identity rejects root and nested symlink escapes"

WRITABLE_APP="${TMP_ROOT}/Writable.app"
cp -R "${APP}" "${WRITABLE_APP}"
chmod u+w "${WRITABLE_APP}/Contents/MacOS/OpenClaw"
if node "${HELPER}" verify "${WRITABLE_APP}" "${RECEIPT}" >/dev/null 2>&1; then
  fail "writable prepared artifact unexpectedly verified"
fi
pass "writable or incompletely sealed artifact fails closed"

EXPIRED_METADATA="${TMP_ROOT}/expired-metadata.json"
EXPIRED_RECEIPT="${TMP_ROOT}/expired-receipt.json"
write_metadata "2026-08-13T00:00:00Z" "2026-08-13T01:00:00Z"
cp "${METADATA}" "${EXPIRED_METADATA}"
node "${HELPER}" create "${APP}" "${EXPIRED_METADATA}" "${EXPIRED_RECEIPT}" >/dev/null
if node "${HELPER}" verify "${APP}" "${EXPIRED_RECEIPT}" >/dev/null 2>&1; then
  fail "expired prepared receipt unexpectedly verified"
fi
pass "expired prepared receipt fails closed"

if node "${HELPER}" verify "${APP}" "${TMP_ROOT}/missing-receipt.json" >/dev/null 2>&1; then
  fail "incomplete prepare without receipt unexpectedly verified"
fi
pass "cancelled or incomplete prepare has no consumable receipt"

printf 'All Jarvis prepared-artifact tests passed.\n'
