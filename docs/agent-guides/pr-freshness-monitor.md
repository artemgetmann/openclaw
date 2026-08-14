# Artem PR freshness monitor

This private automation checks `artemgetmann/openclaw` without changing a branch or pull request. `scripts/pr-freshness-monitor.mjs` emits bounded JSON; an existing Jarvis cron `agentTurn` interprets only its `transitions` and announces useful changes to the dedicated Jarvis Lab forum topic. Output contains PR numbers and state transitions, never PR bodies or titles.

The default active window is seven days. Drafts and stale PRs are excluded unless the PR has the `pr-freshness-monitor` label or auto-merge is armed. The script reports transitions into required-CI failure, relevant base drift/conflict, blocked merge readiness, merge readiness, or merged state. Unchanged and still-pending CI stays silent.

Use a 30-minute cron cadence. Pin these instructions in the job: run the script from the installed OpenClaw repository and parse its single JSON line. If `ok=false`, report the bounded operational failure. Otherwise return `HEARTBEAT_OK` when `changed=false`, and summarize only the listed transitions when `changed=true`. Never run git mutation commands or GitHub mutations. Deliver with `mode=announce`, `channel=telegram`, and `to=<jarvis-lab-chat-id>:topic:<topic-anchor>`.

State defaults to `$OPENCLAW_STATE_DIR/cron/pr-freshness-state.json`. Override it with `--state-file` for tests or recovery. A GitHub read failure exits non-zero and does not replace the last good state.

Rollback: remove or disable the cron job, then optionally trash only its state file. Reverting the source PR removes the checker but does not remove an already-installed cron job.
