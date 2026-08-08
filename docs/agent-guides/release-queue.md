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
advanced, the head changed, checks or review failed, or the diff changed, record
the blocker and return source work through the canonical lifecycle. A mechanical
conflict may be refreshed only by the builder under that lifecycle. Any conflict
that can change behavior requires fresh review and exact-head testing.

After the same builder supplies a repaired packet with fresh tester proof, use
`scripts/pr-release-queue refresh --packet /path/to/new-packet.json`. The queue
preserves the old candidate and blocker history, clears those old blockers, and
returns the new immutable candidate to `queued`.

`checks-pending` is the one blocker that may recover without a new candidate.
After an authoritative read-only GitHub check proves every required check passed
for the unchanged head, create a receipt that binds the PR, head, and lifecycle
diff fingerprint:

```json
{
  "schemaVersion": 1,
  "kind": "checks-pending-recovery",
  "receiptId": "stable-id-for-this-check-observation",
  "source": "github-required-checks",
  "candidate": {
    "pr": 123,
    "headSha": "40 hex characters",
    "diffFingerprint": "sha256:64 hex characters"
  },
  "observedAt": "2026-08-08T12:00:00.000Z",
  "allRequiredChecksPassed": true,
  "requiredChecks": [{ "name": "test", "conclusion": "SUCCESS" }]
}
```

Then run the explicit recovery transition with the same immutable identity:

```bash
scripts/pr-release-queue recover-transient-blocker \
  --pr 123 \
  --head-sha "$HEAD_SHA" \
  --diff-fingerprint "$DIFF_FINGERPRINT" \
  --kind checks-pending \
  --receipt /path/to/checks-recovery.json \
  --transaction-id "$STABLE_TRANSACTION_ID"
```

The command refuses an active release lease, candidate mismatch, mixed blocker
set, or any blocker other than `checks-pending`. It preserves the original
blocker and evidence in `blockerRecoveryHistory`, then makes the unchanged item
claimable. Repeating the same transaction or durable receipt is idempotent.
Decision-required, base-drift, lifecycle ambiguity, source findings, candidate
drift, and unknown blockers still require their existing repair path; this is
not a generic unblock command.

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
- Queue outage: stop merging through this workflow. Existing PRs and lifecycle
  packets remain intact.
- Rollback: pass `--queue direct` to `scripts/pr-lifecycle handoff-release` for
  the existing direct release-task path. Do not delete or reset
  `ops/release-state`; its receipts remain the audit trail. No PR branch or
  runtime is modified merely by queue enrollment. Environment variables cannot
  select this rollback or disable authoritative rollout checks.

Graduation does not weaken GitHub's strict up-to-date-branch rule or authorize
admin action, deployment, runtime mutation, or public release.
