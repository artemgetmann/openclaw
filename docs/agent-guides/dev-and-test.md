# Development and testing

## Baseline

- Runtime baseline: Node 22+.
- Install deps with `pnpm install`.
- Prefer Bun for TypeScript execution and local scripts.
- For repo-pinned CLI runs, prefer `pnpm openclaw:local ...`.

## Common commands

- Build: `pnpm build`
- Lint and format checks: `pnpm check`
- Tests: `pnpm test`
- Coverage: `pnpm test:coverage`
- TypeScript checks: `pnpm tsgo`

## Validation default

- Unless the user explicitly scopes validation narrower, the baseline is:
  - `pnpm build`
  - `pnpm check`
  - `pnpm test`
- For targeted tests, keep using the wrapper:
  - `pnpm test -- <path-or-filter> [vitest args...]`
- Do not set test workers above 16.

## Runtime proof ladder

Use the lowest layer that proves the behavior under test.

1. Unit or integration tests:
   - Use for pure state, parser, tool contract, prompt-section, and gateway
     method behavior.
   - This is the default first proof for goal/session/tool changes.
2. OpenClaw CLI against an isolated gateway:
   - Use for runtime catalog, gateway method, session store, monitor, cron, and
     tool execution proof.
   - Prefer this when the behavior does not require an interactive model turn.
3. OpenClaw TUI against the same isolated gateway:
   - Use for agent-behavior proof: prompt following, tool choice, natural
     language UX, escalation, and evaluator behavior.
   - This proves the OpenClaw agent path without Telegram transport noise.
4. Channel proof, such as Telegram:
   - Use only when channel behavior itself is under test, or after tests plus
     CLI/TUI proof pass and you still need transport or mobile UX proof.
   - Telegram is useful for final user-visible confidence, but it is a poor
     first debugger for general agent behavior because bot ownership, message
     delivery, chat history, and runtime routing can all create false failures.

When validating unmerged code, every runtime proof above must use an isolated
profile, config, state directory, and non-default gateway port. Do not point the
shared main gateway or primary bot at a feature worktree.

## Dependency and command failures

- If a requested build, lint, or test command fails because deps are missing, run the repo install command once, then rerun the exact command once.
- If it still fails, report the exact command and first actionable error.

## Code style guardrails

- TypeScript ESM, strong typing, avoid `any`.
- Never add `@ts-nocheck`.
- Do not mix static and dynamic imports for the same production module path.
- Do not share behavior through prototype mutation. Use explicit inheritance or composition.
- Add short comments for tricky logic.
- Keep files small enough to understand quickly; split when it helps clarity.

## Deeper references

- `docs/help/testing.md`
- `.agents/skills/PR_WORKFLOW.md`
