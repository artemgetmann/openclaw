#!/usr/bin/env bash
set -euo pipefail

# Blessed Jarvis macOS release lane bootstrap.
#
# Normal feature work should keep using temp worktrees. Jarvis release work is
# different: Swift/package warmup is expensive, and release agents mostly need a
# clean, current, already-warmed lane that fails early when it goes stale.

HOME_CLONE="${OPENCLAW_MAIN_HOME_CLONE:-/Users/user/Programming_Projects/openclaw}"
RELEASE_NAME="${OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME:-jarvis-release-current}"
RELEASE_BRANCH="codex/${RELEASE_NAME}"
RELEASE_WORKTREE="${HOME_CLONE}/.worktrees/${RELEASE_NAME}"

usage() {
  cat <<'EOF'
Usage: scripts/jarvis-release-worktree.sh

Create or reuse the persistent prewarmed Jarvis macOS release lane:
  /Users/user/Programming_Projects/openclaw/.worktrees/jarvis-release-current

The script fast-forwards the sacred main home clone, creates the lane when
missing, fast-forwards an existing clean release lane to main, runs macOS
prewarm proof, then prints the release commands to run from that lane.
EOF
}

case "${1:-}" in
  --help|-h)
    usage
    exit 0
    ;;
  "")
    ;;
  *)
    echo "ERROR: unexpected argument: $1" >&2
    usage >&2
    exit 1
    ;;
esac

if [[ ! -d "$HOME_CLONE/.git" ]]; then
  cat >&2 <<EOF
ERROR: sacred main home clone is missing:
  $HOME_CLONE

Restore the pull-only home clone first. Release worktrees must branch from that
clone so main/runtime truth stays boring.
EOF
  exit 1
fi

cd "$HOME_CLONE"

source "$HOME_CLONE/scripts/lib/worktree-guards.sh"

if ! worktree_guard_is_sacred_home_clone "$HOME_CLONE"; then
  cat >&2 <<EOF
ERROR: configured home clone is not recognized as the sacred main clone:
  $HOME_CLONE
EOF
  exit 1
fi

worktree_guard_require_sacred_home_clone_base_branch \
  "$HOME_CLONE" \
  "scripts/jarvis-release-worktree.sh"

worktree_guard_reject_sacred_home_edits \
  "$HOME_CLONE" \
  worktree \
  --context "scripts/jarvis-release-worktree.sh"

echo "release_home_clone=$HOME_CLONE"
echo "release_step=git-pull-main"
git pull --ff-only origin main

if [[ ! -e "$RELEASE_WORKTREE/.git" ]]; then
  echo "release_step=create-worktree"
  bash scripts/new-worktree.sh "$RELEASE_NAME" --base main --mode warm
else
  echo "release_step=reuse-worktree"
  current_branch="$(git -C "$RELEASE_WORKTREE" branch --show-current)"
  if [[ "$current_branch" != "$RELEASE_BRANCH" ]]; then
    cat >&2 <<EOF
ERROR: release worktree is on the wrong branch.

Worktree: $RELEASE_WORKTREE
Expected: $RELEASE_BRANCH
Actual:   ${current_branch:-detached}
EOF
    exit 1
  fi

  dirty="$(git -C "$RELEASE_WORKTREE" status --porcelain)"
  if [[ -n "$dirty" ]]; then
    cat >&2 <<EOF
ERROR: release worktree is not clean:
  $RELEASE_WORKTREE

$dirty

Commit, revert, or move this work before reusing the persistent release lane.
EOF
    exit 1
  fi

  # A persistent release branch should contain no private commits. If it is not
  # an ancestor of current main, fast-forwarding would hide a real forked lane.
  if ! git -C "$RELEASE_WORKTREE" merge-base --is-ancestor HEAD main; then
    cat >&2 <<EOF
ERROR: release worktree cannot fast-forward to current main.

Worktree: $RELEASE_WORKTREE
Branch:   $RELEASE_BRANCH

Inspect the branch before using it for release packaging:
  git -C "$RELEASE_WORKTREE" log --oneline --decorate --left-right HEAD...main
EOF
    exit 1
  fi

  echo "release_step=fast-forward-release-worktree"
  git -C "$RELEASE_WORKTREE" merge --ff-only main
fi

echo "release_step=prewarm-macos"
bash scripts/prewarm-worktree.sh --root "$RELEASE_WORKTREE" --macos

cat <<EOF
release_worktree=$RELEASE_WORKTREE
release_branch=$RELEASE_BRANCH
release_status=ready

Ready commands:
  cd "$RELEASE_WORKTREE"
  bash scripts/package-openclaw-mac-dist.sh --local-proof
  bash scripts/package-openclaw-mac-dist.sh --phase build-app-only
  bash scripts/package-openclaw-mac-dist.sh --phase submit-app-notarization
  bash scripts/package-openclaw-mac-dist.sh --phase poll-app-notarization
  bash scripts/package-openclaw-mac-dist.sh --phase submit-dmg-notarization
  bash scripts/package-openclaw-mac-dist.sh --phase poll-dmg-notarization
  bash scripts/package-openclaw-mac-dist.sh --phase create-local-release-assets-only
  bash scripts/package-openclaw-mac-dist.sh --phase publish-assets-only --publish-release-assets --github-release-tag "<latest-tag>"
  bash scripts/package-openclaw-mac-dist.sh --phase verify-public-assets-only --github-release-tag "<latest-tag>"
EOF
