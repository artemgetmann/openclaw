#!/usr/bin/env bash
set -euo pipefail

TARGET="${HOME}/.agents/skills"
FORCE=0
DRY_RUN=0
SOURCES=()

usage() {
  cat <<'EOF'
Usage: scripts/migrate-personal-skills-to-agents-root.sh [--dry-run] [--force] [--target <path>] [--source <path> ...]

Copy personal AgentSkills into a user-owned shared skills root.

Defaults:
  target:  ~/.agents/skills
  sources: ~/.claude/skills and ~/.openclaw/workspace/skills

This script copies real skill folders. If a source skill is a symlink, the
symlink target is copied into the target root. Existing target skills are left
untouched unless --force is supplied.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --target)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --target requires a path" >&2
        exit 1
      fi
      TARGET="$2"
      shift 2
      ;;
    --source)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --source requires a path" >&2
        exit 1
      fi
      SOURCES+=("$2")
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ ${#SOURCES[@]} -eq 0 ]]; then
  SOURCES=("${HOME}/.claude/skills" "${HOME}/.openclaw/workspace/skills")
fi

expand_path() {
  local raw="$1"
  case "$raw" in
    "~") printf '%s\n' "$HOME" ;;
    "~/"*) printf '%s/%s\n' "$HOME" "${raw#"~/"}" ;;
    *) printf '%s\n' "$raw" ;;
  esac
}

is_skippable_name() {
  local name="$1"
  case "$name" in
    .*|slash-skills|slash-commands)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

copy_skill() {
  local source_dir="$1"
  local skill_name="$2"
  local target_dir="$3"
  local source_real
  source_real="$(cd "$source_dir" && pwd -P)"

  if [[ ! -f "${source_real}/SKILL.md" ]]; then
    return 0
  fi

  local dest="${target_dir}/${skill_name}"
  if [[ -e "$dest" && "$FORCE" != "1" ]]; then
    echo "skip existing: ${dest/#$HOME/~}"
    return 0
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "copy: ${source_real/#$HOME/~} -> ${dest/#$HOME/~}"
    return 0
  fi

  mkdir -p "$target_dir"
  if [[ "$FORCE" == "1" ]]; then
    rm -rf "$dest"
  fi

  # Use tar instead of cp -R so symlinked source directories are materialized as
  # normal directories while preserving nested files, modes, and relative links.
  mkdir -p "$dest"
  tar -C "$source_real" -cf - . | tar -C "$dest" -xf -
  echo "copied: ${source_real/#$HOME/~} -> ${dest/#$HOME/~}"
}

TARGET="$(expand_path "$TARGET")"
if [[ "$DRY_RUN" != "1" ]]; then
  mkdir -p "$TARGET"
fi

declare -A SEEN_SKILLS=()
for raw_source in "${SOURCES[@]}"; do
  source_root="$(expand_path "$raw_source")"
  if [[ ! -d "$source_root" ]]; then
    echo "skip missing source: ${source_root/#$HOME/~}"
    continue
  fi
  while IFS= read -r -d '' entry; do
    name="$(basename "$entry")"
    if is_skippable_name "$name"; then
      continue
    fi
    if [[ -n "${SEEN_SKILLS[$name]:-}" ]]; then
      continue
    fi
    SEEN_SKILLS[$name]=1
    copy_skill "$entry" "$name" "$TARGET"
  done < <(find "$source_root" -mindepth 1 -maxdepth 1 \( -type d -o -type l \) -print0)
done
