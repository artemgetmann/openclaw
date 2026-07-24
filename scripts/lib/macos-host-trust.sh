#!/usr/bin/env bash

# Keep artifact verification and machine-trust diagnosis as separate claims.
# Apple's Security framework can return CSSMERR_TP_NOT_TRUSTED when invoked from
# a restricted execution context even though the same host validates the same
# binary normally. A known-good Apple binary is therefore the control sample:
# artifact failures are definitive only after this control succeeds.

OPENCLAW_MACOS_HOST_TRUST_STATE="unchecked"
OPENCLAW_MACOS_HOST_TRUST_DETAIL=""
OPENCLAW_MACOS_GATEKEEPER_STATE="unchecked"
OPENCLAW_MACOS_GATEKEEPER_DETAIL=""

openclaw_macos_host_trust_probe() {
  local codesign_bin="/usr/bin/codesign"
  local control_path="/bin/ls"
  local output=""

  # Fixture overrides are deliberately unavailable to release environments.
  # Otherwise a stale release.env value could replace the Apple-owned control
  # with an ad-hoc signed binary and turn a sandbox false negative into a
  # definitive artifact rejection.
  if [[ "${OPENCLAW_MACOS_HOST_TRUST_TEST_MODE:-0}" == "1" ]]; then
    codesign_bin="${OPENCLAW_MACOS_HOST_TRUST_CODESIGN_BIN:-$codesign_bin}"
    control_path="${OPENCLAW_MACOS_HOST_TRUST_CONTROL_PATH:-$control_path}"
  fi

  OPENCLAW_MACOS_HOST_TRUST_STATE="unchecked"
  OPENCLAW_MACOS_HOST_TRUST_DETAIL=""

  if [[ ! -x "$codesign_bin" ]]; then
    OPENCLAW_MACOS_HOST_TRUST_STATE="indeterminate"
    OPENCLAW_MACOS_HOST_TRUST_DETAIL="codesign is unavailable in this execution context: $codesign_bin"
    return 2
  fi
  if [[ ! -e "$control_path" ]]; then
    OPENCLAW_MACOS_HOST_TRUST_STATE="indeterminate"
    OPENCLAW_MACOS_HOST_TRUST_DETAIL="host-trust control binary is unavailable: $control_path"
    return 2
  fi

  # Do not classify a failed control as host corruption. The control is shipped
  # by macOS; failure means this process cannot distinguish a restricted
  # Security.framework view from a genuine host trust-store incident.
  if ! output="$("$codesign_bin" --verify --strict "$control_path" 2>&1)"; then
    OPENCLAW_MACOS_HOST_TRUST_STATE="indeterminate"
    OPENCLAW_MACOS_HOST_TRUST_DETAIL="${output:-codesign returned no diagnostic output}"
    return 2
  fi

  OPENCLAW_MACOS_HOST_TRUST_STATE="confirmed"
  return 0
}

openclaw_macos_host_trust_print_indeterminate() {
  local detail="${OPENCLAW_MACOS_HOST_TRUST_DETAIL:-no diagnostic output}"

  cat >&2 <<EOF
INDETERMINATE: macOS signature and Keychain trust cannot be evaluated from this execution context.
Control probe: /usr/bin/codesign --verify --strict /bin/ls
Control result: ${detail//$'\n'/ | }
Rerun outside any Codex/container/process sandbox from an ordinary macOS Terminal:
  bash scripts/probe-macos-host-trust.sh
Then rerun the original release verification from that same host Terminal.
This result does not justify artifact rejection, reboot, trustd/securityd restart, or Keychain reset/unlock.
EOF
}

openclaw_macos_host_trust_require() {
  if openclaw_macos_host_trust_probe; then
    return 0
  fi
  openclaw_macos_host_trust_print_indeterminate
  return 2
}

openclaw_macos_gatekeeper_probe() {
  local spctl_bin="/usr/sbin/spctl"
  local control_path="/System/Library/CoreServices/Finder.app"
  local output=""

  # Keep production controls pinned to Apple-owned paths. Tests may inject
  # deterministic fixtures only after opting into the isolated test mode.
  if [[ "${OPENCLAW_MACOS_HOST_TRUST_TEST_MODE:-0}" == "1" ]]; then
    spctl_bin="${OPENCLAW_MACOS_GATEKEEPER_SPCTL_BIN:-$spctl_bin}"
    control_path="${OPENCLAW_MACOS_GATEKEEPER_CONTROL_PATH:-$control_path}"
  fi

  OPENCLAW_MACOS_GATEKEEPER_STATE="unchecked"
  OPENCLAW_MACOS_GATEKEEPER_DETAIL=""

  if [[ ! -x "$spctl_bin" || ! -e "$control_path" ]]; then
    OPENCLAW_MACOS_GATEKEEPER_STATE="indeterminate"
    OPENCLAW_MACOS_GATEKEEPER_DETAIL="Gatekeeper control tooling or artifact is unavailable in this execution context"
    return 2
  fi

  # Gatekeeper is a separate policy service from codesign. Exercise the
  # Apple-owned control with the same "open" assessment type and primary
  # signature context used for release DMGs. An executable assessment is not
  # evidence that this separate policy path is available.
  if ! output="$(
    "$spctl_bin" -a -vv -t open --context context:primary-signature "$control_path" 2>&1
  )"; then
    OPENCLAW_MACOS_GATEKEEPER_STATE="indeterminate"
    OPENCLAW_MACOS_GATEKEEPER_DETAIL="${output:-spctl returned no diagnostic output}"
    return 2
  fi

  OPENCLAW_MACOS_GATEKEEPER_STATE="confirmed"
  return 0
}

openclaw_macos_gatekeeper_require() {
  if openclaw_macos_gatekeeper_probe; then
    return 0
  fi

  cat >&2 <<EOF
INDETERMINATE: macOS Gatekeeper cannot be evaluated from this execution context.
Gatekeeper control: /usr/sbin/spctl -a -vv -t open --context context:primary-signature /System/Library/CoreServices/Finder.app
Control result: ${OPENCLAW_MACOS_GATEKEEPER_DETAIL//$'\n'/ | }
Rerun the original release verification outside any Codex/container/process sandbox from an ordinary macOS Terminal.
This result does not justify artifact rejection, reboot, trustd/securityd restart, or Keychain reset/unlock.
EOF
  return 2
}

openclaw_macos_host_context_asserted() {
  [[ "${OPENCLAW_MACOS_HOST_CONTEXT_ASSERTED:-0}" == "1" ]]
}

openclaw_macos_host_context_require() {
  if openclaw_macos_host_context_asserted; then
    return 0
  fi

  cat >&2 <<'EOF'
INDETERMINATE: Keychain visibility was not asserted from an ordinary host Terminal.
Rerun outside any Codex/container/process sandbox with the explicit host-context assertion:
  bash scripts/preflight-consumer-mac-release.sh --host-context
This result does not prove a signing identity or notary profile is missing and does not justify Keychain reset/unlock.
EOF
  return 2
}
