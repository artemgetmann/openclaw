import { randomUUID } from "node:crypto";
import {
  CODEX_RELAY_MAX_RECONCILE_AGE_MS,
  type CodexDelegationRegistry,
  type CodexRelayRecord,
  type CodexRelayRegistryIssue,
} from "./delegation-registry.js";
import type { CodexPersistedTurnInspection } from "./thread-service.js";

export type CodexRelayReconciliationResult = {
  inspected: number;
  delivered: number;
  recovered: number;
  decisionNeeded: number;
  skipped: number;
  malformed: number;
  failed: number;
};

export type CodexRelayDispatchOutcome = "completed" | "queued";

type ReconciliationOptions = {
  registry: CodexDelegationRegistry;
  inspectTurn: (threadId: string, turnId: string) => Promise<CodexPersistedTurnInspection>;
  dispatchTerminal: (
    record: CodexRelayRecord,
    finalText: string,
  ) => Promise<CodexRelayDispatchOutcome>;
  dispatchDecisionNeeded: (
    record: CodexRelayRecord,
    reason: string,
  ) => Promise<CodexRelayDispatchOutcome>;
  startRecovery?: (record: CodexRelayRecord, recoveryDelegationId: string) => Promise<void>;
  onMalformedEntry?: (issue: CodexRelayRegistryIssue) => void;
  onRecordError?: (record: CodexRelayRecord, error: unknown) => void;
  now?: () => number;
  maxAgeMs?: number;
};

/**
 * Reconcile accepted relays from durable identity only.
 *
 * Exact interrupted turns recover only when the launch record contains explicit
 * local-safe authority. The recovery claim is persisted before turn/start, so
 * ambiguous acceptance can never trigger a second turn.
 */
export async function reconcileCodexRelays(
  options: ReconciliationOptions,
): Promise<CodexRelayReconciliationResult> {
  const snapshot = await options.registry.snapshot();
  for (const issue of snapshot.issues) {
    options.onMalformedEntry?.(issue);
  }
  const result: CodexRelayReconciliationResult = {
    inspected: 0,
    delivered: 0,
    recovered: 0,
    decisionNeeded: 0,
    skipped: 0,
    malformed: snapshot.issues.length,
    failed: 0,
  };
  const now = (options.now ?? Date.now)();
  const maxAgeMs = options.maxAgeMs ?? CODEX_RELAY_MAX_RECONCILE_AGE_MS;
  const recordsById = new Map(snapshot.records.map((record) => [record.delegationId, record]));

  for (const record of snapshot.records) {
    try {
      if (record.lifecycle === "recovery-started" && record.recoveryDelegationId) {
        const child = recordsById.get(record.recoveryDelegationId);
        if (
          child?.recoveryOfDelegationId === record.delegationId &&
          child.threadId === record.threadId &&
          child.sessionKey === record.sessionKey &&
          child.lifecycle !== "starting"
        ) {
          // The replacement turn crossed its own durable acceptance boundary.
          // Repair the parent before either record is reconciled so a crash
          // between child acceptance and parent finalization cannot emit a
          // contradictory ambiguity handback.
          Object.assign(record, await options.registry.markRecovered(record.delegationId));
        }
      }
      await reconcileRecord({ options, result, record, now, maxAgeMs });
    } catch (error) {
      // Every dispatch is preceded by its durable terminal/decision claim.
      // Containing the rejection here therefore preserves fail-closed state
      // while allowing unrelated later records to make progress.
      result.failed += 1;
      try {
        options.onRecordError?.(record, error);
      } catch {
        // A logger/plugin callback must not reintroduce fleet-wide failure.
      }
    }
  }

  return result;
}

