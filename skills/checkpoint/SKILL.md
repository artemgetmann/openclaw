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
2. Create the date directory under `checkpoints/`.
3. Write one markdown checkpoint file with the template below.
4. Reply with the checkpoint path, checkpoint id, and both resume options:
   - Easy: start a new chat and say "resume from the latest checkpoint"
   - Precise: start a new chat and say "resume from checkpoint <id>"

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

<What is true now, including runtime state if relevant.>

## Decisions

- <Decision and why it matters.>

## Open Tasks

- <Next task and owner if known.>

## PRs, Commits, and Files

- PRs: <links or none>
- Commits: <hashes or none>
- Files: <important repo-relative paths>

## Tests and Proof

- <Commands run and pass/fail result.>

## Resume Instruction

Start a new chat and say:

> resume from checkpoint <checkpoint-id>
```

## Resume Flow

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
- Include exact commands and proof when they matter.
- Do not claim tests passed unless they were actually run.
- Do not store secrets, tokens, or private credentials.
- Prefer repo-root-relative file paths inside the checkpoint, except for the
  workspace path metadata.
