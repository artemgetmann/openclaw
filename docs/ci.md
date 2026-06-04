---
title: CI Pipeline
description: How the OpenClaw CI pipeline works
summary: "CI job graph, scope gates, and local command equivalents"
read_when:
  - You need to understand why a CI job did or did not run
  - You are debugging failing GitHub Actions checks
---

# CI Pipeline

The CI runs on every push to `main` and every pull request. It uses smart scoping to skip expensive jobs when only unrelated areas changed.

## PR Merge Policy

GitHub owns waiting for CI and performing auto-merge. Agents own diagnosis,
review-bot handling, failed-CI fixes, and runtime shipping only after the merge
when the user explicitly asks for runtime shipping.

This boundary matters: an agent saying "CI is queued" or "CI is pending" is not
proof. A PR is merge-ready only when the relevant checks have completed
successfully and the PR is no longer a draft.

### Merge Candidates

- Draft PRs are not merge candidates.
- Queued or pending CI is not proof.
- Failed required or relevant conditional checks block merge.
- Skipped irrelevant jobs do not block merge.
- Slow release or full-matrix jobs are not normal PR blockers unless they were
  triggered by relevant changes or a maintainer explicitly requested them.

### Required Blockers

These checks block normal PR merge when they run:

- `CI / pr-required`
- `CI / secrets`
- `CI / check`
- Relevant `CI / checks (...)` Node test, extension, channel, and protocol lanes
- Any security-owned secret, dependency, workflow, or CodeQL check that is
  required by the current GitHub ruleset

`CI / pr-required` is the branch-protection-friendly aggregate gate. It runs
after the scoped CI jobs and fails if a job that should run did not pass. It
allows intentional skips for irrelevant docs, macOS, Android, Windows, and
Python skill lanes.

`CI / secrets` is always required. It detects committed private keys, audits
changed workflows with `zizmor`, and audits production dependencies when
dependency files changed.

### Conditional Blockers

The scope detector is the source of truth for whether platform-specific CI is
relevant. Scope logic lives in `scripts/ci-changed-scope.mjs` and is covered by
`src/scripts/ci-changed-scope.test.ts`.

- Docs changed: `CI / check-docs` blocks merge.
- macOS changed: `CI / macos` blocks merge.
- Android changed: `CI / android (...)` blocks merge.
- Windows-relevant files changed: `CI / checks-windows (...)` blocks merge.
- Python skill scripts changed: `CI / skills-python` blocks merge.
- CI scope detector changed: `CI / ci-scope-tests` blocks merge.
- Workflow files changed: `Workflow Sanity / actionlint` and `CI / secrets`
  block merge; workflow-only edits do not fan out to product test lanes.
- Sandbox image files changed: `Sandbox Common Smoke / sandbox-common-smoke`
  blocks merge when that workflow runs.
- Non-doc install or Docker paths changed: `Install Smoke / install-smoke`
  blocks merge when that workflow runs.

Docs-only PRs should not wait for Node, macOS, Android, Windows, installer, or
sandbox jobs that did not run because they were irrelevant.

### Agent Duties

Agents should:

- Diagnose failed or missing relevant checks.
- Handle actionable review-bot comments.
- Push narrowly scoped fixes for failed CI.
- Report exact check names and statuses, not vibes.
- Ship runtime changes only after merge and only when explicitly requested.

Agents should not:

- Enable, disable, or mutate GitHub branch protection, rulesets, required
  checks, auto-merge, merge queue, or repository settings without explicit user
  approval.
- Make GitHub Copilot review a required merge approver.
- Treat queued, pending, skipped, or cancelled checks as passed.
- Merge draft PRs.
- Ship unmerged feature-worktree code into the shared runtime as a workaround
  for waiting on CI.

### Recommended GitHub Settings

Prefer GitHub auto-merge first. Do not enable merge queue until real PR
collision pain appears; merge queue adds overhead before it adds leverage.

Recommended `main` protection/ruleset shape:

- Require PR review before merge.
- Require branches to be up to date before merge if GitHub reports stale
  required checks.
- Require status checks `CI / pr-required` and `Workflow Sanity / actionlint`.
- Require conditional checks only through workflows that actually run for the
  changed paths. Do not require checks that are path-skipped on irrelevant PRs.
