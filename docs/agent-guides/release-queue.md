# Replaceable PR release operators

This queue lets builders work in parallel while keeping the final merge step
safe. GitHub and the repo-backed queue are authoritative. Codex callbacks are
only wake signals; a missing callback never changes ownership or merge order.

## The simple model

- Builders own source changes and fixes but cannot approve or release their own work.
- A distinct code reviewer records an exact-head review receipt before testing.
- A fresh read-only tester records independent exact-head proof.
- A constrained release executor performs only verified mechanical actions.
- A builder submits one immutable packet after review and tester gates pass.
- Any distinct release executor may inspect and claim the queue. A native Codex
  thread is optional visibility, not ownership or correctness.
- Only one operator may hold the merge lease at a time.
- The lease expires, so a vanished operator is replaceable.
- Each successful merge is recorded before the next PR is claimed.

These identities, receipts, terminal states, expiry, recovery, and duplicate
prevention live in the queue. Executors may be subagents or other replaceable
agents. Native Codex threads are optional visibility and steering only.

Routine merge mechanics use the `routine-release` capability tier. Ambiguity,
conflicts, serious findings, or source repair require `reasoning-escalation`.
These are capability contracts, not hard-coded models.

## Rollout and graduation

The queue state owns rollout policy. `scripts/pr-release-queue status` reports
`dogfood` progress, a concrete `paused` reason, or terminal `graduated` state.
After graduation, agents stop carrying the temporary dogfood reminder.

Graduation requires three unique real source merges. The count is recomputed
from terminal receipts that bind the immutable candidate, closed tester PASS,
accepted lifecycle contract, normal non-admin expected-head merge, landed-tree
equality, and target ancestry. Failed, cancelled, superseded, simulated,
incomplete, admin, or bypass work never counts. Duplicate copies of one receipt
remain one success.

`record-merge` first appends the complete merge receipt, then recomputes rollout
in the same queue commit. The third release therefore finishes under dogfood
semantics and only its durable terminal receipt makes graduation authoritative.
The cached successful-PR list is mechanically checked against receipts. When
qualifying authoritative receipts extend a stale cache, the queue safely
rebuilds that cache and continues; repeating reconciliation is idempotent. A
cache that claims an unverified success, malformed cache state, conflicting
receipt identity, or incomplete proof still pauses instead of promoting.
`reconcile-rollout` migrates legacy schema-1 state, heals benign drift, and
durably records a currently reproducible pause.

Source work and read-only testing remain parallel. Merges serialize because
`main` changes after each merge and the next candidate must be reconciled
against that new truth.

## What decides order

Builders declare only semantic dependencies they know from the feature:
`requires`, `before`, `after`, or `incompatible`, with a plain-language reason.

The release operator records blockers learned from current state, including
base drift, mergeability, checks, reviews, changed-path overlap, or an active
runtime/deployment lock. Changed-path overlap is a warning, not proof of a
dependency. Disjoint PRs keep building and testing in parallel.

If neither declared dependencies nor current GitHub state determines a safe
order, record a `decision-required` blocker and ask Artem. Do not guess.

## Immutable release packet

Submit a JSON file with this shape:

```json
{
  "schemaVersion": 1,
  "candidate": {
    "pr": 123,
    "url": "https://github.com/artemgetmann/openclaw/pull/123",
    "headSha": "40 hex characters",
    "baseBranch": "main",
    "testedBaseSha": "40 hex characters",
    "diffFingerprint": "sha256:64 hex characters",
    "changedPaths": ["src/example.ts"]
  },
  "builder": {
    "threadId": "builder thread",
    "hostId": "builder host",
    "wakeRoute": { "threadId": "builder thread", "hostId": "builder host" }
  },
  "testerReceipt": {
    "status": "PASS",
    "headSha": "same candidate head",
    "diffFingerprint": "same candidate diff",
    "closure": "archived"
  },
  "reviewReceipt": {
    "role": "code-reviewer",
    "status": "PASS",
    "headSha": "same candidate head",
    "diffFingerprint": "same candidate diff",
    "unresolvedFindings": []
  },
  "capabilityPolicy": {
    "routine": "routine-release",
    "escalation": "reasoning-escalation"
  },
  "authority": {
    "source": "builder-handoff",
    "scope": "PR #123 source merge only",
    "allowedActions": ["normal-merge"],
    "constraints": ["no admin or bypass"]
  },
  "declaredDependencies": [{ "pr": 122, "relation": "requires", "reason": "uses its new contract" }]
}
```

