# Repository workflow

This is the source of truth for local clones, worktrees, PR ownership, proof,
merge, and cleanup. The workflow has one primary owner. Native chat topology is
not part of correctness.

## One primary owner

One primary chat owns an issue end to end:

1. Understand the problem and declare scope and authority.
2. Create or adopt one feature worktree.
3. Implement the smallest coherent change.
4. Run focused executable proof.
5. Run `scripts/codex-review.mjs --base origin/main` when the PR touches risky
   operational, runtime, security, release, skill, prompt, or agent-bootstrap
   paths. Fix every P1/P2 finding before merge.
6. Push the exact head and let required GitHub CI run.
7. Reconcile current base, head, diff, review, and required checks.
8. Perform the normal non-admin merge when the task authority includes merge.
9. Perform only delivery actions already authorized for the task.
10. Leave valuable work committed and pushed so hourly worktree GC can clean
    eligible local artifacts later.

The primary owner does not create a tester chat, release chat, coordinator, or
callback chain merely to advance the normal PR. A short nested read-only review
or test is optional when independent scrutiny materially helps. It never owns
protected resources or external effects, and the primary owner remains
responsible for interpreting its result.

Do not use native thread creation, wake delivery, chat archival, or a local
conversation ledger as proof that source was reviewed, tested, or merged. The
durable proof surfaces are Git commits, the PR diff and body, Codex review
output, executable test output, required CI, and GitHub merge state.

## Authority boundaries

Normal source authority can include implementation, review, focused tests, CI
coordination, and a normal non-admin merge when the user asked to ship or merge.
It does not silently authorize:

- package, sign, notarize, publish, install, deploy, restart, or shared-runtime
  mutation;
- credentials, OTPs, billing, or new external access;
- destructive cleanup or irreversible data changes;
- live messages, live acceptance, or other user-visible external effects.

Ask only when one of those boundaries is missing, the requested behavior is
ambiguous, another owner overlaps the same source, or proof fails in a way that
cannot be repaired safely. Routine rebases, dependency installation, CI fixes,
review fixes, and normal merge mechanics are not reasons to return work to the
user.

An owner that was asked to ship end to end keeps going when another PR lands.
Fetch the new base, classify the drift, and resolve any in-scope conflict in the
same worktree. If the effective patch is unchanged and mainline drift touches
neither the PR paths nor merge-critical infrastructure, retain the existing
local review and focused proof; `scripts/pr merge-verify` already performs this
conservative classification for reference-documentation drift. Source or
unknown drift may affect a cross-file dependency, so sync it and repeat only
the affected review and proof, then continue through CI and merge.
Stop only when the intended behavior is genuinely ambiguous, a different live
owner is editing the same source, required authority is missing, or safe proof
cannot be produced. Do not ask the user to schedule routine merge order.

## Two-clone model

`~/Programming_Projects/openclaw` is the sacred home clone on `main`. It is the
pull-only runtime and release anchor. Do not implement feature changes there.
`~/Programming_Projects/openclaw-consumer` is a legacy emergency fallback, not
the default base for new work.

Create implementation worktrees from the sacred clone:

```bash
git -C ~/Programming_Projects/openclaw fetch origin main
git -C ~/Programming_Projects/openclaw worktree add \
  ~/.codex/worktrees/<id>/openclaw -b codex/<topic> origin/main
```

Before adopting an existing worktree, inspect its branch, HEAD, remotes, status,
and current owner. Do not overwrite another owner's edits or silently move an
existing branch. Independent worktrees may build and test concurrently; see
`fleet-resource-control.md` for the small set of exclusive operations.

## Branch and PR rules

- Target this fork's `main` for consumer-product and general fork work.
- Never merge `upstream/main` into a fork branch. Intake upstream selectively.
- Keep one coherent concern per PR.
- Open a draft PR early when the work is more than a trivial local edit.
- Use Conventional Commits and the repository commit template.
- Read `FORK_CONTRIBUTING.md` and `.github/pull_request_template.md` before
  opening or updating a fork PR.
- Record the exact head, base, changed paths, completed proof, remaining proof,
  scope boundary, and rollback in the PR body.
- Hash or compare the raw current PR diff when exact identity matters. Re-run
  review and behavior-bearing proof after behavior changes. A mechanical rebase
  only requires reconciling the effective patch and repeating proof affected by
  overlapping paths, dependencies, or merge-critical infrastructure.

## Review and proof

