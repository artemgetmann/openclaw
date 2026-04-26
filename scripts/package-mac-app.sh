#!/usr/bin/env bash
set -euo pipefail

# Build and bundle OpenClaw into a minimal .app we can open.
# Outputs to dist/OpenClaw.app by default, or a custom bundle name when requested.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/validated-node.sh"
openclaw_use_validated_node "$ROOT_DIR" >/dev/null
VALIDATED_NODE_BIN="$OPENCLAW_NODE_BIN"
APP_NAME="${APP_NAME:-OpenClaw Consumer}"
APP_BUNDLE_NAME="${APP_BUNDLE_NAME:-${APP_NAME}.app}"
APP_ROOT="$ROOT_DIR/dist/${APP_BUNDLE_NAME}"
BUILD_ROOT="$ROOT_DIR/apps/macos/.build"
PRODUCT="OpenClaw"
BUNDLE_ID="${BUNDLE_ID:-ai.openclaw.consumer.mac.debug}"
APP_VARIANT="${APP_VARIANT:-consumer}"
APP_INSTANCE_ID="${APP_INSTANCE_ID:-}"
URL_SCHEME="${URL_SCHEME:-openclaw-consumer}"
if [[ "$APP_VARIANT" == "consumer" ]]; then
  export OPENCLAW_IMAGE_BACKEND="${OPENCLAW_IMAGE_BACKEND:-sips}"
fi
PKG_VERSION="$(cd "$ROOT_DIR" && "$VALIDATED_NODE_BIN" -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")"
BUILD_TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
GIT_COMMIT=$(cd "$ROOT_DIR" && git rev-parse --short HEAD 2>/dev/null || echo "unknown")
GIT_BUILD_NUMBER=$(cd "$ROOT_DIR" && git rev-list --count HEAD 2>/dev/null || echo "0")
APP_VERSION="${APP_VERSION:-$PKG_VERSION}"
APP_BUILD="${APP_BUILD:-}"
BUILD_CONFIG="${BUILD_CONFIG:-debug}"
if [[ -n "${BUILD_ARCHS:-}" ]]; then
  BUILD_ARCHS_VALUE="${BUILD_ARCHS}"
elif [[ "$BUILD_CONFIG" == "release" ]]; then
  # Release packaging should be universal unless explicitly overridden.
  BUILD_ARCHS_VALUE="all"
else
  BUILD_ARCHS_VALUE="$(uname -m)"
fi
if [[ "${BUILD_ARCHS_VALUE}" == "all" ]]; then
  BUILD_ARCHS_VALUE="arm64 x86_64"
fi
IFS=' ' read -r -a BUILD_ARCHS <<< "$BUILD_ARCHS_VALUE"
PRIMARY_ARCH="${BUILD_ARCHS[0]}"
ALLOW_SINGLE_ARCH_CONSUMER_SMOKE="${ALLOW_SINGLE_ARCH_CONSUMER_SMOKE:-0}"
SPARKLE_PUBLIC_ED_KEY="${SPARKLE_PUBLIC_ED_KEY:-AGCY8w5vHirVfGGDGc8Szc5iuOqupZSh9pMj/Qs67XI=}"
DEFAULT_STANDARD_SPARKLE_FEED_URL="https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml"
BUNDLED_CLI_ARCHIVE_NAME="openclaw-cli-bundle.tgz"
BUNDLED_RUNTIME_RESOURCE_DIR="$APP_ROOT/Contents/Resources/OpenClawRuntime"
UV_VERSION="${UV_VERSION:-0.9.21}"
VALIDATED_NPM_BIN="$(dirname "$VALIDATED_NODE_BIN")/npm"
if [[ ! -x "$VALIDATED_NPM_BIN" ]]; then
  VALIDATED_NPM_BIN="$(command -v npm || true)"
fi
CLI_ARCHIVE_STAGED=""
CLI_ARCHIVE_STAGE_DIR=""
OPENCLAW_CONSUMER_FAST_PACKAGING="${OPENCLAW_CONSUMER_FAST_PACKAGING:-0}"
PACKAGE_TIMING="${PACKAGE_TIMING:-0}"
BUNDLED_RUNTIME_CACHE_ROOT="${OPENCLAW_CONSUMER_RUNTIME_CACHE_ROOT:-$ROOT_DIR/.cache/consumer-runtime-packages}"
CONSUMER_REQUIRED_WORKSPACE_TEMPLATES=(
  "AGENTS.md"
  "SOUL.md"
  "TOOLS.md"
  "IDENTITY.md"
  "USER.md"
  "HEARTBEAT.md"
  "BOOTSTRAP.md"
  "MEMORY.md"
)

consumer_packaging_env_candidates() {
  # Keep secrets machine-local: explicit override first, then the consumer-home
  # shared file, then the optional fallback outside the worktree.
  if [[ -n "${OPENCLAW_CONSUMER_ENV_FILE:-}" ]]; then
    printf '%s\n' "$OPENCLAW_CONSUMER_ENV_FILE"
  fi
  printf '%s\n' "$HOME/Programming_Projects/openclaw-consumer/.config/consumer-packaging.env"
  printf '%s\n' "$HOME/.config/openclaw/consumer-packaging.env"
}

load_consumer_packaging_env() {
  if [[ "$APP_VARIANT" != "consumer" ]]; then
    return 0
  fi

  # Existing exports win so callers can override local packaging state without
  # touching the shared env file.
  if [[ -n "${OPENCLAW_CONSUMER_OPENAI_API_KEY:-}" && -n "${OPENCLAW_CONSUMER_GEMINI_API_KEY:-}" ]]; then
    return 0
  fi

  local env_file=""
  local loaded_env_file=""
  local explicit_env_file="${OPENCLAW_CONSUMER_ENV_FILE:-}"

  while IFS= read -r env_file; do
    [[ -n "$env_file" ]] || continue
    if [[ -r "$env_file" ]]; then
      echo "📦 Loading consumer packaging env from $env_file"
      set -a
      # shellcheck disable=SC1090
      source "$env_file"
      set +a
      if [[ -n "${OPENCLAW_CONSUMER_OPENAI_API_KEY:-}" && -n "${OPENCLAW_CONSUMER_GEMINI_API_KEY:-}" ]]; then
        loaded_env_file="$env_file"
        break
      fi
    elif [[ -n "$explicit_env_file" && "$env_file" == "$explicit_env_file" ]]; then
      echo "WARN: OPENCLAW_CONSUMER_ENV_FILE is set but not readable: $env_file" >&2
    fi
  done < <(consumer_packaging_env_candidates)

  if [[ -z "${OPENCLAW_CONSUMER_OPENAI_API_KEY:-}" || -z "${OPENCLAW_CONSUMER_GEMINI_API_KEY:-}" ]]; then
    echo "ERROR: consumer packaging requires both OPENCLAW_CONSUMER_OPENAI_API_KEY and OPENCLAW_CONSUMER_GEMINI_API_KEY." >&2
    if [[ -n "$loaded_env_file" ]]; then
      echo "Loaded env file: $loaded_env_file" >&2
    fi
    echo "Checked, in order:" >&2
    if [[ -n "$explicit_env_file" ]]; then
      echo "  - $explicit_env_file" >&2
    fi
    echo "  - $HOME/Programming_Projects/openclaw-consumer/.config/consumer-packaging.env" >&2
    echo "  - $HOME/.config/openclaw/consumer-packaging.env" >&2
    echo "Export both consumer keys or create one of those env files before packaging." >&2
    exit 1
  fi
}

