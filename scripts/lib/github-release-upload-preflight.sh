#!/usr/bin/env bash

# Guard GitHub release uploads against slow VPN/tunnel routes. Jarvis release
# assets are large enough that a bad route can waste an operator run for an
# hour before `gh release upload` makes useful progress.

github_release_upload_preflight_hosts() {
  printf '%s\n' github.com api.github.com uploads.github.com
}

github_release_upload_route_interface() {
  local host="$1"
  local output=""

  if [[ -n "${OPENCLAW_GITHUB_UPLOAD_PREFLIGHT_ROUTE_STUB:-}" ]]; then
    output="$("$OPENCLAW_GITHUB_UPLOAD_PREFLIGHT_ROUTE_STUB" "$host")"
  elif command -v route >/dev/null 2>&1; then
    output="$(route -n get "$host" 2>/dev/null || true)"
  elif command -v ip >/dev/null 2>&1; then
    output="$(ip route get "$host" 2>/dev/null || true)"
  else
    return 1
  fi

  if [[ -z "$output" ]]; then
    return 1
  fi

  # macOS `route -n get host` prints `interface: en0`; Linux `ip route get`
  # usually prints `dev eth0`. Keep parsing narrow and readable.
  local interface=""
  interface="$(
    printf '%s\n' "$output" \
      | awk '
          $1 == "interface:" { print $2; exit }
          {
            for (i = 1; i < NF; i++) {
              if ($i == "dev") {
                print $(i + 1)
                exit
              }
            }
          }
        '
  )"

  [[ -n "$interface" ]] || return 1
  printf '%s\n' "$interface"
}

github_release_upload_is_tunnel_interface() {
  case "$1" in
    utun*|wg*|ppp*|ipsec*) return 0 ;;
    *) return 1 ;;
  esac
}

github_release_upload_check_routes() {
  local allow_slow="${ALLOW_SLOW_RELEASE_UPLOAD:-0}"
  local host interface
  local failed=0

  while IFS= read -r host; do
    [[ -n "$host" ]] || continue

    if ! interface="$(github_release_upload_route_interface "$host")"; then
      echo "ERROR: could not determine network route for $host before GitHub release upload." >&2
      echo "Check connectivity, then rerun. If you intentionally accept a slow/opaque route, set ALLOW_SLOW_RELEASE_UPLOAD=1." >&2
      failed=1
      continue
    fi

    echo "GitHub upload preflight: route $host via $interface"
    if github_release_upload_is_tunnel_interface "$interface"; then
      if [[ "$allow_slow" == "1" ]]; then
        echo "WARN: $host routes through tunnel interface $interface; continuing because ALLOW_SLOW_RELEASE_UPLOAD=1." >&2
      else
        echo "ERROR: $host routes through tunnel/VPN interface $interface." >&2
        echo "Turn off VPN/tunnel routing, switch Wi-Fi/hotspot, or rerun with ALLOW_SLOW_RELEASE_UPLOAD=1 if this slow path is intentional." >&2
        failed=1
      fi
    fi
  done < <(github_release_upload_preflight_hosts)

  [[ "$failed" == "0" ]]
}

github_release_upload_probe_url() {
  local url="$1"
  local timeout="${OPENCLAW_GITHUB_UPLOAD_PREFLIGHT_TIMEOUT_SECS:-8}"
  local status=""

  if [[ -n "${OPENCLAW_GITHUB_UPLOAD_PREFLIGHT_CURL_STUB:-}" ]]; then
    status="$("$OPENCLAW_GITHUB_UPLOAD_PREFLIGHT_CURL_STUB" "$url")"
  else
    status="$(
      curl -L -sS -o /dev/null -w '%{http_code}' \
        --connect-timeout 5 \
        --max-time "$timeout" \
        "$url" 2>/dev/null || true
    )"
  fi

  case "$status" in
    2??|3??|4??)
      echo "GitHub upload preflight: reachable $url (HTTP $status)"
      return 0
      ;;
    *)
      echo "ERROR: GitHub upload preflight could not reach $url quickly (HTTP ${status:-none})." >&2
      echo "Turn off VPN, switch Wi-Fi/hotspot, or fix GitHub connectivity before uploading large release assets." >&2
      echo "If this environment is intentionally slow but known-good, rerun with ALLOW_SLOW_RELEASE_UPLOAD=1." >&2
      return 1
      ;;
  esac
}

github_release_upload_check_reachability() {
  local failed=0

  # These are GitHub-specific probes for the exact release-upload lane. A 404
  # from uploads.github.com still proves TLS, DNS, and routing reached GitHub.
  github_release_upload_probe_url "https://api.github.com/rate_limit" || failed=1
  github_release_upload_probe_url "https://uploads.github.com/" || failed=1

  [[ "$failed" == "0" ]]
}

github_release_upload_preflight() {
  local failed=0

  if [[ "${ALLOW_SLOW_RELEASE_UPLOAD:-0}" == "1" ]]; then
    echo "WARN: ALLOW_SLOW_RELEASE_UPLOAD=1 set; tunnel routes will warn instead of failing." >&2
  fi

  # Keep route and reachability checks independent so one useful failure does
  # not hide another. Without this, a tunnel-route failure could be overwritten
  # by a successful HTTP probe and the release upload would still begin.
  github_release_upload_check_routes || failed=1
  github_release_upload_check_reachability || failed=1

  [[ "$failed" == "0" ]]
}

github_release_upload_preflight_main() {
  case "${1:-}" in
    --help|-h)
      cat <<'EOF'
Usage: scripts/lib/github-release-upload-preflight.sh

Checks the GitHub release upload route and quick reachability before large
Jarvis release assets are uploaded.

Env:
  ALLOW_SLOW_RELEASE_UPLOAD=1
      Continue when GitHub routes through utun*, wg*, ppp*, or ipsec*.
  OPENCLAW_GITHUB_UPLOAD_PREFLIGHT_ROUTE_STUB=/path/to/stub
      Test hook: executable receives a host and prints route-like output.
  OPENCLAW_GITHUB_UPLOAD_PREFLIGHT_CURL_STUB=/path/to/stub
      Test hook: executable receives a URL and prints an HTTP status code.
EOF
      ;;
    "")
      github_release_upload_preflight
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      return 2
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  github_release_upload_preflight_main "$@"
fi
