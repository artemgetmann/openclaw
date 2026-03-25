# Workflow

## Branch and PR targets

- Default to this fork, not upstream.
- Consumer-product work targets `codex/consumer-openclaw-project`.
- General fork work that is not consumer-product work targets this repo's `main`.
- Use upstream `https://github.com/openclaw/openclaw` only when the user explicitly asks for upstream review, triage, or PR flow.
- `consumer` is legacy. Do not target new PRs there unless the user explicitly asks.

## GitHub footguns

- For issue comments, PR comments, and review bodies, use literal multiline strings or a single-quoted heredoc. Do not embed `\n`.
- Do not use `gh issue/pr comment -b "..."` when the body contains shell characters or backticks. Use `-F - <<'EOF'`.
- Do not wrap issue or PR refs like `#24643` in backticks when you want auto-linking.
- When searching issues or PRs broadly, keep paginating until you reach the end. Do not assume the first page or first 500 results is enough.

## Commits and PRs

- Use `scripts/committer "<message>" <file...>` for commits so staging stays scoped.
- Use Conventional Commits and include a bullet body for what, why, and risk.
- Group related changes. Do not bundle unrelated refactors.
- If the task is a bug-fix PR, require proof:
  - Symptom evidence
  - Root cause in code with file and line
  - Fix touching that code path
  - Regression proof or explicit manual validation notes
- Before `/landpr`, run `/reviewpr`.

## Multi-agent safety

- Do not use `git stash` unless the user explicitly asks.
- Do not switch branches or modify worktrees unless the user explicitly asks.
- Leave unrelated edits alone. Focus on your own diff.
- If formatting-only churn appears around your changes, fold it in without turning it into a separate drama.
