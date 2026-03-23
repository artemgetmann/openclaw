# Consumer Parallel Agent Prompts

Use these prompts only after creating new worktrees from:

- `codex/consumer-openclaw-project`

Goal:

- parallelize follow-up work without overlapping write scopes
- keep `codex/consumer-openclaw-project` as the only consumer trunk
- avoid cross-branch confusion and merge-chaos

## Worktree Creation

Example pattern:

```bash
git fetch origin
git worktree add ../openclaw-consumer-general origin/codex/consumer-openclaw-project
git worktree add ../openclaw-consumer-telegram origin/codex/consumer-openclaw-project
git worktree add ../openclaw-consumer-skills origin/codex/consumer-openclaw-project
git worktree add ../openclaw-consumer-menubar origin/codex/consumer-openclaw-project
```

In each worktree:

```bash
git checkout -b codex/<short-task-name>
```

## Agent 1: General Pane Health

Write scope:

- `apps/macos/Sources/OpenClaw/GeneralSettings.swift`
- health-check helper files directly used by the General pane
- consumer-only gateway status plumbing

Do not touch:

- Telegram bootstrap templates
- menubar navigation files
- docs unless needed for a short tracker note

Prompt:

```text
You are working in a dedicated worktree from codex/consumer-openclaw-project.

Task:
- Fix the consumer General pane so it probes the consumer gateway only.
- Remove stale/global gateway lies from the consumer app.

Context:
- The consumer app sometimes shows General red while Channels -> Telegram shows Running.
- Consumer runtime should use the consumer gateway lane, not the legacy/global OpenClaw gateway.
- User-facing goal: if consumer Telegram is healthy, General should not claim the gateway is dead because it read the wrong process or stale state.

Constraints:
- Stay inside the General-pane / consumer-gateway-health write scope only.
- Do not touch menubar UX, Telegram onboarding copy, or template personality files.
- Add logs/diagnostics only if they help isolate consumer-vs-global gateway confusion.
- Run focused validation before finishing.

Deliverable:
- code changes
- exact files changed
- what was wrong
- how you verified it
```

## Agent 2: Telegram Consumer Reply Cleanup

Write scope:

- `docs/reference/templates/BOOTSTRAP.md`
- `docs/reference/templates/IDENTITY.md`
- `docs/reference/templates/USER.md`
- `apps/macos/Sources/OpenClaw/AgentWorkspace.swift`
- Telegram/bootstrap consumer reply logic files only if directly needed

Do not touch:

- `SOUL.md` unless absolutely necessary
- menubar files
- General pane files

Prompt:

```text
You are working in a dedicated worktree from codex/consumer-openclaw-project.

Task:
- Clean up the remaining consumer bootstrap/dev-language leaks in the Telegram first-run flow.

Context:
- Consumer Telegram onboarding now works end-to-end.
- Remaining issues:
  - consumer bootstrap should not mention Git/repos/commits/workspace internals
  - first-run flow should stay simple and non-technical
  - name suggestions from Telegram metadata should remain deterministic when metadata exists

Constraints:
- Keep Jarvis personality intact.
- Do not flatten the bot into generic assistant sludge.
- Avoid broad personality rewrites.
- Stay inside consumer bootstrap / AgentWorkspace / template write scope.
- If you touch template text, keep changes minimal and intentional.

Deliverable:
- code/template changes
- exact files changed
- before/after behavior summary
- verification steps
```

## Agent 3: Bundled Skills Audit

Write scope:

- consumer docs/plans/tracker
- consumer bootstrap skill allowlist code/config
- no app-shell UI edits

Do not touch:

- General pane
- menubar shell
- Telegram onboarding UI files

Prompt:

```text
You are working in a dedicated worktree from codex/consumer-openclaw-project.

Task:
- Audit bundled skills for the consumer product and propose/add missing high-value defaults.

Context:
- Current consumer bootstrap seeds a curated bundled-skill allowlist.
- User believes some personally useful skills (example: himalaya) may still be missing.
- Goal is not "bundle everything"; goal is "bundle the useful defaults for first consumer value."

Constraints:
- Focus on audit + targeted allowlist additions only.
- Do not edit unrelated app UI.
- If you add skills, explain why each one belongs in consumer defaults.
- Keep docs/tracker current.

Deliverable:
- current bundled skill list
- recommended additions/removals with rationale
- code/doc changes if appropriate
- exact files changed
- verification steps
```

## Agent 4: Menubar / App Shell Consumer Audit

Write scope:

- menubar entrypoint files
- consumer-only shell/navigation files
- docs/tracker notes

Do not touch:

- General pane health logic
- Telegram bootstrap/template files
- skill allowlist logic

Prompt:

```text
You are working in a dedicated worktree from codex/consumer-openclaw-project.

Task:
- Audit the consumer menubar/app-shell for remaining developer-facing UX and produce/implement low-risk cleanup.

Context:
- Local chat entrypoints were intentionally removed for MVP.
- User still wants the menubar app to feel product-like, not developer-tool-like.
- GUI control stability is tracked separately and is not the primary task here.

Constraints:
- Stay inside menubar/app-shell UX scope.
- Do not reintroduce local chat for consumer.
- Prefer low-risk cleanup over broad redesign.
- Track any deferred issues instead of half-solving them.

Deliverable:
- list of remaining consumer-shell UX issues
- any low-risk fixes implemented
- exact files changed
- what should stay deferred
```

## Coordination Rules

- One agent per worktree.
- One worktree per scoped task.
- If a task needs to touch another scope's files, stop and report it instead of freelancing.
- Merge/cherry-pick results back into `codex/consumer-openclaw-project` one at a time.
- After each agent finishes:
  - review changed files
  - run focused validation
  - only then integrate
