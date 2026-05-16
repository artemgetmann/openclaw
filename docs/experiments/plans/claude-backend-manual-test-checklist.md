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
- Set the model before testing:

```text
/model claude-cli/sonnet
```

- Do not spend time on 1M context. That is a side quest, not the parity gate.
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

## Current Lane Status

- Skills: local proof passed, but still needs product-level user testing through
  the real bot path.
- Reminder: lower-level cron proof passed, but the product-level agent scheduling
  test still needs to pass.
- Progress UX: local projection passed, but the tester-runtime harness blocker
  may still need the progress lane fix before the manual tester proof is clean.
