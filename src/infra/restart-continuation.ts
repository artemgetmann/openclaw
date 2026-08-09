import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const SENTINEL_CONTEXT_PREFIX = "restart:";
const DIRECT_TURN_CONTEXT_PREFIX = "restart-followup:";
const DIRECT_TURN_CLAIMS_KEY = Symbol.for("openclaw.restartContinuation.directTurnClaims");
const directTurnClaims = resolveGlobalSingleton(DIRECT_TURN_CLAIMS_KEY, () => new Set<string>());

export type RestartContinuationContext =
  | { kind: "sentinel"; id: string }
  | { kind: "direct-turn"; id: string };

/**
 * One safety prompt drives both explicit gateway restarts and automatic
 * recovery of interrupted direct turns. It deliberately asks the model to
 * inspect transcript + external state, never to replay the original request.
 */
export const RESTART_CONTINUATION_PROMPT = [
  "Jarvis restarted while this session had active work.",
  "Continue from the saved conversation and reassess the current external state before taking action.",
  "Never blindly repeat an irreversible side effect such as sending, publishing, deleting, paying, or restarting.",
  "Preserve every approval gate. If the task is already complete, report that and stop. If no task remains active, do nothing.",
].join(" ");

/**
 * Direct-turn recovery must resume the newest interrupted request, not reopen
 * an older completion claim that merely remains in the same long transcript.
 * Keep the request itself in its original user message instead of copying
 * untrusted user text into a higher-priority system event.
 */
export const DIRECT_TURN_RESTART_CONTINUATION_PROMPT = [
  RESTART_CONTINUATION_PROMPT,
  "This recovery belongs to the most recent user-authored request immediately before the restart receipt.",
  "Continue that request automatically from its latest tool results and draft state.",
  "Do not substitute an older task, completion claim, verification prompt, approval request, heartbeat item, or memory entry just because it remains in the transcript.",
  "Preserve the interrupted request's action boundary exactly: draft remains draft, review remains review, and read-only remains read-only unless that request itself already authorized the external action.",
  "Do not ask the user to say continue or repeat an approval that the interrupted request did not require.",
].join(" ");

export function buildSentinelRestartContinuationContext(operationId: string): string {
  return `${SENTINEL_CONTEXT_PREFIX}${operationId.trim().toLowerCase()}`;
}

export function buildDirectTurnRestartContinuationContext(durableId: string): string {
  return `${DIRECT_TURN_CONTEXT_PREFIX}${durableId.trim().toLowerCase()}`;
}

export function parseRestartContinuationContext(
  contextKey?: string | null,
): RestartContinuationContext | undefined {
  const normalized = contextKey?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized.startsWith(DIRECT_TURN_CONTEXT_PREFIX)) {
    const id = normalized.slice(DIRECT_TURN_CONTEXT_PREFIX.length);
    return id ? { kind: "direct-turn", id } : undefined;
  }
  if (normalized.startsWith(SENTINEL_CONTEXT_PREFIX)) {
    const id = normalized.slice(SENTINEL_CONTEXT_PREFIX.length);
    return id ? { kind: "sentinel", id } : undefined;
  }
  return undefined;
}

export function isRestartContinuationContext(contextKey?: string | null): boolean {
  return parseRestartContinuationContext(contextKey) !== undefined;
}

/**
 * Suppress queue retries while the same process already owns a direct-turn
 * wake. The set intentionally resets on process replacement: durable
 * `delivering` then means startup must reconstruct the lost in-memory event.
 */
export function claimDirectTurnRestartContinuation(durableId: string): boolean {
  const normalized = durableId.trim().toLowerCase();
  if (!normalized || directTurnClaims.has(normalized)) {
    return false;
  }
  directTurnClaims.add(normalized);
  return true;
}

export function releaseDirectTurnRestartContinuation(durableId: string): void {
  directTurnClaims.delete(durableId.trim().toLowerCase());
}

export function resetDirectTurnRestartContinuationClaimsForTest(): void {
  directTurnClaims.clear();
}