consumer_build_archs_are_universal() {
  case "$BUILD_ARCHS_VALUE" in
    all|"arm64 x86_64"|"x86_64 arm64")
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

phase_now_ms() {
  "$VALIDATED_NODE_BIN" -e 'process.stdout.write(String(Date.now()))'
}

phase_log_elapsed() {
  local started_ms="$1"
  local label="$2"
  local finished_ms
  local elapsed_ms

  if [[ "$PACKAGE_TIMING" != "1" ]]; then
    return 0
  fi

  finished_ms="$(phase_now_ms)"
  elapsed_ms=$((finished_ms - started_ms))
  printf '⏱  %s: %d.%03ds\n' "$label" "$((elapsed_ms / 1000))" "$((elapsed_ms % 1000))" >&2
}

if [[ "$APP_VARIANT" == "consumer" && "$ALLOW_SINGLE_ARCH_CONSUMER_SMOKE" != "1" ]]; then
  if ! consumer_build_archs_are_universal; then
    echo "ERROR: consumer packaging must cover Intel and Apple Silicon." >&2
    echo "Use BUILD_ARCHS=all for shipping consumer builds." >&2
    echo "Set ALLOW_SINGLE_ARCH_CONSUMER_SMOKE=1 only for local single-arch smoke/debug packaging." >&2
    exit 1
  fi
fi

load_consumer_packaging_env

consumer_require_bundled_speech_key() {
  if [[ "$APP_VARIANT" != "consumer" ]]; then
    return 0
  fi

  # Fail before the expensive build when the dedicated speech key is missing.
  # Consumer packaging used to fall back to generic founder OPENAI_API_KEY
  # values, which could produce a "voice-ready" bundle that still failed on the
  # first transcription request because the wrong key got embedded.
  local seeded_tmp
  seeded_tmp="$(mktemp)"
  "$VALIDATED_NODE_BIN" "$ROOT_DIR/scripts/generate-consumer-seeded-defaults.mjs" "$seeded_tmp"
  if ! grep -q '"OPENCLAW_CONSUMER_OPENAI_API_KEY"' "$seeded_tmp"; then
    rm -f "$seeded_tmp"
    echo "ERROR: consumer bundle is missing OPENCLAW_CONSUMER_OPENAI_API_KEY." >&2
    echo "Packaging must use the dedicated consumer speech-transcription key; generic OPENAI_API_KEY fallback is intentionally not accepted." >&2
    echo "Set OPENCLAW_CONSUMER_OPENAI_API_KEY before packaging, or ship without bundled voice and rely on the blocked readiness/setup path explicitly." >&2
    exit 1
  fi
  rm -f "$seeded_tmp"
}

consumer_require_bundled_speech_key

consumer_require_bundled_gemini_key() {
  if [[ "$APP_VARIANT" != "consumer" ]]; then
    return 0
  fi

  # Default-enabling nano-banana-pro means packaging must fail closed when the
  # dedicated consumer Gemini key is missing instead of shipping a starter skill
  # that is broken on first use.
  local seeded_tmp
  seeded_tmp="$(mktemp)"
  "$VALIDATED_NODE_BIN" "$ROOT_DIR/scripts/generate-consumer-seeded-defaults.mjs" "$seeded_tmp"
  if ! grep -q '"OPENCLAW_CONSUMER_GEMINI_API_KEY"' "$seeded_tmp"; then
    rm -f "$seeded_tmp"
    echo "ERROR: consumer bundle is missing OPENCLAW_CONSUMER_GEMINI_API_KEY." >&2
    echo "Packaging must use the dedicated consumer Gemini key before nano-banana-pro can ship by default." >&2
    exit 1
  fi
  rm -f "$seeded_tmp"
}

consumer_require_bundled_gemini_key

verify_required_workspace_templates() {
  local template_dir="$1"
  local context_label="$2"
  local missing=()
  local template_name=""

  if [[ ! -d "$template_dir" ]]; then
    echo "ERROR: ${context_label} directory missing: $template_dir" >&2
    return 1
  fi

  # Consumer packaging must ship the full bootstrap template set because the
  # packaged JS helper resolves from docs/reference/templates under its own
  # package root after install. A partial copy creates a runtime that looks
  # healthy but fails on the first real workspace bootstrap.
  for template_name in "${CONSUMER_REQUIRED_WORKSPACE_TEMPLATES[@]}"; do
    if [[ ! -f "$template_dir/$template_name" ]]; then
      missing+=("$template_name")
    fi
  done

  if [[ "${#missing[@]}" -gt 0 ]]; then
    echo "ERROR: ${context_label} is missing required workspace templates." >&2
    printf '  %s\n' "${missing[@]}" >&2
    echo "Expected directory: $template_dir" >&2
    return 1
  fi
}

default_sparkle_feed_url_for_bundle() {
  local bundle_id="$1"
  case "$bundle_id" in
    ai.openclaw.mac|ai.openclaw.mac.*)
      printf '%s' "$DEFAULT_STANDARD_SPARKLE_FEED_URL"
      ;;
    *)
      # Consumer builds must opt into a consumer-owned feed explicitly.
      # Falling back to the founder/upstream appcast would make the updater
      # fetch the wrong artifact line for a different product identity.
      printf ''
      ;;
  esac
}

if [[ -v SPARKLE_FEED_URL ]]; then
  SPARKLE_FEED_URL="${SPARKLE_FEED_URL}"
