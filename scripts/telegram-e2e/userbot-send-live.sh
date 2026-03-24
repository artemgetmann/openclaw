#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

chat=""
text=""
reply_to=""

usage() {
  cat <<'USAGE'
Usage:
  userbot-send-live.sh --chat <chat> --text <text> [--reply-to <messageId>]

This is a compatibility shim. The real operator surface is:
  pnpm openclaw:local telegram-user send ...
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --chat)
      chat="${2:-}"
      shift 2
      ;;
    --text)
      text="${2:-}"
      shift 2
      ;;
    --reply-to)
      reply_to="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "${chat}" || -z "${text}" ]]; then
  echo "Missing required args: --chat and --text." >&2
  usage >&2
  exit 1
fi

# Keep this wrapper thin so agents and humans hit the same CLI path instead of
# reviving the older direct Python entrypoints by accident.
cmd=(
  pnpm
  openclaw:local
  telegram-user
  send
  --chat
  "${chat}"
  --message
  "${text}"
)

if [[ -n "${reply_to}" ]]; then
  cmd+=(--reply-to "${reply_to}")
fi

cd "${REPO_ROOT}"
exec "${cmd[@]}"
