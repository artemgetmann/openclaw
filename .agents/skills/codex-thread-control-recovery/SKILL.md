---
name: codex-thread-control-recovery
description: Recover or verify a native Codex task when read, send, archive, unarchive, or continuation control is stale, timed out, ambiguous, or falsely appears successful. Use for exact-thread steering and PR lifecycle handbacks; never use it to create a replacement owner.
---

# Codex Thread Control Recovery

Treat thread control as a verified transaction, not a single tool call.

## Identity gate

1. Discover the current native thread tools before claiming they are unavailable.
2. Resolve one exact `threadId` and `hostId` from the authoritative lifecycle
   receipt or a fresh thread search. Do not infer identity from title alone.
3. Read the exact thread. Record its current turn id, status, and authoritative
   archive state separately. `active`, `notLoaded`, or an empty active-flags
   list does not prove work is executing; `notLoaded` does not prove archival.

## Resume transaction

1. If authoritative state says the exact target is archived, set only that
   target to `archived:false` and read it back. If the mutation is ambiguous,
   wait one to two minutes and perform one read-only reconciliation. Retry only
   when unchanged archive state proves the first mutation did not occur.
2. Send one short, idempotent continuation that states the exact next outcome
   and forbids replacement ownership or scope expansion.
3. Read the target back. Delivery is proven only when a new user turn containing
   that continuation appears. A successful send receipt alone is insufficient.
   Never repeat an ambiguously accepted send; readback cannot prove that delayed
   delivery will not still occur.
4. Confirm progress separately: require either a new running tool/action in that
   turn or a terminal agent receipt. Re-read after a meaningful interval; do not
   busy-poll or keep a caller alive with shell `sleep` loops.
5. If a visibly delivered turn stalls after a material completed action, send
   at most one short finish prompt to the same target. This is a new continuation
   after proven delivery, not a retry of an ambiguous send. Otherwise report the
   exact last proven action and leave ownership unchanged.

## Archive transaction

1. Read the exact target and verify that its terminal receipt or lifecycle gate
   makes archival legal.
2. Archive only that target, then verify with a fresh read or inventory result.
3. Never treat mutation acceptance as archive proof. Never archive an adjacent
   coordinator, tester, builder, or release owner to make the roster look tidy.

## Failure classification

- Transport error or timeout: ambiguous until readback.
- Send success without a new target turn: accepted, not delivered.
- New target turn without execution or terminal receipt: delivered, not resumed.
- Running command or tool in the new turn: resumed, not finished.
- Terminal receipt matching the requested outcome: finished.

After two bounded read-only reconciliation attempts with the same failure,
stop. State-changing retries still require unchanged state that proves them
safe. Preserve the existing owner and report the target identity, last proven
state, attempted transition, and safe next action. Do not fall back to the CLI,
create a duplicate thread, or change lifecycle state unless a separate contract
explicitly authorizes it.
