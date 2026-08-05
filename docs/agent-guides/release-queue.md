# Replaceable PR release operators

This queue lets builders work in parallel while keeping the final merge step
safe. GitHub and the repo-backed queue are authoritative. Codex callbacks are
only wake signals; a missing callback never changes ownership or merge order.

## The simple model

- Builders own source changes, CI, review fixes, and independent testing.
- A builder submits one immutable packet after an exact-head tester passes.
- Any fresh release operator may inspect the queue.
- Only one operator may hold the merge lease at a time.
- The lease expires, so a vanished operator is replaceable.
- Each successful merge is recorded before the next PR is claimed.

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
  "authority": {
    "source": "builder-handoff",
    "scope": "PR #123 source merge only",
    "allowedActions": ["normal-merge"],
    "constraints": ["no admin or bypass"]
  },
  "declaredDependencies": [{ "pr": 122, "relation": "requires", "reason": "uses its new contract" }]
}
```

The queue rejects a stale tester receipt or authority beyond normal merge and
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

## Merge and failure rules

Before merge, independently re-read GitHub and the lifecycle receipt. If main
advanced, the head changed, checks or review failed, or the diff changed, record
the blocker and return source work through the canonical lifecycle. A mechanical
conflict may be refreshed only by the builder under that lifecycle. Any conflict
that can change behavior requires fresh review and exact-head testing.

A merge receipt must prove the reviewed head and diff, normal non-admin merge,
expected-head protection, landed-tree equality, and ancestry. Source-only work
then closes. Explicit deployment authority stops at a separate delivery barrier;
it does not silently become public-release authority.

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
- Rollback: stop using the state branch and wrapper. No PR branch or runtime is
  modified merely by queue enrollment.

This is an MVP. It does not weaken GitHub's current strict up-to-date-branch
rule. Dogfood it with several real PRs before considering a tested merge-group
candidate that could safely reduce repeated rebases.