The default independent gates are Codex review plus required GitHub CI. Focused
local tests prove the changed behavior before broad remote suites consume time.

```bash
scripts/codex-review.mjs --base origin/main
```

The helper makes one bounded attempt. If it times out, do not loop. Record that
no verdict was produced, directly review the diff, and run the relevant
executable proof. If it reports that writable host context is required, rerun
the exact command once in authorized host context.

An optional nested read-only worker may inspect an immutable head or run a short
deterministic test. Do not delegate protected runtime, credentials, cleanup,
long waits, or external effects to it. Its completion is evidence, not a new
ownership system.

Before merge, verify:

- PR head equals the reviewed and tested head;
- the base is current or the effective patch remains understood after rebase;
- required CI is green;
- no unresolved P1/P2 finding remains;
- the PR is mergeable and dependencies landed in the intended order;
- the requested authority includes a normal merge.

Use normal GitHub merge mechanics without admin or branch-protection bypass.
After an ambiguous merge response, inspect PR and target-branch state before any
retry.

### GitHub transport fallback

Use host `gh` while its authenticated API probe is healthy. If the restricted
probe is indeterminate, repeat that read-only probe once in authorized host
context. If host `gh` is still unavailable and the installed GitHub connector
can read the required PR state, collect fresh secret-free connector evidence
with only the capabilities the operation needs. Verify it through the canonical
adapter before relying on the candidate:

```bash
OPENCLAW_GITHUB_REPOSITORY=owner/repo \
OPENCLAW_GITHUB_PR=123 \
scripts/github-connector-transport.mjs verify evidence.json
```

The adapter binds connector metadata to GitHub's public HTTPS metadata, remote
head and base refs, exact patch, and changed paths. A missing capability returns
a capability-specific blocker. Do not improvise credentials, copy secrets into
the evidence file, or treat connector authentication as blanket permission.

For an already-authorized normal merge, request the connector mutation only
after all review, proof, CI, ownership, and current-base gates pass:

```bash
OPENCLAW_GITHUB_REPOSITORY=owner/repo \
OPENCLAW_GITHUB_PR=123 \
scripts/github-connector-transport.mjs merge-request evidence.json EXPECTED_HEAD_SHA
```

Execute exactly the emitted connector tool and arguments. They bind the normal
squash merge to the expected head. After an ambiguous mutation, read PR state
once and stop without retrying. If the connector lacks the emitted operation,
use the reported next action; never fall through to a different mutation
transport in the same process.

## Delivery after merge

Source merge, package, installed runtime, public release, and end-user behavior
are separate receipts. Continue into later layers only when the current task
already authorizes them and follow their dedicated runbook:

- main Jarvis hotfix: `runtime-ops.md` and `scripts/ship-jarvis-hotfix.sh`;
- sendable macOS app: `apps/macos/README.md`;
- live Telegram proof: `telegram-live.md`;
- release/security work: `release-and-security.md`.

Apply the failure-surface decision rule in
`jarvis-delivery-boundary.md`. A bug reported on Artem's main Jarvis remains
open through installed adoption and one smallest symptom-specific acceptance.
Internal workflow, docs, CI, test infrastructure, and behavior-neutral
refactors normally stop at source proof. Do not deploy main Jarvis to validate
repository-only behavior, and do not expand a focused runtime acceptance into a
generic live suite.

Exclusive delivery operations use the narrow resource lane documented in
`fleet-resource-control.md`. The same primary owner may execute them; a separate
release chat is not required.

## Cleanup and recovery

Before ending, commit and push valuable work or state plainly why it remains
local. Never delete a worktree that contains the only copy of useful changes.

The hourly `ai.openclaw.worktree-gc` LaunchAgent owns eligible worktree and
artifact deletion. The primary chat should not spend its final turn manually
vacuuming routine worktrees. Operators can inspect the service with:

```bash
bash scripts/install-worktree-gc.sh status
```

Install or repair it only when explicitly operating workstation maintenance:

```bash
bash scripts/install-worktree-gc.sh install --interval-secs 3600
```

After command or API ambiguity, inspect state before retrying. Never repeat a
merge, deploy, restart, send, credential change, or destructive action merely
because the first response was unclear.

Do not use `safe to archive` as a synonym for shipped. Use the closeout labels
in `jarvis-delivery-boundary.md`; a main-Jarvis incident with pending installed
acceptance remains `BLOCKED — NOT YET ON MAIN JARVIS` even when its source PR is
merged.