else
  SPARKLE_FEED_URL="$(default_sparkle_feed_url_for_bundle "$BUNDLE_ID")"
fi

if [[ "$BUNDLE_ID" == ai.openclaw.consumer.mac* && "$SPARKLE_FEED_URL" == "$DEFAULT_STANDARD_SPARKLE_FEED_URL" ]]; then
  echo "ERROR: consumer bundle ids must not point at the generic OpenClaw appcast." >&2
  echo "Set SPARKLE_FEED_URL to a consumer-owned feed or leave it blank to keep updates disabled." >&2
  exit 1
fi

AUTO_CHECKS=true
if [[ "$BUNDLE_ID" == *.debug || -z "$SPARKLE_FEED_URL" ]]; then
  AUTO_CHECKS=false
fi

sparkle_canonical_build_from_version() {
  "$VALIDATED_NODE_BIN" --import tsx "$ROOT_DIR/scripts/sparkle-build.ts" canonical-build "$1"
}

build_path_for_arch() {
  echo "$BUILD_ROOT/$1"
}

bin_for_arch() {
  echo "$(build_path_for_arch "$1")/$BUILD_CONFIG/$PRODUCT"
}

sparkle_framework_for_arch() {
  echo "$(build_path_for_arch "$1")/$BUILD_CONFIG/Sparkle.framework"
}

merge_framework_machos() {
  local primary="$1"
  local dest="$2"
  shift 2
  local others=("$@")

  archs_for() {
    /usr/bin/lipo -info "$1" | /usr/bin/sed -E 's/.*are: //; s/.*architecture: //'
  }

  arch_in_list() {
    local needle="$1"
    shift
    for item in "$@"; do
      if [[ "$item" == "$needle" ]]; then
        return 0
      fi
    done
    return 1
  }

  while IFS= read -r -d '' file; do
    if /usr/bin/file "$file" | /usr/bin/grep -q "Mach-O"; then
      local rel="${file#$primary/}"
      local primary_archs
      primary_archs=$(archs_for "$file")
      IFS=' ' read -r -a primary_arch_array <<< "$primary_archs"

      local missing_files=()
      local tmp_dir
      tmp_dir=$(mktemp -d)
      for fw in "${others[@]}"; do
        local other_file="$fw/$rel"
        if [[ ! -f "$other_file" ]]; then
          echo "ERROR: Missing $rel in $fw" >&2
          rm -rf "$tmp_dir"
          exit 1
        fi
        if /usr/bin/file "$other_file" | /usr/bin/grep -q "Mach-O"; then
          local other_archs
          other_archs=$(archs_for "$other_file")
          IFS=' ' read -r -a other_arch_array <<< "$other_archs"
          for arch in "${other_arch_array[@]}"; do
            if ! arch_in_list "$arch" "${primary_arch_array[@]}"; then
              local thin_file="$tmp_dir/$(echo "$rel" | tr '/' '_')-$arch"
              /usr/bin/lipo -thin "$arch" "$other_file" -output "$thin_file"
              missing_files+=("$thin_file")
              primary_arch_array+=("$arch")
            fi
          done
        fi
      done

      if [[ "${#missing_files[@]}" -gt 0 ]]; then
        /usr/bin/lipo -create "$file" "${missing_files[@]}" -output "$dest/$rel"
      fi
      rm -rf "$tmp_dir"
    fi
  done < <(find "$primary" -type f -print0)
}

