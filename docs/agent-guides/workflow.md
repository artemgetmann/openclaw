# Workflow

## Branch and PR targets

- Default to this fork, not upstream.
- Consumer-product work targets `codex/consumer-openclaw-project`.
- General fork work that is not consumer-product work targets this repo's `main`.
- Keep the canonical shared checkout at `/Users/user/Programming_Projects/openclaw` on `main`. That checkout owns the long-lived shared `ai.openclaw.gateway` runtime. Consumer work should happen in worktrees created from that checkout with `bash scripts/new-worktree.sh <feature-name> --base codex/consumer-openclaw-project`.
- The canonical shared `main` checkout is runtime/orchestration-only, not a coding lane.
- Allowed there: `git status`, `git pull --ff-only`, `bash scripts/new-worktree.sh ...`, PR/review/orchestration commands, and shared-runtime operations.
- Not allowed there: tracked implementation edits, feature development, or commits. Move into a worktree before changing repo files.
- Before creating a new worktree, fast-forward the chosen base branch locally so it exactly matches `origin/<base>`. `scripts/new-worktree.sh` now fails if the named base branch is ahead of or behind its remote tracking branch. Use `git checkout <base> && git pull --ff-only` first, then create the worktree.
- `scripts/new-worktree.sh` now bootstraps fresh lanes by default with a per-worktree dependency install/build. It must not symlink `node_modules` or `ui/node_modules` from another checkout because that leaks cross-worktree package state into clean-room validation.
- `scripts/new-worktree.sh` supports explicit lane modes:
  - `--mode clean` is the default and keeps the current clean-room behavior for consumer E2E, runtime-sensitive work, or anything that must prove isolation honestly.
  - `--mode warm` creates the worktree and dev launch env, installs JS dependencies in-place, and skips the slower build step so coding/debugging lanes come up faster.
- Warm mode is intentionally conservative:
  - it does not reuse runtime/auth/session/browser state
  - it does not symlink or copy `node_modules`
  - it does not share Swift `.build` artifacts
  - if you need the heavier macOS/Swift warm-up, use `bash scripts/prewarm-worktree.sh --root <worktree> --macos` after creation instead of leaking state between lanes
- Worktree/bootstrap/consumer runtime scripts pin to the repo-validated Node version from `.node-version` / `.nvmrc` instead of trusting the shell-default `node`. If that exact version is missing, install it first or point `OPENCLAW_NODE_BIN` at a binary with the same version.
- Use upstream `https://github.com/openclaw/openclaw` only when the user explicitly asks for upstream review, triage, or PR flow.
- `consumer` is legacy. Do not target new PRs there unless the user explicitly asks.
- Do not recreate `consumer` for new work. The active product branch is `codex/consumer-openclaw-project`.
- If the user says "consumer branch", interpret that as `codex/consumer-openclaw-project` unless they explicitly say they want the legacy `consumer` branch.
- Never run `git merge upstream/main` on this fork. Port upstream changes selectively via `main`.

## Worktree durability

- Default location rule:
  - create repo worktrees under the repo-owned `.worktrees/` directory by default
  - use one predictable location so active lanes do not get split across `.worktrees/` and `.codex/worktrees/`
- Why:
  - `.codex/worktrees/` lanes have repeatedly disappeared after restart, interruption, cleanup, or session churn
  - the branch and Codex history often survive, but the on-disk checkout may not
- Practical rule:
  - important multi-hour, multi-turn, or PR-bound work belongs under `.worktrees/`
  - use `--mode clean` for runtime/E2E lanes where state honesty matters
  - use `--mode warm` for faster coding/debugging lanes when you want a fresh branch without paying the full build tax up front
  - do not create new durable lanes under `.codex/worktrees/` unless the user explicitly asks for that path
  - if you inherit a non-trivial lane under `.codex/worktrees/`, checkpoint aggressively and print proof lines before surgery
- When state matters, print:
  - `branch=<branch>`
  - `worktree=<absolute-path>`
  - `head=<sha>`
  - `status_dirty=yes|no`
- For recovery and vanished-worktree triage, use `docs/debug/worktree-branch-survival.md`.

## Durable lane entry

- Shared durable lanes for `main` and `codex/consumer-openclaw-project` should be entered through the shell helper, not by `cd` plus hope.
- Source the helper once in your shell rc:
  - `source /Users/user/Programming_Projects/openclaw/scripts/shell-helpers/durable-lane-helpers.sh`
- Then use:
  - `wt-main`
  - `wt-consumer`
- Those wrappers:
  - locate the linked durable lane by branch
  - fetch `origin/<branch>`
  - fast-forward the lane before entering it
  - refuse entry if the lane is ahead of origin or otherwise no longer safe to fast-forward
- If you manually `cd` into a durable lane while the helper is loaded, it fetches and prints a stale warning when that lane is ahead/behind origin so you do not keep editing old branch truth.
- Commits from a durable lane are refused when the lane is behind origin. Override only intentionally with `OPENCLAW_ALLOW_STALE_DURABLE_LANE_COMMITS=1`.

## GitHub footguns

- For issue comments, PR comments, and review bodies, use literal multiline strings or a single-quoted heredoc. Do not embed `\n`.
- Do not use `gh issue/pr comment -b "..."` when the body contains shell characters or backticks. Use `-F - <<'EOF'`.
- Do not wrap issue or PR refs like `#24643` in backticks when you want auto-linking.
- When searching issues or PRs broadly, keep paginating until you reach the end. Do not assume the first page or first 500 results is enough.

## Commits and PRs

- Use `scripts/committer "<message>" <file...>` for commits so staging stays scoped.
- Use Conventional Commits and include a bullet body for what, why, and risk.
- Group related changes. Do not bundle unrelated refactors.
- Do not leave non-trivial implementation work only in the working tree. Create a checkpoint commit once the first meaningful slice of the change exists, even if end-to-end validation is still pending.
- Validation gates PR readiness and merge, not whether you are allowed to commit. If a task would be painful to re-create, it should already be committed.
- For long or risky tasks, prefer this sequence:
  - checkpoint commit after the first coherent implementation slice
  - more commits as the work evolves
  - end-to-end validation
  - PR or draft PR update with validation notes
- If validation is still pending, say so explicitly in the commit body or follow-up notes. Do not pretend a checkpoint commit means the change is fully verified.
- If the task is a bug-fix PR, require proof:
  - Symptom evidence
  - Root cause in code with file and line
  - Fix touching that code path
  - Regression proof or explicit manual validation notes
- Before `/landpr`, run `/reviewpr`.

## tmux and Codex panes

- When driving interactive Codex panes through tmux skills or manual pane control, do not paste a prompt and send Enter in one blind action.
- Paste the prompt first.
- Capture or inspect the pane so you know the full prompt landed correctly.
- Send Enter as a separate action.
- This avoids half-pasted prompts, accidental sends, and fake state recovery.

## Multi-agent safety

- Do not use `git stash` unless the user explicitly asks.
- Do not switch branches or modify worktrees unless the user explicitly asks.
- Leave unrelated edits alone. Focus on your own diff.
- If formatting-only churn appears around your changes, fold it in without turning it into a separate drama.
