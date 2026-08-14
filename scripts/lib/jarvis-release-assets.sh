#!/usr/bin/env bash

# Return GitHub's digest for one named asset. An empty result means the asset
# does not exist yet, which is distinct from permission or transport failure.
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
  local asset_name local_digest remote_digest

  asset_name="$(basename "$artifact_path")"
  local_digest="sha256:$(/usr/bin/shasum -a 256 "$artifact_path" | /usr/bin/awk '{ print $1 }')"
  remote_digest="$(openclaw_jarvis_release_remote_asset_digest "$repo" "$tag" "$asset_name")"

  if [[ -z "$remote_digest" ]]; then
    printf 'upload\n'
    return 0
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
