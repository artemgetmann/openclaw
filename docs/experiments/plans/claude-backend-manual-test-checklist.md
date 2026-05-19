# Claude Backend Manual Test Checklist

## Purpose

Manual product-level verification for Claude CLI backend parity after merge and
runtime restart.

This is not another script-proof checklist. The goal is to prove Jarvis can use
the Claude CLI backend in the real product path without losing expected skills,
reminder behavior, or visible progress UX.

## Preflight

- Use the tester bot first where available.
- Use main Jarvis only after the Claude backend change is merged and the runtime
  has been restarted onto that merge.
- As of 2026-05-19, main Jarvis is already fast-forwarded to `origin/main`
  (`92a03de8ca`) and the shared LaunchAgent is running from
  `~/Programming_Projects/openclaw` with app-owned state under
  `~/Library/Application Support/OpenClaw/.openclaw`.
- Set the model before testing:

```text
/model claude-cli/sonnet
```

- Do not spend time on 1M context. That is a side quest, not the parity gate.
- Do not block this smoke on progress UX. Progress polishing is a separate lane.
- Capture evidence while testing. Screenshots or copied Telegram output are
  fine; exact prompts and observed output matter more than polish.

## Evidence Fields

Fill this in for each test.

```text
Date/time:
Bot/runtime:
Model:
Prompt sent:
Observed output:
Pass/fail:
Follow-up lane:
```

## Skills Test

Purpose: prove product-level skill selection, not just script or argv wiring.

Copy/paste prompt:

```text
Use the Reddit skill naturally on this Reddit link, read the content, and summarize the important points. End with exactly: CLAUDE_SKILLS_REDDIT_TESTER_CHECK_20260516

<paste Reddit link here>
```

Pass criteria:

- The response does not say the Reddit skill is missing or unavailable.
- The agent uses or mentions the Reddit skill, or produces a result consistent
  with reading the Reddit content through that skill.
- The summary reflects the linked Reddit content, not a generic guess.
- The final response includes exactly:

```text
CLAUDE_SKILLS_REDDIT_TESTER_CHECK_20260516
```

Fail criteria:

- It only explains how it would use Reddit.
- It asks the user to run a separate command.
- It says the skill is missing when the runtime should expose it.
- It returns a generic answer that does not prove the link was read.

## Reminder Test

Purpose: prove the agent can schedule and later execute the reminder through the
product path. Do not add cron manually.

Copy/paste prompt:

```text
In one minute go to my Twitter profile, click on the first post, and check the first comment.
```

Pass criteria:

- The agent schedules the reminder itself.
- A later agent turn executes without the user running a manual cron command.
- Social actions stay read-only.
- The delivered result includes actual first-comment details, not just "done" or
  "I checked."

Fail criteria:

- The user has to add or edit cron manually.
- The agent forgets the scheduled task.
- The later turn only reports that it cannot browse without trying the available
  product path.
- The result lacks concrete first-comment details.

## Progress UX Test

Purpose: prove visible progress appears automatically for a multi-step task,
without asking for progress updates.

Copy/paste prompt:

```text
Do a slow visible multi-step task. First fetch example.com, then fetch the IANA example domains page, then summarize what changed between the two pages. End with exactly: CLAUDE_PROGRESS_UX_TESTER_CHECK_20260516
```

Pass criteria:

- Progress previews appear automatically during the task.
- Progress previews are separated cleanly with blank lines.
- The final response retains progress context above or alongside the answer.
- The final response includes exactly:

```text
CLAUDE_PROGRESS_UX_TESTER_CHECK_20260516
```

Fail criteria:

- No visible progress appears before the final answer.
- Progress output is mashed into the final answer without readable separation.
- The final response loses the progress context entirely.
- The final marker is missing or altered.

## Main Bot Smoke After Restart

Purpose: this is main-bot acceptance testing, not final broad release. Do this
only after the main Jarvis runtime is restarted from updated `main`.

1. Send:

```text
/status
```

Check:

- Model list contains Claude CLI options.
- Current model is expected.
- Normal Claude CLI context is `200k` unless an explicit `[1m]` model is
  selected.

