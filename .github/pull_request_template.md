## Summary

Describe the problem and fix in 2–5 bullets:

- Problem:
- Why it matters:
- What changed:
- What did NOT change (scope boundary):

## Change Type (select all)

- [ ] Bug fix
- [ ] Feature
- [ ] Refactor
- [ ] Docs
- [ ] Security hardening
- [ ] Chore/infra

## Scope (select all touched areas)

- [ ] Gateway / orchestration
- [ ] Skills / tool execution
- [ ] Auth / tokens
- [ ] Memory / storage
- [ ] Integrations
- [ ] API / contracts
- [ ] UI / DX
- [ ] CI/CD / infra

## PR Contract

- Closes #
- Related #
- Observable claim + acceptance criteria:
- Exact head SHA:
- Base branch + exact SHA:
- Diff fingerprint + changed paths:
- Primary owner: (chat/thread identity when useful)
- Codex review: (`PASS`, not required with rationale, or timeout plus direct-review receipt)
- Focused proof: (exact commands and outcomes on the exact head)
- Optional nested validation: (`None`, or exact read-only result)
- Required CI: (exact required check status)
- Base-drift recovery: (`None`, unchanged/disjoint + retained local proof + fresh required CI, or overlap + affected proof repeated)
- GitHub API mutation transport: (authenticated connector + expected head by default, or proven host-gh fallback; exactly one)
- Git object transport: (SSH fetch/push proof, or exact capability blocker)
- Dependencies / merge order / overlapping PRs: (`None — standalone` or exact refs + order)
- Proof still required after merge: (`None — source-only` or exact package/deploy/provider/backend/runtime/GUI/real-user work)
- Task-start delivery authority: (`source-only`, `exact-pr`, or `current-green-main`; list authorized mutation classes)

## Jarvis Delivery Boundary

Required when the title names Jarvis or the diff touches a direct Jarvis
product/app path. Generate a clean block with
`scripts/jarvis-delivery-boundary example --work-scope product-wide --delivery-target public-release`.
Paste its output here. For non-Jarvis work, write `Not required`.

## User-visible / Behavior Changes

List user-visible changes (including defaults/config).  
If none, write `None`.

## Security Impact (required)

- New permissions/capabilities? (`Yes/No`)
- Secrets/tokens handling changed? (`Yes/No`)
- New/changed network calls? (`Yes/No`)
- Command/tool execution surface changed? (`Yes/No`)
- Data access scope changed? (`Yes/No`)
- If any `Yes`, explain risk + mitigation:

## Repro + Verification

List only proof completed on the exact head above. Pending CI, package,
deployment, runtime, GUI, and real-user checks belong in the PR contract as
proof still required.

### Environment

- OS:
- Runtime/container:
- Model/provider:
- Integration/channel (if any):
- Relevant config (redacted):

### Steps

1.
2.
3.

### Expected

-

### Actual

-

## Evidence

Attach at least one:

- [ ] Failing test/log before + passing after
- [ ] Trace/log snippets
- [ ] Screenshot/recording
- [ ] Perf numbers (if relevant)

## Human Verification (required)

What you personally verified (not just CI), and how:

- Verified scenarios:
- Edge cases checked:
- What you did **not** verify:

## Review Conversations

- [ ] I replied to or resolved every bot review conversation I addressed in this PR.
- [ ] I left unresolved only the conversations that still need reviewer or maintainer judgment.

If a bot review conversation is addressed by this PR, resolve that conversation yourself. Do not leave bot review conversation cleanup for maintainers.

## Compatibility / Migration

- Backward compatible? (`Yes/No`)
- Config/env changes? (`Yes/No`)
- Migration needed? (`Yes/No`)
- If yes, exact upgrade steps:

## Failure Recovery (if this breaks)

- How to disable/revert this change quickly:
- Files/config to restore:
- Known bad symptoms reviewers should watch for:

## Risks and Mitigations

List only real risks for this PR. Add/remove entries as needed. If none, write `None`.

- Risk:
  - Mitigation:
