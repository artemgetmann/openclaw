#!/usr/bin/env bash

# Artifact-bound resume checkpoints for Jarvis macOS releases. Manifests remain
# useful operator summaries, but only these strict records can authorize reuse
# of a signed or notarized artifact.

OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE=""
OPENCLAW_JARVIS_RELEASE_CHECKPOINT_NOTARIZED_FAILURE=""

# The checkpoint helper is sourced by release entry points and tests. Resolve
# this sibling without assuming the caller's working directory.
OPENCLAW_JARVIS_RELEASE_CHECKPOINT_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$OPENCLAW_JARVIS_RELEASE_CHECKPOINT_LIB_DIR/macos-host-trust.sh"

openclaw_jarvis_release_checkpoint_value() {
  local metadata_path="$1"
  local key="$2"
  /usr/bin/sed -n "s/^${key}=//p" "$metadata_path" 2>/dev/null | /usr/bin/head -n 1
}

openclaw_jarvis_release_checkpoint_path() {
  local artifact_path="$1"
  printf '%s.release-checkpoint.env\n' "$artifact_path"
}

openclaw_jarvis_release_checkpoint_absolute_path() {
  local artifact_path="$1"
  local artifact_parent artifact_name
  artifact_parent="$(cd "$(dirname "$artifact_path")" && pwd -P)" || return 1
  artifact_name="$(basename "$artifact_path")"
  printf '%s/%s\n' "$artifact_parent" "$artifact_name"
}

openclaw_jarvis_release_checkpoint_plist_value() {
  local app_path="$1"
  local key="$2"
  local plistbuddy="${OPENCLAW_JARVIS_RELEASE_CHECKPOINT_PLISTBUDDY:-/usr/libexec/PlistBuddy}"
  "$plistbuddy" -c "Print $key" "$app_path/Contents/Info.plist" 2>/dev/null
}

openclaw_jarvis_release_checkpoint_file_sha256() {
  local artifact_path="$1"
  [[ -f "$artifact_path" ]] || return 1
  /usr/bin/shasum -a 256 "$artifact_path" | /usr/bin/awk '{ print $1 }'
}

openclaw_jarvis_release_checkpoint_artifact_sha256() {
  local artifact_path="$1"
  local artifact_kind="$2"

  if [[ "$artifact_kind" == "app" ]]; then
    # CodeResources is the signed manifest sealing the bundle's resources.
    # Hashing it plus running codesign verification avoids unstable archive
    # metadata while still detecting any modified sealed bundle content.
    openclaw_jarvis_release_checkpoint_file_sha256 \
      "$artifact_path/Contents/_CodeSignature/CodeResources"
    return
  fi
  openclaw_jarvis_release_checkpoint_file_sha256 "$artifact_path"
}

openclaw_jarvis_release_checkpoint_verify_signature() {
  local artifact_path="$1"
  local artifact_kind="$2"
  local codesign_bin="${OPENCLAW_JARVIS_RELEASE_CHECKPOINT_CODESIGN_BIN:-/usr/bin/codesign}"

  OPENCLAW_MACOS_HOST_TRUST_CODESIGN_BIN="$codesign_bin" \
    openclaw_macos_host_trust_require || {
      OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE="host-trust-indeterminate"
      return 2
    }

  case "$artifact_kind" in
    app)
      "$codesign_bin" --verify --deep --strict "$artifact_path" >/dev/null 2>&1
      ;;
    dmg)
      "$codesign_bin" --verify --strict "$artifact_path" >/dev/null 2>&1
      ;;
    zip|appcast)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

openclaw_jarvis_release_checkpoint_app_cdhash() {
  local app_path="$1"
  local codesign_bin="${OPENCLAW_JARVIS_RELEASE_CHECKPOINT_CODESIGN_BIN:-/usr/bin/codesign}"
  local output cdhash

  # codesign verification proves the current bundle is internally valid, while
  # CDHash identifies the actual signed code directory. Persist both: a bundle
  # with a different valid signature must not inherit an older checkpoint.
  output="$("$codesign_bin" -dv --verbose=4 "$app_path" 2>&1)" || return 1
  cdhash="$(printf '%s\n' "$output" | /usr/bin/sed -n 's/^CDHash=//p' | /usr/bin/head -n 1 | /usr/bin/tr '[:upper:]' '[:lower:]')"
  case "$cdhash" in
    ''|*[!0-9a-f]*) return 1 ;;
  esac
  if [[ "${#cdhash}" -ne 40 && "${#cdhash}" -ne 64 ]]; then
    return 1
  fi
  printf '%s\n' "$cdhash"
}

