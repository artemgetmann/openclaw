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

- `docs/testing.md`
- `.agents/skills/PR_WORKFLOW.md`