The queue rejects a stale review or tester receipt, unresolved high or critical
review findings, or authority beyond normal merge and
an optional explicitly authorized deploy. Deploy authority never implies
credentials, packaging, publication, restart, or another external action.

## Operator commands

The state branch is `ops/release-state`. Initialize it once, then enqueue and
claim work:

```bash
scripts/pr-release-queue init
scripts/pr-release-queue enqueue --packet /path/to/packet.json
scripts/pr-release-queue explain-order
scripts/pr-release-queue claim --thread-id "$THREAD_ID" --host-id "$HOST_ID"
```

Every mutation accepts `--transaction-id`. Callers should provide a stable ID
for one logical attempt. A failed or ambiguous GitHub ref update is reconciled
once by that ID and is never blindly retried.

The claim receipt contains a lease ID and fencing number [a generation number
that makes an old owner powerless]. Use both for heartbeat, blocker, merge, or
release commands. A new operator must obey `do-not-claim` while a lease is
active. After expiry, the item returns to the queue and the replacement receives
a higher fencing number.

Claim also atomically records an ownership receipt binding the lease owner, the
exact builder, and `builderSuspended=true`. The queue rejects the exact builder
identity as executor, and `record-merge` rejects a missing, stale, or mismatched
ownership receipt. This replaces native builder archival for repo-backed
execution. A callback or optional Codex task can show progress, but it cannot
claim, extend, or prove release ownership.

## Merge and failure rules

Before merge, independently re-read GitHub and the lifecycle receipt. If main
advanced while head and effective diff stayed immutable, use the typed recovery:

```bash
scripts/pr-release-queue route-base-drift \
  --lease-id "$LEASE_ID" \
  --fence "$FENCE" \
  --expected-head-sha "$HEAD_SHA" \
  --expected-diff-fingerprint "$DIFF_FINGERPRINT" \
  --transaction-id "$STABLE_TRANSACTION_ID"
```

The command brackets authenticated PR reads, proves linear ancestry from the
tested base, requires a complete textual base diff, fingerprints it, and
compares exact candidate/base-delta paths. A stable disjoint delta is
`automatic-safe-refresh`: the command atomically releases the stale lease,
records one active recovery attempt, and emits the exact builder/lifecycle
source-return receipt. Feed that receipt to
`scripts/pr-lifecycle accept-queue-source-return`, then let the same builder
rebase, re-review, retest, regenerate, and refresh under its bounded standing
authority. The callback route is optional wake UX; durable state is sufficient
after callback loss or context compaction.

Acceptance always reads `ops/release-state` through the repository's canonical
local origin and branch. It resolves that origin with fixed `/usr/bin/git`, pins
`gh` to a fixed system installation path, and starts the queue reader with a
minimal environment. Caller PATH, Git config, proxy/TLS/preload settings,
local-state, alternate-repository, branch, clock, and queue-binary overrides
cannot substitute a local ledger for lifecycle ownership. Those diagnostic/test
overrides remain available to direct queue commands, but never at this lifecycle
authority boundary.

Any overlapping path or Git conflict is substantive and stops automatic churn.
Renames, binaries, truncated comparisons, non-ancestor history, changing
head/base/diff, or malformed GitHub evidence are ambiguous and fail before the
lease is released. The generic `block --kind base-drift` path is rejected so a
free-text claim cannot bypass this classification.

After the same builder supplies a repaired packet with fresh review and tester
proof, close the exact attempt:

```bash
scripts/pr-release-queue refresh \
  --packet /path/to/new-packet.json \
  --recovery-attempt-id "$ATTEMPT_ID"
```

