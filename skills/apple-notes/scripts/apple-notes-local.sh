#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  apple-notes-local.sh create --title <title> [--body <text> | --body-file <path>] [--folder <folder>]
  apple-notes-local.sh delete --id <note-id>

Notes:
  - Uses local AppleScript via osascript for deterministic create/delete.
  - Keep `memo` for list/search/fuzzy lookup; this helper only handles the non-interactive path.
EOF
}

command_name="${1:-}"
if [[ -z "$command_name" ]]; then
  usage >&2
  exit 1
fi
shift || true

folder_name="Notes"
note_title=""
note_body=""
note_id=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --folder)
      folder_name="${2:-}"
      shift 2
      ;;
    --title)
      note_title="${2:-}"
      shift 2
      ;;
    --body)
      note_body="${2:-}"
      shift 2
      ;;
    --body-file)
      note_body="$(cat "${2:-}")"
      shift 2
      ;;
    --id)
      note_id="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

case "$command_name" in
  create)
    if [[ -z "$note_title" ]]; then
      echo "create requires --title" >&2
      exit 1
    fi
    # Notes accepts plain-text body and a distinct `name`, which keeps create deterministic
    # without depending on memo's editor flow.
    /usr/bin/osascript - "$folder_name" "$note_title" "$note_body" <<'EOF'
on run argv
  set folderName to item 1 of argv
  set noteTitle to item 2 of argv
  set noteBody to item 3 of argv
  tell application "Notes"
    tell folder folderName
      set newNote to make new note with properties {name:noteTitle, body:noteBody}
      return id of newNote
    end tell
  end tell
end run
EOF
    ;;
  delete)
    if [[ -z "$note_id" ]]; then
      echo "delete requires --id" >&2
      exit 1
    fi
    /usr/bin/osascript - "$note_id" <<'EOF'
on run argv
  set noteID to item 1 of argv
  tell application "Notes"
    delete note id noteID
  end tell
end run
EOF
    ;;
  *)
    echo "Unknown command: $command_name" >&2
    usage >&2
    exit 1
    ;;
esac