bundle_consumer_cli_archive() {
  if [[ "$APP_VARIANT" != "consumer" ]]; then
    return 0
  fi
  if [[ -z "$VALIDATED_NPM_BIN" || ! -x "$VALIDATED_NPM_BIN" ]]; then
    echo "ERROR: npm is required to bundle the consumer CLI archive." >&2
    exit 1
  fi

  # Stage the CLI archive outside repo `dist/` before we create the `.app`.
  # Otherwise `npm pack` sees the partially-built app bundle under `dist/` and
  # packs that into the CLI tarball, which bloats the archive and can leave the
  # packaging flow in a stale half-finished state.
  local pack_dir
  pack_dir="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-cli-pack.XXXXXX")"
  local archive_src=""
  rm -f "$pack_dir"/*.tgz 2>/dev/null || true
  echo "📦 Bundling consumer CLI archive"
  (
    cd "$ROOT_DIR"
    "$VALIDATED_NPM_BIN" pack --ignore-scripts --pack-destination "$pack_dir" >/dev/null
  )
  archive_src="$(find "$pack_dir" -maxdepth 1 -type f -name 'openclaw-*.tgz' -print -quit)"
  if [[ -z "$archive_src" || ! -f "$archive_src" ]]; then
    echo "ERROR: expected bundled CLI archive missing in staging dir: $pack_dir" >&2
    exit 1
  fi
  CLI_ARCHIVE_STAGED="$pack_dir/$BUNDLED_CLI_ARCHIVE_NAME"
  CLI_ARCHIVE_STAGE_DIR="$pack_dir"
  mv "$archive_src" "$CLI_ARCHIVE_STAGED"
}

ensure_consumer_node_runtime() {
  local version="$1"
  local arch="$2"
  local cache_root="${ROOT_DIR}/.cache/consumer-runtime/node-v${version}-${arch}"
  local download_root=""
  local archive=""
  local download_url=""
  local extracted_root=""

  if [[ -x "${cache_root}/bin/node" ]]; then
    printf '%s\n' "$cache_root"
    return 0
  fi

  download_root="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-consumer-node.XXXXXX")"
  archive="${download_root}/node-v${version}-${arch}.tar.gz"
  download_url="https://nodejs.org/dist/v${version}/node-v${version}-${arch}.tar.gz"

  echo "📥 Downloading Node ${version} (${arch}) for bundled consumer runtime" >&2
  curl -fsSL "$download_url" -o "$archive"
  tar -xzf "$archive" -C "$download_root"
  extracted_root="${download_root}/node-v${version}-${arch}"

  if [[ ! -x "${extracted_root}/bin/node" ]]; then
    echo "ERROR: downloaded Node runtime is missing bin/node: ${download_url}" >&2
    rm -rf "$download_root"
    exit 1
  fi

  local actual_version
  actual_version="$("${extracted_root}/bin/node" -p "process.versions.node" 2>/dev/null | tr -d '\r')"
  if [[ "$actual_version" != "$version" ]]; then
    echo "ERROR: downloaded Node runtime version mismatch for ${arch}. expected=${version} actual=${actual_version:-unknown}" >&2
    rm -rf "$download_root"
    exit 1
  fi

  rm -rf "$cache_root"
  mkdir -p "$(dirname "$cache_root")"
  mv "$extracted_root" "$cache_root"
  rm -rf "$download_root"
  printf '%s\n' "$cache_root"
}

ensure_consumer_uv_runtime() {
  local version="$1"
  local arch="$2"
  local cache_root="${ROOT_DIR}/.cache/consumer-runtime/uv-v${version}-${arch}"
  local download_root=""
  local archive=""
  local download_url=""
  local extracted_root=""
  local release_arch=""

  if [[ -x "${cache_root}/bin/uv" ]]; then
    local cached_version
    cached_version="$("${cache_root}/bin/uv" --version 2>/dev/null | awk '{print $2}' | tr -d '\r')"
    if [[ "$cached_version" == "$version" ]]; then
      printf '%s\n' "$cache_root"
      return 0
    fi
  fi

  case "$arch" in
    arm64)
      release_arch="aarch64"
      ;;
    x86_64)
      release_arch="x86_64"
      ;;
    *)
      echo "ERROR: unsupported architecture for bundled uv runtime: $arch" >&2
      exit 1
      ;;
  esac

  download_root="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-consumer-uv.XXXXXX")"
  archive="${download_root}/uv-${release_arch}-apple-darwin.tar.gz"
  download_url="https://github.com/astral-sh/uv/releases/download/${version}/uv-${release_arch}-apple-darwin.tar.gz"

  echo "📥 Downloading uv ${version} (${arch}) for bundled consumer runtime" >&2
  curl -fsSL "$download_url" -o "$archive"
  tar -xzf "$archive" -C "$download_root"
  extracted_root="${download_root}/uv-${release_arch}-apple-darwin"

  if [[ ! -x "${extracted_root}/uv" ]]; then
    echo "ERROR: downloaded uv runtime is missing uv: ${download_url}" >&2
    rm -rf "$download_root"
    exit 1
  fi

  local actual_version
  actual_version="$("${extracted_root}/uv" --version 2>/dev/null | awk '{print $2}' | tr -d '\r')"
  if [[ "$actual_version" != "$version" ]]; then
    echo "ERROR: downloaded uv runtime version mismatch for ${arch}. expected=${version} actual=${actual_version:-unknown}" >&2
    rm -rf "$download_root"
    exit 1
  fi

  rm -rf "$cache_root"
  mkdir -p "$cache_root/bin"
  cp "${extracted_root}/uv" "${cache_root}/bin/uv"
  chmod +x "${cache_root}/bin/uv"
  rm -rf "$download_root"
  printf '%s\n' "$cache_root"
}

resolve_matrix_crypto_package_root() {
  local package_root=""

  # pnpm can hoist the Matrix package, so resolve the installed package path
  # instead of assuming a flat repo-local node_modules layout.
  package_root="$(
    "$VALIDATED_NODE_BIN" -e '
      const path = require("node:path");
      const { createRequire } = require("node:module");
      const req = createRequire(process.argv[1]);
      try {
        const downloadLib = req.resolve("@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js");
        process.stdout.write(path.dirname(downloadLib));
      } catch (err) {
        process.stderr.write(
          `Failed to resolve @matrix-org/matrix-sdk-crypto-nodejs package root: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
        process.exit(1);
      }
    ' "$ROOT_DIR/package.json"
  )"

  printf '%s\n' "$package_root"
}

stage_consumer_matrix_crypto_x64_twin() {
  if [[ "$APP_VARIANT" != "consumer" ]]; then
    return 0
  fi
  if ! printf '%s\n' "${BUILD_ARCHS[@]}" | grep -qx "x86_64"; then
    return 0
  fi

  local matrix_package_root=""
  local bundled_runtime_root="${BUNDLED_RUNTIME_RESOURCE_DIR}/openclaw"
  local bundled_runtime_dist_root="${bundled_runtime_root}/dist"
  local matrix_crypto_x64_source=""
  local arm64_native=""
  local x64_target=""

  matrix_package_root="$(resolve_matrix_crypto_package_root)"
  matrix_crypto_x64_source="${matrix_package_root}/matrix-sdk-crypto.darwin-x64.node"
  if [[ ! -f "$matrix_crypto_x64_source" ]]; then
    local downloader_script="${matrix_package_root}/download-lib.js"
    if [[ ! -f "$downloader_script" ]]; then
      echo "ERROR: Matrix crypto x64 source missing and downloader helper not found." >&2
      exit 1
    fi
    echo "📦 Staging bundled consumer Matrix crypto x64 twin"
    npm_config_target_arch=x64 \
      npm_config_arch=x64 \
      "$VALIDATED_NODE_BIN" "$downloader_script" >/dev/null
  fi

  if [[ ! -f "$matrix_crypto_x64_source" ]]; then
    echo "ERROR: bundled consumer Matrix crypto x64 staging did not produce the expected native addon:" >&2
    echo "  $matrix_crypto_x64_source" >&2
    exit 1
  fi

  while IFS= read -r arm64_native; do
    [[ -n "$arm64_native" ]] || continue
    x64_target="${arm64_native/darwin-arm64/darwin-x64}"
    if [[ -f "$x64_target" ]]; then
      continue
    fi
    mkdir -p "$(dirname "$x64_target")"
    cp "$matrix_crypto_x64_source" "$x64_target"
  done < <(find "$bundled_runtime_dist_root" -type f -name '*.node' | grep 'darwin-arm64' || true)
}

materialize_bundled_extension_node_modules() {
  if [[ "$APP_VARIANT" != "consumer" ]]; then
    return 0
  fi

  local extension_dir=""
  local extension_name=""
  local source_node_modules=""
  local dest_node_modules=""

  # `cp -R` preserves the symlink forest emitted by pnpm, but the packaged app
  # must be self-contained. Rehydrate each extension's production dependencies
  # from the source checkout so the bundle does not retain broken links back to
  # the developer worktree's `.pnpm` store.
  while IFS= read -r -d '' extension_dir; do
    extension_name="$(basename "$extension_dir")"
    source_node_modules="$ROOT_DIR/extensions/$extension_name/node_modules"
    if [[ ! -d "$source_node_modules" ]]; then
      continue
    fi

    dest_node_modules="$BUNDLED_RUNTIME_RESOURCE_DIR/openclaw/extensions/$extension_name/node_modules"
    rm -rf "$dest_node_modules"
    mkdir -p "$(dirname "$dest_node_modules")"
    rsync -aL "$source_node_modules/" "$dest_node_modules/"
  done < <(find "$BUNDLED_RUNTIME_RESOURCE_DIR/openclaw/extensions" -mindepth 1 -maxdepth 1 -type d -print0)
}

consumer_runtime_cache_key() {
  local node_version=""
  node_version="$(openclaw_validated_node_version "$ROOT_DIR")"

  # The fast local smoke cache is only for already-built runtime payloads.
  # Key it off the packaged runtime inputs, not unrelated source files, so we
  # reuse safely when the staged JS/assets/templates are unchanged.
  (
    cd "$ROOT_DIR"
    {
      printf '%s\n' "$GIT_COMMIT"
      printf '%s\n' "$node_version"
      printf '%s\n' "$UV_VERSION"
      printf '%s\n' "$BUILD_ARCHS_VALUE"
      git status --porcelain -- \
        dist \
        openclaw.mjs \
        package.json \
        pnpm-lock.yaml \
        scripts/generate-consumer-seeded-defaults.mjs \
        extensions \
        skills \
        docs/reference/templates \
        apps/macos/Sources/OpenClaw/Resources/DeviceModels
    } | shasum -a 256 | awk '{print $1}'
  )
}

prepare_bundled_consumer_runtime() {
  if [[ "$APP_VARIANT" != "consumer" ]]; then
    return 0
  fi

  local manifest_path="${BUNDLED_RUNTIME_RESOURCE_DIR}/manifest.json"
  local cache_key=""
  local cache_root=""
  local cache_templates_dir=""
  local node_version=""
  local node_arm64_root=""
  local node_x64_root=""
  local uv_arm64_root=""
  local uv_x64_root=""
  local deploy_root=""

  node_version="$(openclaw_validated_node_version "$ROOT_DIR")"
  cache_key="$(consumer_runtime_cache_key)"
  cache_root="${BUNDLED_RUNTIME_CACHE_ROOT}/${cache_key}"
  cache_templates_dir="${cache_root}/openclaw/docs/reference/templates"

  if [[ "$OPENCLAW_CONSUMER_FAST_PACKAGING" == "1" && -d "$cache_root" && -f "$cache_root/manifest.json" ]]; then
    if verify_required_workspace_templates "$cache_templates_dir" "cached bundled consumer runtime workspace templates"; then
      echo "📦 Reusing cached bundled consumer runtime"
      rm -rf "$BUNDLED_RUNTIME_RESOURCE_DIR"
      mkdir -p "$(dirname "$BUNDLED_RUNTIME_RESOURCE_DIR")"
      rsync -a "$cache_root/" "$BUNDLED_RUNTIME_RESOURCE_DIR/"
      return 0
    fi

    echo "📦 Cached bundled runtime is incomplete; rebuilding it"
    rm -rf "$cache_root"
  fi

  echo "📦 Staging bundled consumer runtime"
  rm -rf "$BUNDLED_RUNTIME_RESOURCE_DIR"
  mkdir -p "$BUNDLED_RUNTIME_RESOURCE_DIR/openclaw"
  mkdir -p "$BUNDLED_RUNTIME_RESOURCE_DIR/node"
  mkdir -p "$BUNDLED_RUNTIME_RESOURCE_DIR/uv"

  cp "$ROOT_DIR/openclaw.mjs" "$BUNDLED_RUNTIME_RESOURCE_DIR/openclaw/openclaw.mjs"
  cp "$ROOT_DIR/package.json" "$BUNDLED_RUNTIME_RESOURCE_DIR/openclaw/package.json"
  rm -rf "$BUNDLED_RUNTIME_RESOURCE_DIR/openclaw/dist"
  mkdir -p "$BUNDLED_RUNTIME_RESOURCE_DIR/openclaw/dist"
  rsync -a \
    --exclude '*.app' \
    "$ROOT_DIR/dist/" "$BUNDLED_RUNTIME_RESOURCE_DIR/openclaw/dist/"

  deploy_root="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-consumer-deploy.XXXXXX")"
  trap 'rm -rf "$deploy_root"' RETURN
  echo "📦 Staging bundled consumer runtime node_modules"
  openclaw_run_repo_pnpm "$ROOT_DIR" --filter . deploy --legacy --prod "$deploy_root"
  rm -rf "$BUNDLED_RUNTIME_RESOURCE_DIR/openclaw/node_modules"
  mkdir -p "$BUNDLED_RUNTIME_RESOURCE_DIR/openclaw"
  rsync -a "$deploy_root/node_modules/" "$BUNDLED_RUNTIME_RESOURCE_DIR/openclaw/node_modules/"
  rm -rf "$deploy_root"
  trap - RETURN

  stage_consumer_matrix_crypto_x64_twin

  if printf '%s\n' "${BUILD_ARCHS[@]}" | grep -qx "x86_64"; then
    local arm64_native=""
    local bundled_runtime_dist_root="${BUNDLED_RUNTIME_RESOURCE_DIR}/openclaw/dist"
    local matrix_crypto_universal="${bundled_runtime_dist_root}/matrix-sdk-crypto.darwin-universal.node"
    while IFS= read -r arm64_native; do
      [[ -n "$arm64_native" ]] || continue
      if [[ "$(basename "$arm64_native")" == matrix-sdk-crypto.darwin-arm64-* ]] && [[ -f "$matrix_crypto_universal" ]]; then
        continue
      fi
      local x64_native="${arm64_native/darwin-arm64/darwin-x64}"
      if [[ ! -f "$x64_native" ]]; then
        echo "ERROR: bundled consumer runtime includes arm64-only native addon with no x64 twin:" >&2
        echo "  $arm64_native" >&2
        echo "Expected sibling path:" >&2
        echo "  $x64_native" >&2
        echo "Fix the runtime asset coverage before shipping a universal consumer build." >&2
        exit 1
      fi
    done < <(find "$BUNDLED_RUNTIME_RESOURCE_DIR/openclaw/dist" -type f -name '*.node' | grep 'darwin-arm64' || true)
  fi

  rm -rf "$BUNDLED_RUNTIME_RESOURCE_DIR/openclaw/extensions"
  cp -R "$ROOT_DIR/extensions" "$BUNDLED_RUNTIME_RESOURCE_DIR/openclaw/extensions"
  materialize_bundled_extension_node_modules
  if [[ -d "$ROOT_DIR/skills" ]]; then
    rm -rf "$BUNDLED_RUNTIME_RESOURCE_DIR/openclaw/skills"
    cp -R "$ROOT_DIR/skills" "$BUNDLED_RUNTIME_RESOURCE_DIR/openclaw/skills"
  fi

  local bundled_template_src="$ROOT_DIR/docs/reference/templates"
  local bundled_template_dest="$BUNDLED_RUNTIME_RESOURCE_DIR/openclaw/docs/reference/templates"
  verify_required_workspace_templates "$bundled_template_src" "consumer workspace template source"
  rm -rf "$BUNDLED_RUNTIME_RESOURCE_DIR/openclaw/docs"
  mkdir -p "$(dirname "$bundled_template_dest")"
  cp -R "$bundled_template_src" "$bundled_template_dest"
  verify_required_workspace_templates "$bundled_template_dest" "bundled consumer runtime workspace templates"

  node_arm64_root="$(ensure_consumer_node_runtime "$node_version" "darwin-arm64")"
  node_x64_root="$(ensure_consumer_node_runtime "$node_version" "darwin-x64")"
  cp -R "$node_arm64_root" "$BUNDLED_RUNTIME_RESOURCE_DIR/node/darwin-arm64"
  cp -R "$node_x64_root" "$BUNDLED_RUNTIME_RESOURCE_DIR/node/darwin-x64"

  uv_arm64_root="$(ensure_consumer_uv_runtime "$UV_VERSION" "arm64")"
  uv_x64_root="$(ensure_consumer_uv_runtime "$UV_VERSION" "x86_64")"
  cp -R "$uv_arm64_root" "$BUNDLED_RUNTIME_RESOURCE_DIR/uv/darwin-arm64"
  cp -R "$uv_x64_root" "$BUNDLED_RUNTIME_RESOURCE_DIR/uv/darwin-x64"

  cat > "$manifest_path" <<EOF
{"format":1,"bundleVersion":"${APP_BUILD}","gitCommit":"${GIT_COMMIT}","nodeVersion":"${node_version}","uvVersion":"${UV_VERSION}"}
EOF

  if [[ "$OPENCLAW_CONSUMER_FAST_PACKAGING" == "1" ]]; then
    local cache_stage_root=""

    echo "📦 Caching bundled consumer runtime for the next smoke build"
    cache_stage_root="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-consumer-runtime-cache.XXXXXX")"
    rm -rf "$cache_root"
    rsync -a "$BUNDLED_RUNTIME_RESOURCE_DIR/" "$cache_stage_root/"
    mkdir -p "$(dirname "$cache_root")"
    mv "$cache_stage_root" "$cache_root"
  fi
}

prune_bundled_runtime_dangling_symlinks() {
  if [[ ! -d "$BUNDLED_RUNTIME_RESOURCE_DIR" ]]; then
    return 0
  fi

  # Some extension directories carry workspace/dev symlinks in node_modules
  # that do not survive bundle assembly. Drop only the broken links so outer
  # bundle verification does not fail on "No such file or directory".
  while IFS= read -r broken_link; do
    [[ -n "$broken_link" ]] || continue
    echo "🧹 Removing broken bundled-runtime symlink: $broken_link"
    rm -f "$broken_link"
  done < <(find "$BUNDLED_RUNTIME_RESOURCE_DIR" -type l ! -exec test -e {} \; -print)
}

if [[ "${SKIP_PNPM_INSTALL:-0}" != "1" ]]; then
  echo "📦 Ensuring deps (pnpm install)"
  pnpm_install_started_ms="$(phase_now_ms)"
  openclaw_run_repo_pnpm "$ROOT_DIR" install --no-frozen-lockfile --config.node-linker=hoisted
  phase_log_elapsed "$pnpm_install_started_ms" "Dependency install"
else
  echo "📦 Skipping dependency install (SKIP_PNPM_INSTALL=1)"
fi

if [[ -z "${APP_BUILD:-}" ]]; then
  APP_BUILD="$GIT_BUILD_NUMBER"
  if [[ "$APP_VERSION" =~ ^[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}([.-].*)?$ ]]; then
    CANONICAL_BUILD="$(sparkle_canonical_build_from_version "$APP_VERSION")" || {
      echo "ERROR: Failed to derive canonical Sparkle APP_BUILD from APP_VERSION '$APP_VERSION'." >&2
      exit 1
    }
    if [[ "$CANONICAL_BUILD" =~ ^[0-9]+$ ]] && (( CANONICAL_BUILD > APP_BUILD )); then
      APP_BUILD="$CANONICAL_BUILD"
    fi
  fi
fi

if [[ "$AUTO_CHECKS" == "true" && ! "$APP_BUILD" =~ ^[0-9]+$ ]]; then
  echo "ERROR: APP_BUILD must be numeric for Sparkle compare (CFBundleVersion). Got: $APP_BUILD" >&2
  exit 1
fi

if [[ "${SKIP_TSC:-0}" != "1" ]]; then
  echo "📦 Building JS (scripts/build-shared-runtime.sh)"
  js_build_started_ms="$(phase_now_ms)"
  (cd "$ROOT_DIR" && "${ROOT_DIR}/scripts/build-shared-runtime.sh")
  phase_log_elapsed "$js_build_started_ms" "JS/runtime build"
else
  echo "📦 Skipping JS build (SKIP_TSC=1)"
fi

if [[ "${SKIP_UI_BUILD:-0}" != "1" ]]; then
  echo "🖥  Building Control UI (ui:build)"
  ui_build_started_ms="$(phase_now_ms)"
  (cd "$ROOT_DIR" && "$VALIDATED_NODE_BIN" scripts/ui.js build)
  phase_log_elapsed "$ui_build_started_ms" "Control UI build"
else
  echo "🖥  Skipping Control UI build (SKIP_UI_BUILD=1)"
fi

cd "$ROOT_DIR/apps/macos"

echo "🔨 Building $PRODUCT ($BUILD_CONFIG) [${BUILD_ARCHS[*]}]"
swift_build_started_ms="$(phase_now_ms)"
for arch in "${BUILD_ARCHS[@]}"; do
  BUILD_PATH="$(build_path_for_arch "$arch")"
  swift build -c "$BUILD_CONFIG" --product "$PRODUCT" --build-path "$BUILD_PATH" --arch "$arch" -Xlinker -rpath -Xlinker @executable_path/../Frameworks
done
phase_log_elapsed "$swift_build_started_ms" "Swift app build"

BIN_PRIMARY="$(bin_for_arch "$PRIMARY_ARCH")"
echo "pkg: binary $BIN_PRIMARY" >&2
echo "🧹 Cleaning old app bundle"
rm -rf "$APP_ROOT"
if [[ "$APP_VARIANT" == "consumer" && "$OPENCLAW_CONSUMER_FAST_PACKAGING" == "1" ]]; then
  echo "📦 Skipping consumer CLI archive packaging (fast smoke path)"
else
  cli_archive_started_ms="$(phase_now_ms)"
  bundle_consumer_cli_archive
  phase_log_elapsed "$cli_archive_started_ms" "Consumer CLI archive packaging"
fi
mkdir -p "$APP_ROOT/Contents/MacOS"
mkdir -p "$APP_ROOT/Contents/Resources"
mkdir -p "$APP_ROOT/Contents/Frameworks"

echo "📄 Copying Info.plist template"
INFO_PLIST_SRC="$ROOT_DIR/apps/macos/Sources/OpenClaw/Resources/Info.plist"
if [ ! -f "$INFO_PLIST_SRC" ]; then
  echo "ERROR: Info.plist template missing at $INFO_PLIST_SRC" >&2
  exit 1
fi
cp "$INFO_PLIST_SRC" "$APP_ROOT/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier ${BUNDLE_ID}" "$APP_ROOT/Contents/Info.plist" || true
/usr/libexec/PlistBuddy -c "Set :CFBundleName ${APP_NAME}" "$APP_ROOT/Contents/Info.plist" || true
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName ${APP_NAME}" "$APP_ROOT/Contents/Info.plist" || true
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString ${APP_VERSION}" "$APP_ROOT/Contents/Info.plist" || true
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${APP_BUILD}" "$APP_ROOT/Contents/Info.plist" || true
/usr/libexec/PlistBuddy -c "Set :OpenClawAppVariant ${APP_VARIANT}" "$APP_ROOT/Contents/Info.plist" || true
/usr/libexec/PlistBuddy -c "Delete :OpenClawConsumerInstanceID" "$APP_ROOT/Contents/Info.plist" >/dev/null 2>&1 || true
if [[ "$APP_VARIANT" == "consumer" && -n "$APP_INSTANCE_ID" ]]; then
  /usr/libexec/PlistBuddy -c "Add :OpenClawConsumerInstanceID string ${APP_INSTANCE_ID}" "$APP_ROOT/Contents/Info.plist" || true
fi
/usr/libexec/PlistBuddy -c "Set :OpenClawBuildTimestamp ${BUILD_TS}" "$APP_ROOT/Contents/Info.plist" || true
/usr/libexec/PlistBuddy -c "Set :OpenClawGitCommit ${GIT_COMMIT}" "$APP_ROOT/Contents/Info.plist" || true
/usr/libexec/PlistBuddy -c "Set :CFBundleURLTypes:0:CFBundleURLSchemes:0 ${URL_SCHEME}" "$APP_ROOT/Contents/Info.plist" || true
/usr/libexec/PlistBuddy -c "Set :SUFeedURL ${SPARKLE_FEED_URL}" "$APP_ROOT/Contents/Info.plist" \
  || /usr/libexec/PlistBuddy -c "Add :SUFeedURL string ${SPARKLE_FEED_URL}" "$APP_ROOT/Contents/Info.plist" || true
/usr/libexec/PlistBuddy -c "Set :SUPublicEDKey ${SPARKLE_PUBLIC_ED_KEY}" "$APP_ROOT/Contents/Info.plist" \
  || /usr/libexec/PlistBuddy -c "Add :SUPublicEDKey string ${SPARKLE_PUBLIC_ED_KEY}" "$APP_ROOT/Contents/Info.plist" || true
if /usr/libexec/PlistBuddy -c "Set :SUEnableAutomaticChecks ${AUTO_CHECKS}" "$APP_ROOT/Contents/Info.plist"; then
  true
else
  /usr/libexec/PlistBuddy -c "Add :SUEnableAutomaticChecks bool ${AUTO_CHECKS}" "$APP_ROOT/Contents/Info.plist" || true
fi

echo "🚚 Copying binary"
cp "$BIN_PRIMARY" "$APP_ROOT/Contents/MacOS/OpenClaw"
if [[ "${#BUILD_ARCHS[@]}" -gt 1 ]]; then
  BIN_INPUTS=()
  for arch in "${BUILD_ARCHS[@]}"; do
    BIN_INPUTS+=("$(bin_for_arch "$arch")")
  done
  /usr/bin/lipo -create "${BIN_INPUTS[@]}" -output "$APP_ROOT/Contents/MacOS/OpenClaw"
fi
chmod +x "$APP_ROOT/Contents/MacOS/OpenClaw"
# SwiftPM outputs ad-hoc signed binaries; strip the signature before install_name_tool to avoid warnings.
/usr/bin/codesign --remove-signature "$APP_ROOT/Contents/MacOS/OpenClaw" 2>/dev/null || true

if [[ -n "$CLI_ARCHIVE_STAGED" && -f "$CLI_ARCHIVE_STAGED" ]]; then
  cp "$CLI_ARCHIVE_STAGED" "$APP_ROOT/Contents/Resources/$BUNDLED_CLI_ARCHIVE_NAME"
  rm -rf "$CLI_ARCHIVE_STAGE_DIR"
fi

SPARKLE_FRAMEWORK_PRIMARY="$(sparkle_framework_for_arch "$PRIMARY_ARCH")"
if [ -d "$SPARKLE_FRAMEWORK_PRIMARY" ]; then
  echo "✨ Embedding Sparkle.framework"
  cp -R "$SPARKLE_FRAMEWORK_PRIMARY" "$APP_ROOT/Contents/Frameworks/"
  if [[ "${#BUILD_ARCHS[@]}" -gt 1 ]]; then
    OTHER_FRAMEWORKS=()
    for arch in "${BUILD_ARCHS[@]}"; do
      if [[ "$arch" == "$PRIMARY_ARCH" ]]; then
        continue
      fi
      OTHER_FRAMEWORKS+=("$(sparkle_framework_for_arch "$arch")")
    done
    merge_framework_machos "$SPARKLE_FRAMEWORK_PRIMARY" "$APP_ROOT/Contents/Frameworks/Sparkle.framework" "${OTHER_FRAMEWORKS[@]}"
  fi
  chmod -R a+rX "$APP_ROOT/Contents/Frameworks/Sparkle.framework"
fi

echo "📦 Copying Swift 6.2 compatibility libraries"
SWIFT_COMPAT_LIB="$(xcode-select -p)/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-6.2/macosx/libswiftCompatibilitySpan.dylib"
if [ -f "$SWIFT_COMPAT_LIB" ]; then
  cp "$SWIFT_COMPAT_LIB" "$APP_ROOT/Contents/Frameworks/"
  chmod +x "$APP_ROOT/Contents/Frameworks/libswiftCompatibilitySpan.dylib"
else
  echo "WARN: Swift compatibility library not found at $SWIFT_COMPAT_LIB (continuing)" >&2
fi

echo "🖼  Copying app icon"
cp "$ROOT_DIR/apps/macos/Sources/OpenClaw/Resources/OpenClaw.icns" "$APP_ROOT/Contents/Resources/OpenClaw.icns"

echo "📦 Copying device model resources"
rm -rf "$APP_ROOT/Contents/Resources/DeviceModels"
cp -R "$ROOT_DIR/apps/macos/Sources/OpenClaw/Resources/DeviceModels" "$APP_ROOT/Contents/Resources/DeviceModels"

echo "📦 Copying consumer workspace templates"
TEMPLATE_SRC="$ROOT_DIR/docs/reference/templates"
TEMPLATE_DEST="$APP_ROOT/Contents/Resources/templates"
verify_required_workspace_templates "$TEMPLATE_SRC" "consumer workspace template source"
rm -rf "$TEMPLATE_DEST"
cp -R "$TEMPLATE_SRC" "$TEMPLATE_DEST"
verify_required_workspace_templates "$TEMPLATE_DEST" "packaged consumer app workspace templates"

if [[ "$APP_VARIANT" == "consumer" ]]; then
  echo "🔐 Seeding bundled consumer defaults"
  CONSUMER_SEEDED_DEFAULTS_PATH="$APP_ROOT/Contents/Resources/consumer-seeded-defaults.json"
  "$VALIDATED_NODE_BIN" "$ROOT_DIR/scripts/generate-consumer-seeded-defaults.mjs" \
    "$CONSUMER_SEEDED_DEFAULTS_PATH"
  if ! grep -q '"OPENCLAW_CONSUMER_OPENAI_API_KEY"' "$CONSUMER_SEEDED_DEFAULTS_PATH"; then
    echo "ERROR: consumer bundle is missing OPENCLAW_CONSUMER_OPENAI_API_KEY." >&2
    echo "Packaging must use the dedicated consumer speech-transcription key; generic OPENAI_API_KEY fallback is intentionally not accepted." >&2
    echo "Set OPENCLAW_CONSUMER_OPENAI_API_KEY before packaging, or ship without bundled voice and rely on the blocked readiness/setup path explicitly." >&2
    exit 1
  fi
  runtime_stage_started_ms="$(phase_now_ms)"
  prepare_bundled_consumer_runtime
  phase_log_elapsed "$runtime_stage_started_ms" "Bundled consumer runtime staging"
  prune_bundled_runtime_dangling_symlinks
fi

echo "📦 Copying model catalog"
MODEL_CATALOG_SRC="$ROOT_DIR/node_modules/@mariozechner/pi-ai/dist/models.generated.js"
MODEL_CATALOG_DEST="$APP_ROOT/Contents/Resources/models.generated.js"
if [ -f "$MODEL_CATALOG_SRC" ]; then
  cp "$MODEL_CATALOG_SRC" "$MODEL_CATALOG_DEST"
else
  echo "WARN: model catalog missing at $MODEL_CATALOG_SRC (continuing)" >&2
fi

echo "📦 Copying OpenClawKit resources"
OPENCLAWKIT_BUNDLE="$(build_path_for_arch "$PRIMARY_ARCH")/$BUILD_CONFIG/OpenClawKit_OpenClawKit.bundle"
if [ -d "$OPENCLAWKIT_BUNDLE" ]; then
  rm -rf "$APP_ROOT/Contents/Resources/OpenClawKit_OpenClawKit.bundle"
  cp -R "$OPENCLAWKIT_BUNDLE" "$APP_ROOT/Contents/Resources/OpenClawKit_OpenClawKit.bundle"
else
  echo "WARN: OpenClawKit resource bundle not found at $OPENCLAWKIT_BUNDLE (continuing)" >&2
fi

echo "📦 Copying Textual resources"
TEXTUAL_BUNDLE_DIR="$(build_path_for_arch "$PRIMARY_ARCH")/$BUILD_CONFIG"
TEXTUAL_BUNDLE=""
for candidate in \
  "$TEXTUAL_BUNDLE_DIR/textual_Textual.bundle" \
  "$TEXTUAL_BUNDLE_DIR/Textual_Textual.bundle"
do
  if [ -d "$candidate" ]; then
    TEXTUAL_BUNDLE="$candidate"
    break
  fi
done
if [ -z "$TEXTUAL_BUNDLE" ]; then
  TEXTUAL_BUNDLE="$(find "$BUILD_ROOT" -type d \( -name "textual_Textual.bundle" -o -name "Textual_Textual.bundle" \) -print -quit)"
fi
if [ -n "$TEXTUAL_BUNDLE" ] && [ -d "$TEXTUAL_BUNDLE" ]; then
  rm -rf "$APP_ROOT/Contents/Resources/$(basename "$TEXTUAL_BUNDLE")"
  cp -R "$TEXTUAL_BUNDLE" "$APP_ROOT/Contents/Resources/"
else
  if [[ "${ALLOW_MISSING_TEXTUAL_BUNDLE:-0}" == "1" ]]; then
    echo "WARN: Textual resource bundle not found (continuing due to ALLOW_MISSING_TEXTUAL_BUNDLE=1)" >&2
  else
    echo "ERROR: Textual resource bundle not found. Set ALLOW_MISSING_TEXTUAL_BUNDLE=1 to bypass." >&2
    exit 1
  fi
fi

echo "🔏 Signing bundle (auto-selects signing identity if SIGN_IDENTITY is unset)"
codesign_started_ms="$(phase_now_ms)"
"$ROOT_DIR/scripts/codesign-mac-app.sh" "$APP_ROOT"
phase_log_elapsed "$codesign_started_ms" "Codesign"

echo "✅ Bundle ready at $APP_ROOT"