openclaw_jarvis_release_checkpoint_verify_notarized() {
  local artifact_path="$1"
  local artifact_kind="$2"
  local xcrun_bin="${OPENCLAW_JARVIS_RELEASE_CHECKPOINT_XCRUN_BIN:-/usr/bin/xcrun}"
  local spctl_bin="${OPENCLAW_JARVIS_RELEASE_CHECKPOINT_SPCTL_BIN:-/usr/sbin/spctl}"

  OPENCLAW_JARVIS_RELEASE_CHECKPOINT_NOTARIZED_FAILURE=""
  "$xcrun_bin" stapler validate "$artifact_path" >/dev/null 2>&1 || {
    OPENCLAW_JARVIS_RELEASE_CHECKPOINT_NOTARIZED_FAILURE="staple"
    return 1
  }
  case "$artifact_kind" in
    app)
      "$spctl_bin" -a -vv "$artifact_path" >/dev/null 2>&1 || {
        OPENCLAW_JARVIS_RELEASE_CHECKPOINT_NOTARIZED_FAILURE="gatekeeper"
        return 1
      }
      ;;
    dmg)
      "$spctl_bin" -a -t open --context context:primary-signature "$artifact_path" >/dev/null 2>&1 || {
        OPENCLAW_JARVIS_RELEASE_CHECKPOINT_NOTARIZED_FAILURE="gatekeeper"
        return 1
      }
      ;;
    *)
      OPENCLAW_JARVIS_RELEASE_CHECKPOINT_NOTARIZED_FAILURE="artifact-kind"
      return 1
      ;;
  esac
}

openclaw_jarvis_release_checkpoint_receipt_matches() {
  local receipt_path="$1"
  local artifact_path="$2"
  local artifact_kind="$3"
  local expected_status="$4"
  local expected_submission_id="$5"
  local receipt_status receipt_submission receipt_artifact receipt_staple

  [[ -f "$receipt_path" ]] || return 1
  receipt_status="$(openclaw_jarvis_release_checkpoint_value "$receipt_path" NOTARY_STATUS)"
  receipt_submission="$(openclaw_jarvis_release_checkpoint_value "$receipt_path" NOTARY_SUBMISSION_ID)"
  receipt_artifact="$(openclaw_jarvis_release_checkpoint_value "$receipt_path" NOTARY_ARTIFACT)"
  receipt_staple="$(openclaw_jarvis_release_checkpoint_value "$receipt_path" NOTARY_STAPLE_APP_PATH)"

  case "$expected_status" in
    submitted)
      # `notarytool info` replaces our initial `submitted` marker with Apple's
      # pending status. Both values name the same durable submission, so keep
      # the submitted checkpoint resumable only while the receipt remains on
      # that non-terminal allowlist. Terminal outcomes must never inherit a
      # poll authorization.
      case "$receipt_status" in
        submitted|"In Progress"|"In\\ Progress") ;;
        *) return 1 ;;
      esac
      ;;
    *)
      [[ "$receipt_status" == "$expected_status" ]] || return 1
      ;;
  esac
  [[ -n "$expected_submission_id" && "$receipt_submission" == "$expected_submission_id" ]] || return 1
  if [[ "$artifact_kind" == "dmg" ]]; then
    [[ "$receipt_artifact" == "$artifact_path" ]] || return 1
  elif [[ "$artifact_kind" == "app" ]]; then
    [[ "$receipt_staple" == "$artifact_path" ]] || return 1
  fi
}

