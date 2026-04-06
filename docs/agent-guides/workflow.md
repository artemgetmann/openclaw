# Workflow

## Branch and PR targets

- Default to this fork, not upstream.
- Consumer-product work targets `codex/consumer-openclaw-project`.
- General fork work that is not consumer-product work targets this repo's `main`.
- Use upstream `https://github.com/openclaw/openclaw` only when the user explicitly asks for upstream review, triage, or PR flow.
- `consumer` is legacy. Do not target new PRs there unless the user explicitly asks.
- Do not recreate `consumer` for new work. The active product branch is `codex/consumer-openclaw-project`.
- If the user says "consumer branch", interpret that as `codex/consumer-openclaw-project` unless they explicitly say they want the legacy `consumer` branch.
- Never run `git merge upstream/main` on this fork. Port upstream changes selectively via `main`.

## Two-clone default

- Default model:
  - `~/Programming_Projects/openclaw` is the home clone for fork `main`
  - `~/Programming_Projects/openclaw-consumer` is the home clone for `codex/consumer-openclaw-project`
- Those home clones replace durable worktrees as the default branch homes.
- Base branches are pull-only:
  - do not commit directly to `main`
  - do not commit directly to `codex/consumer-openclaw-project`
  - local guards in `git-hooks/pre-commit` and `scripts/committer` block direct commits on those branches
- Agents still create short-lived feature branches for every task.
- Open a draft PR once the first coherent slice exists. Validation can happen after the draft PR is open.
- Mark the PR ready only after validation is complete.
- Merge only when the task and repo policy allow it.

## Home clone entry

- Source the helper once in your shell rc:
  - `source /Users/user/Programming_Projects/openclaw/scripts/shell-helpers/home-clone-helpers.sh`
- Then use:
  - `oc-main`
  - `oc-consumer`
- Those wrappers:
  - enter the correct home clone
  - require the clone to already be on its base branch
  - require a clean worktree so `git pull --ff-only` is honest
  - fast-forward from `origin/<base>` before you start work
- If a helper refuses entry, fix the clone first instead of forcing around it. The point is to keep base-branch truth boring.

## Daily agent sequence

1. Enter the right home clone with `oc-main` or `oc-consumer`.
2. Create a short-lived feature branch.
3. Code on that feature branch.
4. Open or update a draft PR early.
5. Validate on the feature branch.
6. Mark the PR ready when validation is complete.
7. Merge if the task and policy allow it.
8. Return the home clone to its base branch and fast-forward it again.

## Temporary worktrees

- Temporary worktrees are still allowed.
- They are no longer the default branch homes.
- Use them when 2 or more agents need isolated parallel editing in the same clone.
- Keep repo-owned temporary worktrees under `.worktrees/` when practical so they do not scatter across multiple ad-hoc locations.
- Before creating a temporary worktree, fast-forward the chosen base branch locally so it exactly matches `origin/<base>`. `scripts/new-worktree.sh` fails if the named base branch is ahead of or behind its remote tracking branch.
- `scripts/new-worktree.sh` bootstraps fresh lanes by default with a per-worktree dependency install/build. It must not symlink `node_modules` or `ui/node_modules` from another checkout because that leaks cross-worktree package state into clean-room validation.
- `scripts/new-worktree.sh` supports explicit lane modes:
  - `--mode clean` is the default and keeps the current clean-room behavior for consumer E2E, runtime-sensitive work, or anything that must prove isolation honestly.
  - `--mode warm` creates the worktree and dev launch env, installs JS dependencies in-place, and skips the slower build step so coding/debugging lanes come up faster.
- Warm mode is intentionally conservative:
  - it does not reuse runtime/auth/session/browser state
  - it does not symlink or copy `node_modules`
  - it does not share Swift `.build` artifacts
  - if you need the heavier macOS/Swift warm-up, use `bash scripts/prewarm-worktree.sh --root <worktree> --macos` after creation instead of leaking state between lanes
- Worktree/bootstrap/consumer runtime scripts pin to the repo-validated Node version from `.node-version` / `.nvmrc` instead of trusting the shell-default `node`. If that exact version is missing, install it first or point `OPENCLAW_NODE_BIN` at a binary with the same version.
- Legacy durable worktrees may still exist during migration. Do not retire them in-place during this change. Cleanup belongs to a later explicit pass.
- For recovery and vanished-worktree triage, use `docs/debug/worktree-branch-survival.md`.

## Migration path

1. Keep the existing durable worktrees for now. Do not delete them as part of this rollout.
2. Ensure the two home clones exist at `~/Programming_Projects/openclaw` and `~/Programming_Projects/openclaw-consumer`.
3. Source `scripts/shell-helpers/home-clone-helpers.sh` and start entering clones through `oc-main` / `oc-consumer`.
4. Stop treating durable worktrees as the default branch homes.
5. For new work, create a short-lived feature branch inside the correct home clone, then open a draft PR early.
6. Use temporary worktrees only when parallel isolation or clean-room validation actually requires them.
7. After the team has migrated, do a separate cleanup pass for old durable worktrees.

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
- Open or update the draft PR as soon as the first coherent slice exists so review context and CI history do not live only in local state.
- Validation gates PR readiness and merge, not whether you are allowed to commit. If a task would be painful to re-create, it should already be committed.
- For long or risky tasks, prefer this sequence:
  - checkpoint commit after the first coherent implementation slice
  - draft PR opened or updated with the current state
  - more commits as the work evolves
  - end-to-end validation
  - mark PR ready and update it with validation notes
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
