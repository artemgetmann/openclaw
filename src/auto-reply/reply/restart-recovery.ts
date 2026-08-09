import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import {
  buildDirectTurnRestartContinuationContext,
  claimDirectTurnRestartContinuation,
  DIRECT_TURN_RESTART_CONTINUATION_PROMPT,
  releaseDirectTurnRestartContinuation,
} from "../../infra/restart-continuation.js";
import { enqueueSystemEvent, peekSystemEventEntries } from "../../infra/system-events.js";
import { scopedHeartbeatWakeOptions } from "../../routing/session-key.js";
import type { ReplyPayload } from "../types.js";
import {
  markDurableFollowupRestartContinuationDelivering,
  type DurableFollowupRecord,
} from "./queue/durable-store.js";

/**
 * Durable terminal receipt used when a restart can make an unfinished turn's
 * side effects ambiguous. Recovery sends this instead of replaying model/tool
 * work that may already have changed external state.
 */
export const RESTART_INTERRUPTED_TURN_PAYLOAD: ReplyPayload = {
  text:
    "Jarvis restarted while working on your request. " +
    "I’m resuming automatically from the saved conversation and will verify current state before repeating any action.",
  restartRecovery: true,
};

/**
 * Recovery receipts are mirrored into the transcript so the automatic
 * continuation sees the same restart acknowledgment the user received.
 */
export function isRestartInterruptedTurnPayload(payload: ReplyPayload): boolean {
  return payload.restartRecovery === true;
}

export class RestartContinuationPendingError extends Error {
  constructor(readonly durableId: string) {
    super(`Restart continuation ${durableId} is awaiting terminal delivery`);
    this.name = "RestartContinuationPendingError";
  }
}

/**
 * Convert one durable interruption blocker into the same tagged heartbeat wake
 * used by explicit restart recovery. The stable context key deduplicates
 * repeated startup scans while the durable record survives process restarts.
 */
export async function scheduleInterruptedDirectTurnContinuation(
  record: DurableFollowupRecord,
): Promise<void> {
  const sessionKey = record.run.run.sessionKey?.trim();
  if (!sessionKey) {
    throw new Error(`Restart continuation ${record.id} has no original session`);
  }
  if (!claimDirectTurnRestartContinuation(record.id)) {
    return;
  }
  try {
    const marked = await markDurableFollowupRestartContinuationDelivering(record.id);
    if (!marked) {
      releaseDirectTurnRestartContinuation(record.id);
      return;
    }
    const contextKey = buildDirectTurnRestartContinuationContext(record.id);
    const alreadyQueued = peekSystemEventEntries(sessionKey).some(
      (event) => event.contextKey === contextKey,
    );
    if (!alreadyQueued) {
      enqueueSystemEvent(DIRECT_TURN_RESTART_CONTINUATION_PROMPT, { sessionKey, contextKey });
    }
    requestHeartbeatNow(scopedHeartbeatWakeOptions(sessionKey, { reason: "restart-continuation" }));
  } catch (err) {
    releaseDirectTurnRestartContinuation(record.id);
    throw err;
  }
}
