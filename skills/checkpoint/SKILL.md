---
name: checkpoint
description: Save or resume a local chat checkpoint. Trigger on "make checkpoint", "checkpoint this chat", "resume from checkpoint", "resume from latest checkpoint", or "resume from last checkpoint". Stores markdown files in the active OpenClaw workspace; no MindMirror or remote service required.
---

# Checkpoint

Use this skill when the user asks to save the current chat state for a clean
handoff, or asks to resume from a previously saved checkpoint.

This is local-first. Do not call MindMirror, a remote memory service, or a
runtime API. A checkpoint is just a markdown file in the active OpenClaw
workspace.

## Triggers

Use this skill for:

- make checkpoint
- checkpoint this chat
- resume from checkpoint
- resume from latest checkpoint
- resume from last checkpoint
- resume from checkpoint `<id>`
- resume from checkpoint `<absolute-path-to-checkpoint.md>`

## Storage

Store checkpoints under the active OpenClaw workspace:

```text
checkpoints/YYYY-MM-DD/<timestamp>-<slug>.md
```

Use local time for the date directory and timestamp. Keep the slug short,
lowercase, and filesystem-safe. The checkpoint id is the filename without
`.md`.

Example:

```text
checkpoints/2026-05-14/20260514-143022-checkpoint-ux.md
```

Do not add an index unless the directory becomes hard to scan. The first slice
is intentionally simple.

## Save Flow

1. Confirm you are in the active OpenClaw workspace with `pwd`.
2. Inventory active handoff state before writing:
   - active goal and latest user intent
   - active tmux panes, Codex/Claude workers, and sub-agents with their owners
   - PRs/branches/worktrees that are waiting, blocked, merged, or ready
   - runtime/process state when it matters
   - exact next action and what should be ignored/deferred
3. Create the date directory under `checkpoints/`.
4. Write one markdown checkpoint file with the template below.
5. Re-read the checkpoint before replying and verify it includes the owner map.
6. Reply with the checkpoint path, checkpoint id, and all resume options:
   - Easy: start a new chat and say "resume from the latest checkpoint"
   - Precise: start a new chat and say "resume from checkpoint <id>"
   - Portable: start a new chat and say "resume from checkpoint <absolute path>"

## Checkpoint Template

```markdown
# Checkpoint: <short title>

- id: <checkpoint-id>
- created: <ISO timestamp with timezone>
- workspace: <absolute workspace path>
- branch: <current git branch>
- commit: <current git commit>

## Current Goal

<What the chat is trying to accomplish.>

## Current State

<What is true now, including runtime state if relevant. Include the condensed
story of what happened so a fresh agent can understand the situation without
the old chat. Be direct about root causes, false starts, and what was ruled
out.>

## Decisions

- <Decision and why it matters.>

## Active Owners

- <Active lane/subagent owner, exact tmux session/window/pane or subagent id,
  cwd/worktree, current command/TUI, owned scope, current status.>

## Open Tasks

- <Next task, exact owner, expected output, and whether user approval is needed.>

## Parked or Waiting

- <Anything not currently in focus but important later: PRs, lanes, blockers,
  review/merge decisions, validation gaps, or cleanup. Include exact owner
  coordinates.>

## PRs, Commits, and Files

- PRs: <links or none>
- Commits: <hashes or none>
- Files: <important repo-relative paths>

## Tests and Proof

- <Commands run and pass/fail result.>

## Do Not Do / Deferred

- <Explicitly list work that should not be resumed accidentally, topics that are
  intentionally deferred, and risky actions that need fresh approval.>

## Resume Instruction

Start a new chat and say:

> resume from checkpoint <checkpoint-id>
```

## Resume Flow

For "resume from checkpoint `<absolute-path-to-checkpoint.md>`":

```bash
test -f '<absolute-path-to-checkpoint.md>' && printf '%s\n' '<absolute-path-to-checkpoint.md>'
```

Use the absolute path directly when it exists. This is the preferred portable
resume form when the user may switch worktrees, projects, or current working
directories.

For "resume from latest checkpoint" or "resume from last checkpoint":

```bash
find checkpoints -type f -path 'checkpoints/*/*.md' -print | sort | tail -1
```

For "resume from checkpoint `<id>`":

```bash
find checkpoints -type f -name '<id>.md' -print
```

Read the checkpoint, state the recovered goal and next action in plain
language, then continue from the open tasks. If no checkpoint exists, say so and
ask for the missing id or context.

## Rules

- Keep checkpoints factual and compact.
- The checkpoint must be useful to a zero-context agent. If a fresh agent would
  have to rediscover owners, active panes, PR state, or the current priority,
  the checkpoint is incomplete.
- For coordinator/orchestrator chats, always include the owner map: tmux
  session/window/pane, subagent id, worktree/cwd, branch if known, task scope,
  and status.
- Separate active focus from parked work. Do not bury the one thing that matters
  under a long backlog.
- Include enough narrative to explain why the current conclusion matters. A
  checkpoint is not just a todo list; it is a compressed handoff.
- Include exact commands and proof when they matter.
- Do not claim tests passed unless they were actually run.
- Do not store secrets, tokens, or private credentials.
- Prefer repo-root-relative file paths inside the checkpoint, except for the
  workspace path metadata.
