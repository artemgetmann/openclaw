#!/usr/bin/env bash

# Shared consumer packaging contract guard.
# Keep this in sync with docs/consumer/openclaw-consumer-packaging-contract.md.

openclaw_consumer_packaging_contract_fail() {
  local message="$1"
  echo "ERROR: $message" >&2
  echo "Read docs/consumer/openclaw-consumer-packaging-contract.md before packaging consumer mac apps." >&2
  exit 1
}

openclaw_consumer_packaging_contract_mode() {
  local mode="${OPENCLAW_CONSUMER_PACKAGING_CONTRACT:-}"
  case "$mode" in
    bundled)
      if [[ "${OPENCLAW_CONSUMER_BUNDLED_RUNTIME_READY:-}" != "1" ]]; then
        openclaw_consumer_packaging_contract_fail \
          "consumer packaging contract bundled requires OPENCLAW_CONSUMER_BUNDLED_RUNTIME_READY=1."
      fi
      if [[ -n "${OPENCLAW_CONSUMER_INSTALLER_URL:-}" ]]; then
        openclaw_consumer_packaging_contract_fail \
          "bundled consumer packaging must not set OPENCLAW_CONSUMER_INSTALLER_URL."
      fi
      ;;
    legacy-bootstrap)
      if [[ "${OPENCLAW_CONSUMER_LEGACY_BOOTSTRAP_OK:-}" != "1" ]]; then
        openclaw_consumer_packaging_contract_fail \
          "legacy consumer packaging requires OPENCLAW_CONSUMER_LEGACY_BOOTSTRAP_OK=1."
      fi
      if [[ -z "${OPENCLAW_CONSUMER_INSTALLER_URL:-}" ]]; then
        openclaw_consumer_packaging_contract_fail \
          "legacy consumer packaging requires OPENCLAW_CONSUMER_INSTALLER_URL."
      fi
      ;;
    "")
      openclaw_consumer_packaging_contract_fail \
        "consumer packaging contract missing. Set OPENCLAW_CONSUMER_PACKAGING_CONTRACT=bundled for the self-contained path or legacy-bootstrap only for intentional transitional work."
      ;;
    *)
      openclaw_consumer_packaging_contract_fail \
        "unknown consumer packaging contract '$mode'. Expected bundled or legacy-bootstrap."
      ;;
  esac

  printf '%s\n' "$mode"
}