openclaw_jarvis_release_checkpoint_write() {
  local root="$1"
  local artifact_path="$2"
  local artifact_kind="$3"
  local intended_phase="$4"
  local notary_status="${5:-not-required}"
  local notary_submission_id="${6:-}"
  local app_context_path="${7:-}"
  local checkpoint_path checkpoint_tmp absolute_path absolute_app_context sha256 commit version build embedded_commit app_cdhash
  local signature_verified="not-applicable"
  local staple_validated="not-applicable"

  absolute_path="$(openclaw_jarvis_release_checkpoint_absolute_path "$artifact_path")" || return 1
  if [[ "$artifact_kind" == "app" ]]; then
    app_context_path="$artifact_path"
  fi
  [[ -n "$app_context_path" ]] || return 1
  absolute_app_context="$(openclaw_jarvis_release_checkpoint_absolute_path "$app_context_path")" || return 1
  checkpoint_path="$(openclaw_jarvis_release_checkpoint_path "$absolute_path")"
  checkpoint_tmp="${checkpoint_path}.tmp.$$"
  commit="$(git -C "$root" rev-parse HEAD 2>/dev/null)" || return 1
  sha256="$(openclaw_jarvis_release_checkpoint_artifact_sha256 "$absolute_path" "$artifact_kind")" || return 1
  version="$(openclaw_jarvis_release_checkpoint_plist_value "$absolute_app_context" CFBundleShortVersionString)" || return 1
  build="$(openclaw_jarvis_release_checkpoint_plist_value "$absolute_app_context" CFBundleVersion)" || return 1
  embedded_commit="$(openclaw_jarvis_release_checkpoint_plist_value "$absolute_app_context" OpenClawGitCommit)" || return 1
  openclaw_jarvis_release_checkpoint_verify_signature "$absolute_app_context" app || return 1
  app_cdhash="$(openclaw_jarvis_release_checkpoint_app_cdhash "$absolute_app_context")" || return 1

  case "$artifact_kind" in
    app)
      openclaw_jarvis_release_checkpoint_verify_signature "$absolute_path" "$artifact_kind" || return 1
      signature_verified="true"
      ;;
    dmg)
      openclaw_jarvis_release_checkpoint_verify_signature "$absolute_path" "$artifact_kind" || return 1
      signature_verified="true"
      ;;
    zip|appcast)
      ;;
    *)
      return 1
      ;;
  esac

  case "$notary_status" in
    not-required)
      [[ -z "$notary_submission_id" ]] || return 1
      ;;
    submitted)
      [[ -n "$notary_submission_id" ]] || return 1
      ;;
    Accepted)
      [[ -n "$notary_submission_id" ]] || return 1
      case "$intended_phase" in
        app-notary-accepted|dmg-notary-accepted)
          [[ "$artifact_kind:$intended_phase" == "app:app-notary-accepted" \
            || "$artifact_kind:$intended_phase" == "dmg:dmg-notary-accepted" ]] || return 1
          # Apple acceptance is durable even when local stapling or current
          # Gatekeeper policy fails. Preserve the exact accepted submission and
          # artifact identity so recovery polls/staples again without resubmit.
          staple_validated="pending"
          ;;
        *)
          openclaw_jarvis_release_checkpoint_verify_notarized "$absolute_path" "$artifact_kind" || return 1
          staple_validated="true"
          ;;
      esac
      ;;
    *)
      return 1
      ;;
  esac

  mkdir -p "$(dirname "$checkpoint_path")"
  {
    # Version 2 requires every artifact to carry the signed app context. A v1
    # checkpoint must fail closed instead of being silently upgraded in place.
    printf 'JARVIS_RELEASE_CHECKPOINT_VERSION=2\n'
    printf 'JARVIS_RELEASE_CHECKPOINT_ARTIFACT_KIND=%s\n' "$artifact_kind"
    printf 'JARVIS_RELEASE_CHECKPOINT_INTENDED_PHASE=%s\n' "$intended_phase"
    printf 'JARVIS_RELEASE_CHECKPOINT_ARTIFACT_PATH=%s\n' "$absolute_path"
    printf 'JARVIS_RELEASE_CHECKPOINT_ARTIFACT_IDENTITY=%s:sha256:%s\n' "$artifact_kind" "$sha256"
    printf 'JARVIS_RELEASE_CHECKPOINT_ARTIFACT_SHA256=%s\n' "$sha256"
    printf 'JARVIS_RELEASE_CHECKPOINT_GIT_COMMIT=%s\n' "$commit"
    printf 'JARVIS_RELEASE_CHECKPOINT_APP_CONTEXT_PATH=%s\n' "$absolute_app_context"
    printf 'JARVIS_RELEASE_CHECKPOINT_APP_VERSION=%s\n' "$version"
    printf 'JARVIS_RELEASE_CHECKPOINT_APP_BUILD=%s\n' "$build"
    printf 'JARVIS_RELEASE_CHECKPOINT_APP_GIT_COMMIT=%s\n' "$embedded_commit"
    printf 'JARVIS_RELEASE_CHECKPOINT_APP_CDHASH=%s\n' "$app_cdhash"
    printf 'JARVIS_RELEASE_CHECKPOINT_SIGNATURE_VERIFIED=%s\n' "$signature_verified"
    printf 'JARVIS_RELEASE_CHECKPOINT_NOTARY_STATUS=%s\n' "$notary_status"
    printf 'JARVIS_RELEASE_CHECKPOINT_NOTARY_SUBMISSION_ID=%s\n' "$notary_submission_id"
    printf 'JARVIS_RELEASE_CHECKPOINT_STAPLE_VALIDATED=%s\n' "$staple_validated"
    printf 'JARVIS_RELEASE_CHECKPOINT_CREATED_AT_EPOCH=%s\n' "$(date -u '+%s')"
  } >"$checkpoint_tmp"
  mv -f "$checkpoint_tmp" "$checkpoint_path"
  echo "jarvis_release_checkpoint_written=$checkpoint_path"
}

