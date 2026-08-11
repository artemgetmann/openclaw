# Fork PR Guide

Use this file when the PR target is the fork `artemgetmann/openclaw` and the base branch is either:

- `main`
- `codex/consumer-openclaw-project`

For upstream PRs to `openclaw/openclaw`, use `CONTRIBUTING.md` instead.

This fork guide exists for one reason: fast founder review. The upstream template is useful for broad OSS hygiene, but it is too noisy for day-to-day fork work where the change is usually discussed, implemented, and live-tested in the same loop.

## PR Goal

Make the PR easy to review in under two minutes.

The reviewer should be able to answer:

1. What observable claim and acceptance criteria does this PR own?
2. What exact current-head proof shows it worked?
3. Did focused proof, required CI, and required Codex review pass on this head?
4. What must merge before or after it, and what overlaps?
5. What proof, cleanup, or rollback remains?
6. What still hurts?

If the PR body does not answer those questions immediately, it is not ready.

## Required Top Block

Every fork PR should start with this section:

```md
## Review Fast Path

- Observable claim + acceptance criteria:
- Exact head + builder proof:
- Review + proof: (Codex verdict when required, focused commands, and required CI)
- Jarvis delivery boundary: (validated receipt, or `Not required` for non-Jarvis work)
- Merge owner: (primary chat + normal non-admin merge authority)
- Dependencies / merge order / overlap:
- Remaining proof / cleanup / rollback:
- Still hurts:
```

Write this in plain language. Keep it tight. No filler. Use
`None — standalone` only when there are no dependencies or overlapping PRs.
Use `None — source-only` only when no package, deployment, runtime, GUI,
provider/backend, real-user, or cleanup proof remains.

Examples:

- `Telegram token verify -> first DM capture -> first reply starts -> reply lands in same DM`
- `runtime_ownership=ok`, real smoke passed, reply text returned
- `isolated Telegram lane no longer reuses shared OAuth refresh state`

## Recommended PR Shape

After `Review Fast Path`, keep the body to a few short sections:

```md
## Why This Matters

- ...

## Scope Boundary

- ...

## Verification

- ...

## AI Assistance

- AI-assisted
- Testing degree:
```

That is usually enough for fork PRs.

Do not blindly paste the full upstream PR template into fork PRs unless the target reviewer explicitly wants it.

## Verification Rules

Fork PRs should include exact proof, not vague confidence language.
`Proof` contains only checks completed on the stated head. Keep pending CI,
package, deployment, runtime, GUI, and real-user work in the remaining-proof
field; keep provider/backend health there too, and never present pending work as
proof.

Jarvis behavior PRs must also carry the JSON receipt from
`docs/agent-guides/jarvis-delivery-boundary.md`. The receipt is classification
and proof state, not another essay; CI validates it when the PR opens.

For ownership, use `docs/agent-guides/workflow.md` as the source of truth. For
CI and merge mechanics, use `docs/ci.md`. One primary chat owns diagnosis,
implementation, review fixes, proof, and the normal non-admin merge when
authorized. Runtime shipping remains separate and happens only when explicitly
requested.

Good proof:

- exact runtime ownership lines
- exact smoke command names
- exact test command names
- exact observed reply text or user-visible result
- exact blocker if live validation could not complete

Bad proof:

- `should work`
- `tested locally`
- `seems fixed`
- giant log dumps with no interpretation

## Scope Discipline

Fork PRs should stay focused on one user path or one operational hardening step.

State the boundary explicitly:

- what changed
- what did not change
- what pain still remains

If the branch mixes unrelated fixes, split it.

## Founder Review Mode

When the change was already discussed and live-tested in the same loop, review should be fast.

Default review flow:

1. Read `Review Fast Path`.
2. Confirm the proof is specific.
3. Skim only the risky files.
4. Merge.

## Codex Review Sidecar

Use the bounded Codex review helper as a parallel sidecar for risky fork PRs.
Do not turn it into a blocker for every typo fix:

```bash
scripts/codex-review.mjs --base origin/main
```

The helper makes one attempt with a 10-minute deadline. If it times out, do not
retry automatically or keep the shipping lane blocked. Record that no verdict
was produced, then finish a direct diff review and the relevant executable
proof. A timeout is not a clean Codex review.

Codex review also requires writable host Codex state. When the helper exits `75`
with `CODEX_REVIEW_PREFLIGHT status=host_context_required`, rerun the exact
command once outside the restricted sandbox. Do not retry any other failure, and
if that one host-context attempt fails, stop and report the failure instead of
looping or weakening the sandbox.

Run it before or during merge flow when a PR touches:

- release or launch tooling
- runtime ownership, shared state, launchd, gateway ownership, or port selection
- auth, token storage, or secret handling
- bundled skills, tool execution, or agent bootstrap paths
- operational tooling that can silently change how work gets shipped or verified

If `codex review` finds a P1 or P2 before merge, fix it before merge. If it
finishes after merge, open the follow-up PR immediately. Trivial docs, chore,
and typo PRs may skip it by reviewer judgment so the founder loop stays fast.

## Files That Always Deserve a Real Look

Even in fast review mode, slow down if the PR touches:

- `AGENTS.md`
- `CLAUDE.md`
- prompt/bootstrap/system-prompt files
- auth/token storage
- runtime ownership, launch, or port selection
- scripts that assign or release Telegram bot claims
- shared-state fallback logic

These files can create fake-success bugs even when the surface behavior looks fine.

## AI Assistance Note

Keep this minimal:

- `AI-assisted`
- testing degree: `untested`, `targeted`, or `live-tested`

No essay needed.
