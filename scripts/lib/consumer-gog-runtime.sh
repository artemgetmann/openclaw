#!/usr/bin/env bash

# Materialize the pinned, vendor-signed Gog release without merging or
# re-signing its architecture slices. Callers must source
# openclaw-runtime-payloads.sh first so identity verification stays shared with
# app signing and final package verification.
openclaw_ensure_consumer_gog_runtime() {
  local version="$1"
  local cache_parent="${OPENCLAW_CONSUMER_GOG_CACHE_ROOT:-${ROOT_DIR}/.cache/consumer-runtime}"
  local cache_root="${cache_parent}/gog-v${version}-darwin-vendor-signed"
  local arm64_bin="${cache_root}/gog/darwin-arm64/gog"
  local x86_64_bin="${cache_root}/gog/darwin-x86_64/gog"
  local license_path="${cache_root}/LICENSE"
  local download_root=""
  local release_arch=""
  local archive=""
  local expected_sha256=""
  local extracted_bin=""
  local expected_arch=""
  local extracted_archs=""
  local packaged_bin=""
  local host_arch=""
  local host_bin=""

  if [[ -x "$arm64_bin" ]] \
    && [[ -x "$x86_64_bin" ]] \
    && [[ -s "$license_path" ]] \
    && openclaw_verify_vendor_signed_gog "$arm64_bin" \
    && openclaw_verify_vendor_signed_gog "$x86_64_bin"; then
    printf '%s\n' "$cache_root"
    return 0
  fi

  # Keep the official thin binaries separate: lipo would invalidate their
  # Developer ID signatures, and re-signing with Jarvis changes the Keychain
  # designated requirement existing token ACLs expect.
  rm -rf "$cache_root"
  download_root="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-consumer-gog.XXXXXX")"
  for release_arch in arm64 amd64; do
    # Release asset digests are pinned with the product version. A metadata bump
    # without reviewed payload hashes must fail closed instead of downloading
    # unverified executable code into a signed Jarvis release.
    case "${version}:${release_arch}" in
      0.33.0:arm64)
        expected_sha256="d73b324fa3a35a08175432761c8bfd410896b1a22365aa89890ac4fbfdf7c66e"
        ;;
      0.33.0:amd64)
        expected_sha256="259c4bf1f41bc725936eb816aac9d5c95df9eaf21be0a8df93a9c42fe55f83a4"
        ;;
      *)
        echo "ERROR: no reviewed gog release digest for v${version} darwin_${release_arch}." >&2
        echo "Update consumer-gog-runtime.sh with the official release asset digest." >&2
        rm -rf "$download_root"
        return 1
        ;;
    esac

    archive="${download_root}/gogcli_${version}_darwin_${release_arch}.tar.gz"
    echo "📥 Downloading Google Workspace CLI ${version} (darwin_${release_arch})" >&2
    curl -fsSL \
      "https://github.com/openclaw/gogcli/releases/download/v${version}/$(basename "$archive")" \
      -o "$archive"
    if ! printf '%s  %s\n' "$expected_sha256" "$archive" | shasum -a 256 -c - >/dev/null; then
      echo "ERROR: downloaded gog checksum mismatch: $archive" >&2
      rm -rf "$download_root"
      return 1
    fi

    mkdir -p "${download_root}/${release_arch}"
    tar -xzf "$archive" -C "${download_root}/${release_arch}"
    extracted_bin="${download_root}/${release_arch}/gog"
    if [[ ! -x "$extracted_bin" ]]; then
      echo "ERROR: downloaded gog archive is missing its executable: $archive" >&2
      rm -rf "$download_root"
      return 1
    fi

    expected_arch="$release_arch"
    if [[ "$expected_arch" == "amd64" ]]; then
      expected_arch="x86_64"
    fi
    extracted_archs="$(/usr/bin/lipo -archs "$extracted_bin" 2>/dev/null || true)"
    if [[ "$extracted_archs" != "$expected_arch" ]]; then
      echo "ERROR: downloaded gog architecture mismatch for darwin_${release_arch}: ${extracted_archs:-unknown}." >&2
      rm -rf "$download_root"
      return 1
    fi

    packaged_bin="${cache_root}/gog/darwin-${expected_arch}/gog"
    mkdir -p "$(dirname "$packaged_bin")"
    cp "$extracted_bin" "$packaged_bin"
    chmod 0755 "$packaged_bin"
    if ! openclaw_verify_vendor_signed_gog "$packaged_bin"; then
      echo "ERROR: downloaded Gog does not match the reviewed vendor signing identity." >&2
      rm -rf "$download_root" "$cache_root"
      return 1
    fi
  done

  mkdir -p "$cache_root"
  if [[ ! -s "${download_root}/arm64/LICENSE" ]]; then
    echo "ERROR: pinned Gog release archive is missing its MIT license notice." >&2
    rm -rf "$download_root" "$cache_root"
    return 1
  fi
  cp "${download_root}/arm64/LICENSE" "$license_path"
  rm -rf "$download_root"

  # Execute only the host slice. Thin cross-architecture execution would
  # require Rosetta on arm64 and cannot run on an Intel release host.
  host_arch="$(uname -m)"
  case "$host_arch" in
    arm64)
      host_bin="$arm64_bin"
      ;;
    x86_64)
      host_bin="$x86_64_bin"
      ;;
    *)
      echo "ERROR: unsupported macOS architecture for Gog packaging: $host_arch" >&2
      return 1
      ;;
  esac
  if [[ "$("$host_bin" --version 2>/dev/null || true)" != *"v${version}"* ]]; then
    echo "ERROR: vendor-signed Gog payload does not report expected version v${version}." >&2
    return 1
  fi

  printf '%s\n' "$cache_root"
}
