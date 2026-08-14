#!/usr/bin/env bash

# Return the matching GitHub asset name separately from its optional digest.
# Older release assets can exist without digest metadata, so digest absence is
# never treated as asset absence.
openclaw_jarvis_release_remote_asset_name() {
  local repo="$1"
  local tag="$2"
  local asset_name="$3"

  gh release view "$tag" --repo "$repo" --json assets \
    --jq ".assets[] | select(.name == \"$asset_name\") | .name" \
    | /usr/bin/head -n 1
}

openclaw_jarvis_release_remote_asset_digest() {
  local repo="$1"
  local tag="$2"
  local asset_name="$3"

  gh release view "$tag" --repo "$repo" --json assets \
    --jq ".assets[] | select(.name == \"$asset_name\") | .digest" \
    | /usr/bin/head -n 1
}

# Tagged ZIP and DMG URLs are permanent artifact identities. Permit a first
# upload or an identical retry, but fail before publication when the same URL
# already names different bytes.
openclaw_jarvis_release_require_immutable_asset_compatible() {
  local repo="$1"
  local tag="$2"
  local artifact_path="$3"
  local asset_name local_digest remote_name remote_digest curl_bin downloaded_digest

  asset_name="$(basename "$artifact_path")"
  local_digest="sha256:$(/usr/bin/shasum -a 256 "$artifact_path" | /usr/bin/awk '{ print $1 }')"
  remote_name="$(openclaw_jarvis_release_remote_asset_name "$repo" "$tag" "$asset_name")"

  if [[ -z "$remote_name" ]]; then
    printf 'upload\n'
    return 0
  fi
  remote_digest="$(openclaw_jarvis_release_remote_asset_digest "$repo" "$tag" "$asset_name")"
  if [[ -z "$remote_digest" || "$remote_digest" == "null" ]]; then
    # GitHub does not populate digest metadata for every historical asset.
    # Hash the public bytes so an identical retry remains safe and resumable.
    curl_bin="${OPENCLAW_JARVIS_RELEASE_CURL_BIN:-/usr/bin/curl}"
    downloaded_digest="$(
      "$curl_bin" --fail --location --silent --show-error \
        "https://github.com/$repo/releases/download/$tag/$asset_name" \
        | /usr/bin/shasum -a 256 \
        | /usr/bin/awk '{ print $1 }'
    )" || return $?
    remote_digest="sha256:$downloaded_digest"
  fi
  if [[ "$remote_digest" == "$local_digest" ]]; then
    printf 'identical\n'
    return 0
  fi

  echo "ERROR: immutable release asset already exists with different bytes: $repo@$tag/$asset_name" >&2
  echo "Local digest:  $local_digest" >&2
  echo "Remote digest: $remote_digest" >&2
  echo "Create a new release tag. Never overwrite a tagged Jarvis ZIP or DMG." >&2
  return 1
}

# Upload one immutable asset idempotently [safe to retry]. Rechecking inside
# every retry matters when a prior attempt uploaded the DMG but failed before
# the ZIP or appcast: the next attempt must recognize the first upload instead
# of trying to overwrite it.
openclaw_jarvis_release_upload_immutable_asset_if_needed() {
  local repo="$1"
  local tag="$2"
  local artifact_path="$3"
  local action

  action="$(openclaw_jarvis_release_require_immutable_asset_compatible "$repo" "$tag" "$artifact_path")" || return $?
  if [[ "$action" == "upload" ]]; then
    gh release upload "$tag" "$artifact_path" --repo "$repo"
  else
    echo "immutable_asset_upload=already-identical asset=$(basename "$artifact_path")"
  fi
}

# Read back the unauthenticated public URL and compare the exact bytes before
# the mutable appcast can point clients at a new immutable enclosure.
openclaw_jarvis_release_verify_public_asset_bytes() {
  local repo="$1"
  local tag="$2"
  local artifact_path="$3"
  local asset_name local_digest public_digest curl_bin

  asset_name="$(basename "$artifact_path")"
  local_digest="$(/usr/bin/shasum -a 256 "$artifact_path" | /usr/bin/awk '{ print $1 }')"
  curl_bin="${OPENCLAW_JARVIS_RELEASE_CURL_BIN:-/usr/bin/curl}"
  public_digest="$(
    "$curl_bin" --fail --location --silent --show-error \
      "https://github.com/$repo/releases/download/$tag/$asset_name" \
      | /usr/bin/shasum -a 256 \
      | /usr/bin/awk '{ print $1 }'
  )" || return $?

  if [[ "$public_digest" != "$local_digest" ]]; then
    echo "ERROR: public immutable asset bytes differ after upload: $repo@$tag/$asset_name" >&2
    echo "Local digest:  sha256:$local_digest" >&2
    echo "Public digest: sha256:${public_digest:-missing}" >&2
    return 1
  fi
  echo "immutable_asset_public_bytes=verified asset=$asset_name digest=sha256:$local_digest"
}