- Allow auto-merge.
- Keep merge queue disabled until collision rate justifies it.
- Keep settings mutation manual and explicit.
- Add an advisory branch ruleset that automatically requests GitHub Copilot
  review on new PRs targeting `main`, with draft PR and new-push re-review
  disabled at first. Copilot review should provide comments only; it must not
  satisfy or replace human approval.

Read-only observation on 2026-06-03 for `artemgetmann/openclaw`: classic branch
protection for `main` returned `Branch not protected`, repository rulesets
returned `[]`, and repository `allow_auto_merge` was `false`. That is observed
state, not permission to change it.

## Job Overview

| Job               | Purpose                                                 | When it runs                       |
| ----------------- | ------------------------------------------------------- | ---------------------------------- |
| `docs-scope`      | Detect docs-only changes                                | Always                             |
| `changed-scope`   | Detect which areas changed (node/macos/android/windows) | Non-doc changes                    |
| `check`           | TypeScript types, lint, format                          | Non-docs, node changes             |
| `check-docs`      | Markdown lint + broken link check                       | Docs changed                       |
| `ci-scope-tests`  | Focused tests for CI scope routing                      | CI scope detector changes          |
| `secrets`         | Detect leaked secrets                                   | Always                             |
| `build-artifacts` | Build dist once, share with `release-check`             | Pushes to `main`, node changes     |
| `release-check`   | Validate npm pack contents                              | Pushes to `main` after build       |
| `checks`          | Node tests + protocol check on PRs; Bun compat on push  | Non-docs, node changes             |
| `compat-node22`   | Minimum supported Node runtime compatibility            | Pushes to `main`, node changes     |
| `startup-memory`  | CLI startup memory regression check                     | Non-docs, node changes             |
| `skills-python`   | Python skill script lint and tests                      | Skill Python changes               |
| `checks-windows`  | Windows-specific tests                                  | Non-docs, windows-relevant changes |
| `macos`           | Swift lint/build/test + TS tests                        | PRs with macos changes             |
| `ios`             | iOS test placeholder                                    | Disabled in CI                     |
| `android`         | Gradle build + tests                                    | Non-docs, android changes          |
| `pr-required`     | Aggregate PR gate over scoped CI jobs                   | Pull requests                      |

## Fail-Fast Order

Jobs are ordered so cheap checks fail before expensive ones run:

1. `docs-scope` + `changed-scope` + `check` + `secrets` (parallel, cheap gates first)
2. PRs: `ci-scope-tests`, `checks` (Linux Node test split into 2 shards), `startup-memory`, `skills-python`, `checks-windows`, `macos`, `android`
3. PRs: `pr-required` validates that all jobs relevant to the detected scope passed
4. Pushes to `main`: `build-artifacts` + `release-check` + Bun compat + `compat-node22`

Scope logic lives in `scripts/ci-changed-scope.mjs` and is covered by unit tests in `src/scripts/ci-changed-scope.test.ts`.

## Runners

| Runner                          | Jobs                                             |
| ------------------------------- | ------------------------------------------------ |
| `ubuntu-latest`                 | CI Linux jobs and Workflow Sanity merge gates    |
| `windows-latest`                | `checks-windows`                                 |
| `macos-latest`                  | `macos`, `ios`                                   |
| `blacksmith-16vcpu-ubuntu-2404` | Non-required label/install/sandbox smoke helpers |

Critical PR merge gates should prefer GitHub-hosted runners. Custom runner pools
are useful for speed, but they must not be the only path for `CI / pr-required`
or `Workflow Sanity / actionlint`; if that pool stalls, merge safety becomes a
deadlock instead of a gate.

CI concurrency is scoped by commit SHA so a stale queued run cannot hold the PR's
merge gate hostage after a new commit is pushed.

`check-docs` runs formatting, markdown lint, glossary, and link checks for docs
changes. The consumer project-status freshness check runs only when
`docs/consumer/project-status.md` changes; stale product-tracker numbers should
not block unrelated documentation or CI-policy PRs.

## Local Equivalents

```bash
pnpm check          # types + lint + format
pnpm test           # vitest tests
pnpm check:docs     # docs format + lint + broken links
pnpm release:check  # validate npm pack
```
