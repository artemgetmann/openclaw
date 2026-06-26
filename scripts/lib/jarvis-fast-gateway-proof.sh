#!/usr/bin/env bash

# Pure comparison helpers for the Jarvis packaged-gateway proof script.
# Keep these side-effect free so the proof policy can be tested without touching
# launchd, the live Jarvis app, or Application Support runtime state.

jarvis_fast_gateway_launchagent_runtime_matches() {
  local expected_port="$1"
  local expected_home="$2"
  local expected_state_dir="$3"
  local expected_config_path="$4"
  local expected_entrypoint="$5"
  local expected_node_path_entry="$6"
  local expected_canonical_config="$7"
  local actual_port="$8"
  local actual_home="$9"
  local actual_state_dir="${10}"
  local actual_config_path="${11}"
  local actual_entrypoint="${12}"
  local actual_path="${13}"
  local actual_canonical_config="${14}"

  # Runtime ownership is the hard safety boundary. If these fields match, the
  # LaunchAgent is aimed at the installed Jarvis runtime even if optional
  # distribution metadata is stale and should be refreshed on the next app-owned
  # rewrite.
  [[ "$actual_port" == "$expected_port" ]] || return 1
  [[ "$actual_home" == "$expected_home" ]] || return 1
  [[ "$actual_state_dir" == "$expected_state_dir" ]] || return 1
  [[ "$actual_config_path" == "$expected_config_path" ]] || return 1
  [[ "$actual_entrypoint" == "$expected_entrypoint" ]] || return 1
  [[ "$actual_path" == *"$expected_node_path_entry"* ]] || return 1

  # The default shared label also carries an explicit canonical-config marker.
  # Isolated instances do not need it, so an empty expectation means "skip".
  [[ -z "$expected_canonical_config" || "$actual_canonical_config" == "$expected_canonical_config" ]]
}

jarvis_fast_gateway_launchagent_service_metadata_matches() {
  local expected_version="$1"
  local expected_build="$2"
  local actual_service_version="$3"
  local actual_service_build="$4"

  [[ "$actual_service_version" == "$expected_version" ]] || return 1
  [[ "$actual_service_build" == "$expected_build" ]]
}

jarvis_fast_gateway_proof_gap() {
  local launchagent_present="$1"
  local runtime_matches_expected="$2"
  local service_metadata_matches_expected="$3"
  local run_status="$4"
  local status_probe_ok="$5"
  local expected_label="$6"

  if [[ "$launchagent_present" == "0" ]]; then
    printf 'gateway LaunchAgent is not present for %s\n' "$expected_label"
    return 0
  fi
  if [[ "$runtime_matches_expected" != "1" ]]; then
    printf 'gateway LaunchAgent does not yet point at the packaged Jarvis installed runtime\n'
    return 0
  fi
  if [[ "$service_metadata_matches_expected" != "1" ]]; then
    printf 'gateway LaunchAgent points at the packaged Jarvis installed runtime, but service metadata still needs an app-owned refresh\n'
    return 0
  fi
  if [[ "$run_status" == "1" && "$status_probe_ok" != "1" ]]; then
    printf 'gateway LaunchAgent matches packaged runtime, but RPC status did not pass\n'
    return 0
  fi
}