The queue normally requires the packet's tested base to equal the attempt's
observed base. If main advanced again before acceptance, the retired fence
reclassifies the cumulative delta and supersedes the old receipt. If it advanced
while the builder was re-proving, `refresh` classifies only the additional base
delta against the fresh packet before accepting it. Stable disjoint evidence
preserves the old candidate and stale receipts, moves every superseded and
completed attempt into ordered history, and returns the new immutable candidate
to `queued`. Ambiguous evidence remains retryable; overlap or conflict becomes a
durable semantic stop. The next claim receives a higher fence. Continued benign
drift has no arbitrary attempt cap and does not require a new fence until the
repaired candidate is actually requeued.

`checks-pending` is the one blocker that may recover without a new candidate.
Run the explicit recovery transition with the same immutable identity:

```bash
scripts/pr-release-queue recover-transient-blocker \
  --pr 123 \
  --head-sha "$HEAD_SHA" \
  --diff-fingerprint "$DIFF_FINGERPRINT" \
  --kind checks-pending \
  --transaction-id "$STABLE_TRANSACTION_ID"
```

The command uses authenticated GitHub reads itself. It brackets the proof with
exact PR head and base reads. Between them, it enumerates the required
`(context, app)` identities from legacy branch protection and every active rule
that applies to the exact base branch across all paginated rule pages. It then compares that expected set with
the paginated check runs and commit statuses for the exact queued head. Every
configured identity must have a GitHub-accepted passing observation; a required
check that never started is therefore `missing`, not silently absent.
An omitted ruleset `integration_id` means the context may be satisfied by any
app. Explicit malformed IDs and conflicting latest check-run/commit-status
observations remain ambiguous and fail closed.

Caller-authored receipts are rejected. The queue generates and stores the
normalized policy plus exact-head observations in `blockerRecoveryHistory` with
the original blocker. Empty or malformed policy responses, app mismatches,
pending or failed observations, head/base drift, and required-workflow rules
that cannot be reduced safely to status identities all fail closed.

The command also refuses an active release lease, candidate mismatch, mixed
blocker set, malformed or future blocker time, or any blocker other than
`checks-pending`. Repeating the same transaction or durable queue recovery is
idempotent and does not re-query GitHub. Stored blocker and recovery timestamps
must remain valid ISO instants ordered as blocker <= recovery <= command time.
Decision-required, lifecycle ambiguity, source findings, candidate drift, and
unknown blockers still require their existing repair path. Typed base drift has
the separate transition above; this command is not a generic unblock path.

A merge receipt must prove the reviewed head and diff, normal non-admin merge,
expected-head protection, landed-tree equality, and ancestry. Source-only work
then closes. Explicit deployment authority stops at a separate delivery barrier;
it does not silently become public-release authority.

Automated checks, branch protection, signing/package verification, publication,
and post-release proof remain independent gates whenever the authority packet
includes those stages. Native thread creation is never evidence for any gate.

Wake the packet's builder route after source return or terminal completion, and
wake the next relevant coordinator if supplied. The callback is convenience.
The queue state, GitHub PR, and merge receipt remain the truth.

## Recovery and rollback

- Vanished operator: wait for lease expiry, then claim with a new fence.
- Failed callback: leave durable state unchanged; another operator can inspect it.
- Ambiguous queue write: read once and match the transaction ID; never repeat an
  unconfirmed mutation.
- Legacy free-text `base-drift` item: leave it blocked. Do not synthesize modern
  ancestry/diff evidence from its details; the exact builder must repair it
  through the pre-existing path or re-enroll a freshly proved candidate.
- Queue outage: stop merging through this workflow. Existing PRs and lifecycle
  packets remain intact.
- Rollback: pass `--queue direct` to `scripts/pr-lifecycle handoff-release` for
  the existing direct release-task path. Do not delete or reset
  `ops/release-state`; its receipts remain the audit trail. No PR branch or
  runtime is modified merely by queue enrollment. Environment variables cannot
  select this rollback or disable authoritative rollout checks.
- Code rollback while an item is `awaiting-builder-refresh`: older executors
  leave that unknown state unclaimable. Restore the new tooling or complete the
  documented direct rollback; never erase the attempt history.

Graduation does not weaken GitHub's strict up-to-date-branch rule or authorize
admin action, deployment, runtime mutation, or public release.