async function reconcileRecord(params: {
  options: ReconciliationOptions;
  result: CodexRelayReconciliationResult;
  record: CodexRelayRecord;
  now: number;
  maxAgeMs: number;
}): Promise<void> {
  const { options, result, record, now, maxAgeMs } = params;
  if (
    record.lifecycle === "delivered" ||
    record.lifecycle === "decision-needed" ||
    record.lifecycle === "recovered"
  ) {
    result.skipped += 1;
    return;
  }
  if (record.lifecycle === "recovery-started") {
    recordDecisionOutcome(
      result,
      await deliverDecision(
        options,
        record,
        "Restart recovery was durably claimed, but acceptance of the new native turn is ambiguous. It was not attempted again.",
      ),
    );
    return;
  }
  if (record.lifecycle === "delivery-started" && record.deliveryKind === "decision") {
    // The previous process durably claimed the sole decision dispatch before
    // crossing into Jarvis. Whether it crossed that boundary is unknowable
    // after a crash, so at-most-once wins: never inspect Codex or resend.
    result.skipped += 1;
    return;
  }
  if (now - record.updatedAtMs > maxAgeMs) {
    recordDecisionOutcome(
      result,
      await deliverDecision(
        options,
        record,
        "The durable relay record is stale, so its native state was not trusted. Codex work was not replayed.",
      ),
    );
    return;
  }
  if (record.lifecycle === "delivery-started") {
    recordDecisionOutcome(
      result,
      await deliverDecision(
        options,
        record,
        record.heartbeatQueuedAtMs
          ? "The previous Gateway queued a volatile heartbeat handback before it stopped, but durable state cannot prove Jarvis processed or delivered it. The result was not delivered again."
          : record.deliveryKind === "callback"
            ? "The previous Gateway started completion-callback delivery before it stopped, but durable state cannot prove whether Jarvis processed it. The result was not delivered again."
            : "The previous Gateway started terminal delivery before it stopped, but durable state cannot prove whether Jarvis processed it. The result was not delivered again.",
      ),
    );
    return;
  }
  if (record.lifecycle === "starting" || !record.turnId) {
    recordDecisionOutcome(
      result,
      await deliverDecision(
        options,
        record,
        "The Gateway stopped before the exact native turn acceptance was durably recorded. The task was not started again.",
      ),
    );
    return;
  }

  result.inspected += 1;
  let inspection: CodexPersistedTurnInspection;
  try {
    inspection = await options.inspectTurn(record.threadId, record.turnId);
  } catch (error) {
    recordDecisionOutcome(
      result,
      await deliverDecision(
        options,
        record,
        `The exact native turn could not be inspected (${formatError(error)}). The task was not resumed or replayed.`,
      ),
    );
    return;
  }

  if (inspection.kind === "completed") {
    // Re-check both identities even though the inspection contract is typed:
    // an unrelated or buggy provider response must not be relayed as proof.
    if (inspection.threadId !== record.threadId || inspection.turnId !== record.turnId) {
      recordDecisionOutcome(
        result,
        await deliverDecision(
          options,
          record,
          "Codex returned a completed turn with mismatched identity. The result was rejected and no work was replayed.",
        ),
      );
      return;
    }
    if (record.lifecycle === "accepted") {
      await options.registry.markTerminal(record.delegationId, "completed");
    }
    const claimed = await options.registry.claimTerminalDelivery(record.delegationId);
    if (!claimed) {
      result.skipped += 1;
      return;
    }
    // Delivery is intentionally claimed before dispatch. A crash after this
    // point becomes an ambiguity report on restart, never a duplicate result.
    const outcome = await options.dispatchTerminal(claimed, inspection.finalText);
    if (outcome === "completed") {
      await options.registry.markDelivered(record.delegationId);
      result.delivered += 1;
    } else {
      result.skipped += 1;
    }
    return;
  }

  await markObservedTerminal(options.registry, record, inspection);
  if (
    inspection.kind === "interrupted" &&
    record.recoveryPolicy === "local-safe" &&
    options.startRecovery
  ) {
    const recoveryDelegationId = randomUUID();
    const claimed = await options.registry.claimRecovery(record.delegationId, recoveryDelegationId);
    if (!claimed) {
      result.skipped += 1;
      return;
    }
    await options.startRecovery(claimed, recoveryDelegationId);
    await options.registry.markRecovered(record.delegationId);
    result.recovered += 1;
    return;
  }
  recordDecisionOutcome(
    result,
    await deliverDecision(options, record, inspectionDecision(inspection)),
  );
}

async function markObservedTerminal(
  registry: CodexDelegationRegistry,
  record: CodexRelayRecord,
  inspection: CodexPersistedTurnInspection,
): Promise<void> {
  if (record.lifecycle !== "accepted") {
    return;
  }
  if (inspection.kind === "failed") {
    await registry.markTerminal(record.delegationId, "failed");
  } else if (inspection.kind === "interrupted") {
    await registry.markTerminal(record.delegationId, "interrupted");
  }
}

async function deliverDecision(
  options: ReconciliationOptions,
  record: CodexRelayRecord,
  reason: string,
): Promise<boolean> {
  // Classification and the one permitted attempt are claimed atomically before
  // dispatch. A crash from this point onward is durable ambiguity: startup
  // neither re-inspects Codex nor resends the decision report.
  const claimed = await options.registry.claimDecisionDelivery(record.delegationId);
  if (!claimed) {
    return false;
  }
  const outcome = await options.dispatchDecisionNeeded(claimed, reason);
  if (outcome === "completed") {
    await options.registry.markDecisionNeeded(record.delegationId);
    return true;
  }
  return false;
}

function recordDecisionOutcome(result: CodexRelayReconciliationResult, completed: boolean): void {
  if (completed) {
    result.decisionNeeded += 1;
  } else {
    result.skipped += 1;
  }
}

function inspectionDecision(inspection: CodexPersistedTurnInspection): string {
  if (inspection.kind === "failed") {
    return `The exact native turn is failed${
      inspection.error ? ` (${inspection.error})` : ""
    }. It was not retried.`;
  }
  if (inspection.kind === "interrupted") {
    return "The exact native turn is interrupted. It was not resumed or replayed.";
  }
  if (inspection.kind === "nonterminal") {
    return `The exact native turn is ${inspection.status}, but the new Gateway cannot prove it owns that execution. Observation was not resumed and the task was not replayed.`;
  }
  if (inspection.kind === "missing") {
    return "The persisted native thread did not contain the exact recorded turn. No unrelated turn was used and the task was not replayed.";
  }
  if (inspection.kind === "mismatch") {
    return `Codex returned native thread ${inspection.actualThreadId ?? "unknown"} instead of ${inspection.expectedThreadId}. The unrelated state was rejected.`;
  }
  if (inspection.kind === "invalid") {
    return `The exact native turn state was ambiguous (${inspection.reason}). Completion was not inferred and the task was not replayed.`;
  }
  return "The exact native turn could not be proven complete. The task was not replayed.";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