openclaw_jarvis_release_checkpoint_validate() {
  local root="$1"
  local artifact_path="$2"
  local artifact_kind="$3"
  local intended_phase="$4"
  local receipt_path="${5:-}"
  local app_context_path="${6:-}"
  local checkpoint_path absolute_path version phase kind path identity sha256 actual_sha256
  local commit expected_commit checkpoint_app_context absolute_app_context app_version app_build embedded_commit app_cdhash
  local actual_version actual_build actual_embedded actual_app_cdhash
  local signature_verified notary_status submission_id staple_validated created_at

  OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE=""
  absolute_path="$(openclaw_jarvis_release_checkpoint_absolute_path "$artifact_path")" || {
    OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE="artifact-missing"
    return 1
  }
  if [[ "$artifact_kind" == "app" ]]; then
    app_context_path="$artifact_path"
  fi
  [[ -n "$app_context_path" ]] || {
    OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE="app-context-missing"
    return 1
  }
  absolute_app_context="$(openclaw_jarvis_release_checkpoint_absolute_path "$app_context_path")" || {
    OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE="app-context-missing"
    return 1
  }
  checkpoint_path="$(openclaw_jarvis_release_checkpoint_path "$absolute_path")"
  [[ -f "$checkpoint_path" ]] || {
    OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE="checkpoint-missing"
    return 1
  }

  version="$(openclaw_jarvis_release_checkpoint_value "$checkpoint_path" JARVIS_RELEASE_CHECKPOINT_VERSION)"
  kind="$(openclaw_jarvis_release_checkpoint_value "$checkpoint_path" JARVIS_RELEASE_CHECKPOINT_ARTIFACT_KIND)"
  phase="$(openclaw_jarvis_release_checkpoint_value "$checkpoint_path" JARVIS_RELEASE_CHECKPOINT_INTENDED_PHASE)"
  path="$(openclaw_jarvis_release_checkpoint_value "$checkpoint_path" JARVIS_RELEASE_CHECKPOINT_ARTIFACT_PATH)"
  identity="$(openclaw_jarvis_release_checkpoint_value "$checkpoint_path" JARVIS_RELEASE_CHECKPOINT_ARTIFACT_IDENTITY)"
  sha256="$(openclaw_jarvis_release_checkpoint_value "$checkpoint_path" JARVIS_RELEASE_CHECKPOINT_ARTIFACT_SHA256)"
  commit="$(openclaw_jarvis_release_checkpoint_value "$checkpoint_path" JARVIS_RELEASE_CHECKPOINT_GIT_COMMIT)"
  checkpoint_app_context="$(openclaw_jarvis_release_checkpoint_value "$checkpoint_path" JARVIS_RELEASE_CHECKPOINT_APP_CONTEXT_PATH)"
  app_version="$(openclaw_jarvis_release_checkpoint_value "$checkpoint_path" JARVIS_RELEASE_CHECKPOINT_APP_VERSION)"
  app_build="$(openclaw_jarvis_release_checkpoint_value "$checkpoint_path" JARVIS_RELEASE_CHECKPOINT_APP_BUILD)"
  embedded_commit="$(openclaw_jarvis_release_checkpoint_value "$checkpoint_path" JARVIS_RELEASE_CHECKPOINT_APP_GIT_COMMIT)"
  app_cdhash="$(openclaw_jarvis_release_checkpoint_value "$checkpoint_path" JARVIS_RELEASE_CHECKPOINT_APP_CDHASH)"
  signature_verified="$(openclaw_jarvis_release_checkpoint_value "$checkpoint_path" JARVIS_RELEASE_CHECKPOINT_SIGNATURE_VERIFIED)"
  notary_status="$(openclaw_jarvis_release_checkpoint_value "$checkpoint_path" JARVIS_RELEASE_CHECKPOINT_NOTARY_STATUS)"
  submission_id="$(openclaw_jarvis_release_checkpoint_value "$checkpoint_path" JARVIS_RELEASE_CHECKPOINT_NOTARY_SUBMISSION_ID)"
  staple_validated="$(openclaw_jarvis_release_checkpoint_value "$checkpoint_path" JARVIS_RELEASE_CHECKPOINT_STAPLE_VALIDATED)"
  created_at="$(openclaw_jarvis_release_checkpoint_value "$checkpoint_path" JARVIS_RELEASE_CHECKPOINT_CREATED_AT_EPOCH)"

  if [[ "$version" != "2" || "$kind" != "$artifact_kind" || "$phase" != "$intended_phase" || "$path" != "$absolute_path" || "$checkpoint_app_context" != "$absolute_app_context" ]]; then
    OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE="schema-or-metadata"
    return 1
  fi
  case "$sha256:$created_at" in
    *[!0-9a-f:]*|:*|*:)
      OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE="schema-or-metadata"
      return 1
      ;;
  esac
  if [[ "${#sha256}" -ne 64 ]]; then
    OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE="schema-or-metadata"
    return 1
  fi
  [[ "$identity" == "$artifact_kind:sha256:$sha256" ]] || {
    OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE="identity"
    return 1
  }

  expected_commit="$(git -C "$root" rev-parse HEAD 2>/dev/null)" || return 1
  [[ "$commit" == "$expected_commit" ]] || {
    OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE="commit"
    return 1
  }
  actual_sha256="$(openclaw_jarvis_release_checkpoint_artifact_sha256 "$absolute_path" "$artifact_kind")" || {
    OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE="checksum"
    return 1
  }
  [[ "$sha256" == "$actual_sha256" ]] || {
    OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE="checksum"
    return 1
  }

  actual_version="$(openclaw_jarvis_release_checkpoint_plist_value "$absolute_app_context" CFBundleShortVersionString)" || return 1
  actual_build="$(openclaw_jarvis_release_checkpoint_plist_value "$absolute_app_context" CFBundleVersion)" || return 1
  actual_embedded="$(openclaw_jarvis_release_checkpoint_plist_value "$absolute_app_context" OpenClawGitCommit)" || return 1
  openclaw_jarvis_release_checkpoint_verify_signature "$absolute_app_context" app || {
    OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE="app-signature"
    return 1
  }
  actual_app_cdhash="$(openclaw_jarvis_release_checkpoint_app_cdhash "$absolute_app_context")" || {
    OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE="app-signed-code-identity"
    return 1
  }
  if [[ -z "$app_cdhash" || "$app_cdhash" != "$actual_app_cdhash" ]]; then
    OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE="app-signed-code-identity"
    return 1
  fi
  if [[ -z "$app_version" || -z "$app_build" || "$app_version" != "$actual_version" || "$app_build" != "$actual_build" || "$embedded_commit" != "$actual_embedded" || "$expected_commit" != "$actual_embedded"* ]]; then
    OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE="app-metadata"
    return 1
  fi
  if [[ -n "${APP_VERSION:-}" && "$APP_VERSION" != "$actual_version" ]]; then
    OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE="app-version-intent"
    return 1
  fi
  if [[ -n "${APP_BUILD:-}" && "$APP_BUILD" != "$actual_build" ]]; then
    OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE="app-build-intent"
    return 1
  fi

  case "$artifact_kind" in
    app|dmg)
      [[ "$signature_verified" == "true" ]] || {
        OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE="signature"
        return 1
      }
      openclaw_jarvis_release_checkpoint_verify_signature "$absolute_path" "$artifact_kind" || {
        OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE="signature"
        return 1
      }
      ;;
    zip|appcast)
      [[ "$signature_verified" == "not-applicable" ]] || return 1
      ;;
  esac

  case "$intended_phase" in
    app-signed|dmg-signed|sparkle-zip|sparkle-appcast)
      [[ "$notary_status" == "not-required" && -z "$submission_id" && "$staple_validated" == "not-applicable" ]] || {
        OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE="notary-metadata"
        return 1
      }
      ;;
    app-notary-submitted|dmg-notary-submitted)
      [[ "$notary_status" == "submitted" && -n "$submission_id" && "$staple_validated" == "not-applicable" ]] || {
        OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE="notary-metadata"
        return 1
      }
      openclaw_jarvis_release_checkpoint_receipt_matches "$receipt_path" "$absolute_path" "$artifact_kind" "submitted" "$submission_id" || {
        OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE="notary-receipt"
        return 1
      }
      ;;
    app-notary-accepted|dmg-notary-accepted)
      if [[ "$artifact_kind:$intended_phase" != "app:app-notary-accepted" \
        && "$artifact_kind:$intended_phase" != "dmg:dmg-notary-accepted" ]]; then
        OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE="phase"
        return 1
      fi
      [[ "$notary_status" == "Accepted" && -n "$submission_id" && "$staple_validated" == "pending" ]] || {
        OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE="notary-metadata"
        return 1
      }
      openclaw_jarvis_release_checkpoint_receipt_matches "$receipt_path" "$absolute_path" "$artifact_kind" "Accepted" "$submission_id" || {
        OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE="notary-receipt"
        return 1
      }
      ;;
    app-notarized|dmg-notarized)
      [[ "$notary_status" == "Accepted" && -n "$submission_id" && "$staple_validated" == "true" ]] || {
        OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE="notary-metadata"
        return 1
      }
      openclaw_jarvis_release_checkpoint_receipt_matches "$receipt_path" "$absolute_path" "$artifact_kind" "Accepted" "$submission_id" || {
        OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE="notary-receipt"
        return 1
      }
      openclaw_jarvis_release_checkpoint_verify_notarized "$absolute_path" "$artifact_kind" || {
        OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE="${OPENCLAW_JARVIS_RELEASE_CHECKPOINT_NOTARIZED_FAILURE:-notarized-validation}"
        return 1
      }
      ;;
    *)
      OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE="phase"
      return 1
      ;;
  esac

  return 0
}

openclaw_require_jarvis_release_checkpoint() {
  local root="$1"
  local artifact_path="$2"
  local artifact_kind="$3"
  local intended_phase="$4"
  local receipt_path="${5:-}"
  local app_context_path="${6:-}"

  if openclaw_jarvis_release_checkpoint_validate "$root" "$artifact_path" "$artifact_kind" "$intended_phase" "$receipt_path" "$app_context_path"; then
    echo "jarvis_release_checkpoint=valid"
    echo "jarvis_release_checkpoint_phase=$intended_phase"
    return 0
  fi

  echo "ERROR: release checkpoint is ${OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE:-invalid} for $artifact_path." >&2
  echo "Artifact existence or manifest status alone cannot authorize $intended_phase reuse." >&2
  return 1
}
