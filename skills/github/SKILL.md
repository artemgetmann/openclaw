---
name: github
description: "GitHub API and PR lifecycle operations. Prefer an installed GitHub connector for supported metadata, comments, reviews, checks, refs, and expected-head merges; use host `gh` only as a proven capability fallback. Keep local Git on SSH for commits, diffs, fetches, and pushes."
metadata: { "openclaw": { "emoji": "🐙" } }
---

# GitHub Skill

Use the installed GitHub connector for supported API operations. Use host `gh`
only when the connector lacks the required capability and a secret-free
authenticated API probe succeeds.

## Transport Policy

- Connector API health, host `gh` API health, and Git fetch/push health are
  separate states. Never report GitHub unavailable because only one failed.
- Local Git remains authoritative for commits, diffs, rebases, and object
  upload. Use SSH GitHub remotes by default.
- Select failover by operation capability. After an ambiguous mutation, read
  the authoritative remote state before any retry and never silently switch
  transports.

## When to Use

✅ **USE this skill when:**

- Checking PR status, reviews, or merge readiness
- Viewing CI/workflow run status and logs
- Creating, closing, or commenting on issues
- Creating or merging pull requests
- Querying GitHub API for repository data
- Listing repos, releases, or collaborators

## When NOT to Use

❌ **DON'T use this skill when:**

- Local git operations (commit, push, pull, branch) → use `git` directly
- Non-GitHub repos (GitLab, Bitbucket, self-hosted) → different CLIs
- Cloning repositories → use `git clone`
- Reviewing actual code changes → use `coding-agent` skill
- Complex multi-file diffs → use `coding-agent` or read files directly

## Capability Check

```bash
# Host gh fallback proves API access, not Git push access.
gh api user --jq .login

# Git transport proves remote object access, not API capability.
git remote get-url origin
git ls-remote --exit-code origin HEAD
```

Do not reauthenticate, log out, delete credentials, or change remotes merely
because one read-only probe fails. Use the repository's preflight helper when
available.

## Host `gh` Fallback Commands

### Pull Requests

```bash
# List PRs
gh pr list --repo owner/repo

# Check CI status
gh pr checks 55 --repo owner/repo

# View PR details
gh pr view 55 --repo owner/repo

# Create PR
gh pr create --title "feat: add feature" --body "Description"

# Merge PR
gh pr merge 55 --squash --repo owner/repo
```

### Issues

```bash
# List issues
gh issue list --repo owner/repo --state open

# Create issue
gh issue create --title "Bug: something broken" --body "Details..."

# Close issue
gh issue close 42 --repo owner/repo
```

### CI/Workflow Runs

```bash
# List recent runs
gh run list --repo owner/repo --limit 10

# View specific run
gh run view <run-id> --repo owner/repo

# View failed step logs only
gh run view <run-id> --repo owner/repo --log-failed

# Re-run failed jobs
gh run rerun <run-id> --failed --repo owner/repo
```

### API Queries

```bash
# Get PR with specific fields
gh api repos/owner/repo/pulls/55 --jq '.title, .state, .user.login'

# List all labels
gh api repos/owner/repo/labels --jq '.[].name'

# Get repo stats
gh api repos/owner/repo --jq '{stars: .stargazers_count, forks: .forks_count}'
```

## JSON Output

Most commands support `--json` for structured output with `--jq` filtering:

```bash
gh issue list --repo owner/repo --json number,title --jq '.[] | "\(.number): \(.title)"'
gh pr list --json number,title,state,mergeable --jq '.[] | select(.mergeable == "MERGEABLE")'
```

## Templates

### PR Review Summary

```bash
# Get PR overview for review
PR=55 REPO=owner/repo
echo "## PR #$PR Summary"
gh pr view $PR --repo $REPO --json title,body,author,additions,deletions,changedFiles \
  --jq '"**\(.title)** by @\(.author.login)\n\n\(.body)\n\n📊 +\(.additions) -\(.deletions) across \(.changedFiles) files"'
gh pr checks $PR --repo $REPO
```

### Issue Triage

```bash
# Quick issue triage view
gh issue list --repo owner/repo --state open --json number,title,labels,createdAt \
  --jq '.[] | "[\(.number)] \(.title) - \([.labels[].name] | join(", ")) (\(.createdAt[:10]))"'
```

## Notes

- Always specify `--repo owner/repo` when not in a git directory
- Use URLs directly: `gh pr view https://github.com/owner/repo/pull/55`
- Rate limits apply; use `gh api --cache 1h` for repeated queries
