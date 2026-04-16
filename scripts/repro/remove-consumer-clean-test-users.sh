#!/usr/bin/env bash
set -euo pipefail

# Local cleanup helper for disposable macOS users created during packaged
# consumer smoke. This is intentionally narrow: it only targets the known test
# accounts from this lane and refuses to do anything unless the caller is root
# and passes an explicit confirmation flag.

TARGET_USERS=("openclawfresh" "openclawclean")

usage() {
  cat <<'EOF'
Usage:
  sudo bash scripts/repro/remove-consumer-clean-test-users.sh --yes

What this does:
  - Local cleanup for disposable macOS test users created after packaged smoke
  - Targets openclawfresh and openclawclean if they exist
  - Deletes the account and its home directory with standard macOS tooling

Safety:
  - Refuses to run without sudo/root
  - Refuses to delete anything without --yes
  - Prints the exact users it will target before any deletion happens

Notes:
  - This is for local cleanup only. It does not touch unrelated users.
  - If a target user is currently logged in, the script refuses to proceed.
EOF
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "ERROR: run this script with sudo/root." >&2
    exit 1
  fi
}

user_exists() {
  dscl . -read "/Users/$1" >/dev/null 2>&1
}

user_is_logged_in() {
  local user="$1"
  who | awk '{print $1}' | grep -Fxq "$user"
}

user_home_dir() {
  local user="$1"
  local home_dir

  home_dir="$(dscl . -read "/Users/${user}" NFSHomeDirectory 2>/dev/null | awk '/NFSHomeDirectory/ {print $2}' || true)"
  if [[ -z "${home_dir}" ]]; then
    home_dir="/Users/${user}"
  fi
  printf '%s\n' "$home_dir"
}

delete_user() {
  local user="$1"
  local home_dir="$2"

  echo "Deleting ${user} with sysadminctl (-deleteUser -secure)..."
  sysadminctl -deleteUser "$user" -secure

  if user_exists "$user"; then
    echo "ERROR: ${user} still exists after sysadminctl deletion." >&2
    return 1
  fi

  if [[ -e "$home_dir" || -L "$home_dir" ]]; then
    echo "ERROR: ${user} home directory still exists after deletion: ${home_dir}" >&2
    return 1
  fi

  echo "Removed ${user} and home directory ${home_dir}"
}

main() {
  local confirm="${1:-}"
  local -a existing_users=()
  local user=""
  local home_dir=""

  if [[ "${confirm}" == "--help" || "${confirm}" == "-h" ]]; then
    usage
    exit 0
  fi

  require_root

  echo "Local cleanup helper for packaged consumer smoke."
  echo "Disposable users targeted: ${TARGET_USERS[*]}"

  for user in "${TARGET_USERS[@]}"; do
    if user_exists "$user"; then
      existing_users+=("$user")
      home_dir="$(user_home_dir "$user")"
      echo "  present: ${user} (${home_dir})"
    else
      echo "  absent:  ${user}"
    fi
  done

  if [[ "${confirm}" != "--yes" ]]; then
    cat <<'EOF'
No deletion performed.
Re-run with --yes to delete the users and their home directories.
EOF
    exit 0
  fi

  if [[ ${#existing_users[@]} -eq 0 ]]; then
    echo "Nothing to delete."
    exit 0
  fi

  for user in "${existing_users[@]}"; do
    if user_is_logged_in "$user"; then
      echo "ERROR: ${user} is currently logged in. Log out first, then rerun." >&2
      exit 1
    fi
  done

  for user in "${existing_users[@]}"; do
    home_dir="$(user_home_dir "$user")"
    delete_user "$user" "$home_dir"
  done

  echo "Cleanup complete. This helper is only for local post-smoke disposal."
}

main "$@"