2. Send:

```text
/model claude-cli/sonnet
```

Check:

- Accepted.
- No `model not allowed` error.

3. Send:

```text
What prompt/source files do you see as authoritative for this Telegram session?
```

Check:

- OpenClaw workspace/app support files are treated as authority.
- `~/.claude` may be visible as Claude-native context, but should not be treated
  as OpenClaw authority.

4. Send:

```text
draft a tweet in my tone of voice about moving from codex cli to codex app
```

Check:

- Uses Artem's tone skill without being spoon-fed.
- Does not say it has no tone context.

5. Send:

```text
remind me in 1 min to test claude cli reminders
```

Check:

- Says scheduled only if it actually scheduled.
- Wakes back up around one minute later.
- Sends the reminder in the same Telegram chat/topic.

6. Send:

```text
summarize this reddit thread and explain your process after done: <url>
```

Check:

- Uses the Reddit/OpenClaw skill path or clearly explains the equivalent process.
- No message spam.

7. Optional 1M side check:

```text
/model claude-cli/opus[1m]
/status
```

Check:

- Model is accepted only if Claude Code supports it on this machine/account.
- `/status` reports about `1M` context only for explicit `[1m]` models.
- Do not use `claude-cli/sonnet[1m]` as the preferred 1M smoke on this account:
  prior proof showed Sonnet 1M can select/report but execution requires
  Anthropic extra-usage entitlement here. Use Opus 1M for the no-extra-usage
  1M side check.

## Claude Model List Policy

Current product rule:

- Founder/main bot may keep the broader Claude CLI set while acceptance testing
  continues. That can include `claude-cli/sonnet`, `claude-cli/opus`, and
  `claude-cli/opus[1m]`.
- Consumer product surfaces should not expose the full experimental Claude CLI
  matrix. Keep the consumer picker small and boring.
- Do not promote `claude-cli/sonnet[1m]` for this account or for consumers.
  It can select/report in some paths, but real execution requires Anthropic
  extra-usage entitlement here.
- Prefer `claude-cli/opus[1m]` as the only explicit 1M Claude CLI option where
  1M is exposed at all.
- Hide Claude CLI rows entirely for consumer users until local Claude Code is
  installed, authenticated, and intentionally enabled.

Recommended consumer-facing Claude set after the smoke passes:

- one normal Claude CLI row, preferably `claude-cli/sonnet`, labelled as local
  Claude Code / 200k context
- one advanced 1M row, `claude-cli/opus[1m]`, behind an advanced/more surface
- no `haiku` rows, no `sonnet[1m]` row, and no duplicate version aliases in the
  default consumer picker

Recommendation:

- Merge/restart is acceptable if this is treated as main-bot acceptance testing,
  not final broad release.
- Do not broaden/default-expose Claude CLI until this manual smoke passes.
- If reminder wakeup fails again, make that blocker #1. That is a trust issue,
  not polish.

## Current Lane Status

- Skills: product-level OpenClaw CLI proof passed on `claude-cli/sonnet` using
  the exact Reddit URL
  `https://www.reddit.com/r/codex/comments/1swq4g4/what_theme_do_you_use_in_codex_app/`.
  Claude read the OpenClaw `reddit` skill instructions, used
  `skills/reddit/scripts/reddit.mjs comments`, summarized the post/comments, and
  confirmed in a same-session follow-up that it used the Reddit skill.
- Reminder: tester Telegram proof passed on `@Artem_jarvis_email_bot` with the
  natural prompt `in one minute go to my Twitter profile, click on the first
post, and check the first comment`. Telegram message `49433` scheduled cron
  job `a6a44bb6-90e6-4bd2-9147-c53a75433942`, bot reply `49434` confirmed
  scheduling, delayed run executed as `provider=claude-cli model=sonnet`, and
  final Telegram message `49435` delivered the first-comment result.
- Progress UX: intentionally out of the current acceptance gate. Keep it in the
  separate progress lane; do not block the Claude CLI backend smoke on it.
