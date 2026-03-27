# Worktree Branch Survival

Use this when you are working across multiple branches or worktrees and want to avoid "losing" changes.

Most lost-work incidents are not real data loss. They are state confusion.

## The Simple Model

There are three different truths:

1. Remote truth

- what GitHub has, like `origin/main`

2. Local truth

- what your local branch points to, like `main`

3. Runtime truth

- what code the live process is actually running

Those can all disagree.

## Where Changes Can Live

Changes usually live in one of four places:

1. Working tree

- uncommitted file edits
- these exist only in this checkout/worktree folder

2. Local commits

- committed on your machine
- not necessarily pushed yet

3. Remote branch

- pushed to GitHub
- not necessarily merged

4. Merged target branch

- landed in `main`
- not necessarily pulled locally
- not necessarily running live

## The Five Safety Questions

Before rebasing, deleting, merging, or restarting a runtime, answer these:

1. Am I on the branch I think I am on?
2. Do I have uncommitted changes?
3. Are my commits pushed?
4. Is this branch actually merged yet?
5. Is the runtime using this checkout, or another one?

If you cannot answer those quickly, stop and print proof first.

## Worktree Reality

Each worktree has:

- its own checked-out branch or commit
- its own files on disk
- its own uncommitted changes

Do not assume another worktree sees your uncommitted edits.

Do not assume a checkout you call "main" is actually on `main`.

For lane placement, use this default:

- create repo worktrees under the repo-owned `.worktrees/` directory by default
- keep one predictable location so active lanes do not get split across `.worktrees/` and `.codex/worktrees/`
- important multi-hour, multi-turn, or PR-bound work belongs under `.worktrees/`
- do not create new durable lanes under `.codex/worktrees/` unless the user explicitly asks for that path

Reason:

- active `.codex/worktrees/` lanes have repeatedly disappeared after interruption, restart, cleanup, or other session churn
- the branch and Codex history often survive, but the directory on disk may not

Treat uncommitted work as volatile. If the change is non-trivial, create a checkpoint commit before you step away, restart, switch focus, or do branch/worktree surgery.

## Safe Sequence Before Risky Git Operations

Run these before branch surgery:

```bash
git status
git branch --show-current
git log --oneline --decorate -n 5
git fetch origin
```

If you are about to delete or abandon a branch, also check:

```bash
git rev-parse HEAD
git rev-parse origin/$(git branch --show-current 2>/dev/null || true)
```

## What Usually Goes Wrong

These are the common footguns:

- committed locally, never pushed
- pushed to a feature branch, never merged
- merged remotely, but local `main` is stale
- local `main` updated, but the live runtime still launches from another checkout
- uncommitted edits exist only in one worktree and get forgotten
- active work lived only in `.codex/worktrees/...`, the directory disappeared, and everyone assumed the branch was gone too

## Proof Lines

When branch state matters, print:

- `branch=<branch>`
- `worktree=<path>`
- `head=<sha>`
- `status_dirty=yes|no`

When runtime state matters, also print:

- `runtime_worktree=<path>`
- `runtime_commit=<sha>`
- `runtime_command=<command>`
- `runtime_pid=<pid>`

That turns guesswork into evidence.

If you are coordinating through tmux skills or another remote pane controller, also respect this rule:

- paste the prompt first
- verify the pane content
- send Enter separately

Blind "paste plus Enter" is unreliable for interactive Codex panes and creates fake recovery problems.

## Vanished Worktree Recovery

If a worktree directory vanished, do not start with cleanup. Start with evidence.

### Step 1: Find surviving branch and session evidence

From any checkout in the repo, run:

```bash
bash scripts/codex-recover.sh
```

That helper correlates:

- current git worktrees
- recent Codex session metadata under `~/.codex/sessions`
- the latest tmux-resurrect snapshot

Use `--all` if the lane is older or the default view is too narrow:

```bash
bash scripts/codex-recover.sh --all
```

Look for:

- the row with the expected `branch`, if it still exists somewhere else
- `session_id` or the `resume` signal tied to the vanished path
- the old `path` so you know which checkout disappeared

### Step 2: Prove the branch still exists

If the directory is gone but you know the branch name, verify the branch before recreating anything:

```bash
git branch --list 'codex/<lane>'
git log --oneline --decorate -n 10 codex/<lane>
git rev-parse codex/<lane>
```

If those commands work, the lane is not gone. Only the checkout vanished.

If the branch is missing locally, check remotes before assuming loss:

```bash
git fetch origin
git branch -r | rg 'codex/<lane>|origin/.+<lane>'
```

### Step 3: Recreate the missing checkout on the surviving branch

Prefer recreating important lanes under repo-owned `.worktrees/`:

```bash
git worktree add .worktrees/<lane> codex/<lane>
```

Then print proof immediately:

```bash
printf 'branch=%s\n' "$(git -C .worktrees/<lane> branch --show-current)"
printf 'worktree=%s\n' "$(cd .worktrees/<lane> && pwd -P)"
printf 'head=%s\n' "$(git -C .worktrees/<lane> rev-parse HEAD)"
printf 'status_dirty=%s\n' "$(test -n "$(git -C .worktrees/<lane> status --short)" && echo yes || echo no)"
```

### Step 4: Reattach the Codex conversation

Use the surviving evidence from Step 1:

- if you have a `resume_id`, resume that exact Codex session
- if you have only a `session_id` or archived transcript, use the transcript plus branch diff to reconstruct context
- if tmux still has a pane or resurrect trail, inspect it before sending anything new

The point is simple:

- restore the checkout first
- restore the conversation second
- only then continue editing

Do not create a fresh branch with the same intent until you have checked whether the original branch and session already survived.

### Step 5: Recover stranded uncommitted work from logs if needed

If the branch exists but the latest edits were never committed, search the surviving trails:

- `~/.codex/sessions/**`
- `~/.codex/archived_sessions/**`
- tmux capture or tmux-resurrect history

Use those sources to recover:

- the last prompt
- the last applied patch or discussed diff
- the intended next step

Then rebuild the missing edits in the recreated worktree and commit a checkpoint quickly so the lane is durable again.

## Branch Delete Rule

Before deleting a branch, verify:

- it is merged or intentionally being abandoned
- there are no unpushed commits you still need
- no worktree still depends on it

If you are not sure, do not delete it yet.

## Main Rule

Do not say "done" just because:

- the branch is committed
- or the PR is open
- or GitHub says merged

For live systems, done means:

- merged to remote target branch
- local target branch updated
- runtime checkout verified
- runtime restarted
- proof printed

That is the full chain.

## Checkpoint Commit Rule

Use commits for durability, not just for "finished" code.

- Make a checkpoint commit after the first meaningful implementation slice for any non-trivial task.
- Do not wait for perfect validation before creating the first commit.
- Validation still must happen before PR approval, merge, or runtime rollout.
- If the commit is a checkpoint and not fully validated yet, say that plainly in the commit body or notes.

The failure mode to avoid is simple:

- valuable work exists only in one worktree
- that worktree gets confused, deleted, or orphaned
- the branch has no commit containing the work

At that point Git cannot save you because Git never had the work.
