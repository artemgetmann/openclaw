import { isAbortRequestText } from "../auto-reply/reply/abort.js";

export type ChatAbortActivitySource = string;

export type ChatAbortControllerEntry = {
  controller: AbortController;
  sessionId: string;
  sessionKey: string;
  startedAtMs: number;
  expiresAtMs: number;
  timeoutMs?: number;
  lastRenewedAtMs?: number;
  lastActivitySource?: ChatAbortActivitySource;
  ownerConnId?: string;
  ownerDeviceId?: string;
};

export function isChatStopCommandText(text: string): boolean {
  return isAbortRequestText(text);
}

export function resolveChatRunExpiresAtMs(params: {
  now: number;
  timeoutMs: number;
  graceMs?: number;
  minMs?: number;
  maxMs?: number;
}): number {
  const { now, timeoutMs, graceMs = 60_000, minMs = 2 * 60_000, maxMs = 24 * 60 * 60_000 } = params;
  const boundedTimeoutMs = Math.max(0, timeoutMs);
  const target = now + boundedTimeoutMs + graceMs;
  const min = now + minMs;
  const max = now + maxMs;
  return Math.min(max, Math.max(min, target));
}

export function createChatAbortControllerEntry(params: {
  controller: AbortController;
  sessionId: string;
  sessionKey: string;
  startedAtMs: number;
  timeoutMs: number;
  activitySource?: ChatAbortActivitySource;
  ownerConnId?: string;
  ownerDeviceId?: string;
}): ChatAbortControllerEntry {
  const activitySource = params.activitySource?.trim() || "chat.send";
  const expiresAtMs = resolveChatRunExpiresAtMs({
    now: params.startedAtMs,
    timeoutMs: params.timeoutMs,
  });
  return {
    controller: params.controller,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    startedAtMs: params.startedAtMs,
    timeoutMs: params.timeoutMs,
    lastRenewedAtMs: params.startedAtMs,
    lastActivitySource: activitySource,
    expiresAtMs,
    ownerConnId: params.ownerConnId,
    ownerDeviceId: params.ownerDeviceId,
  };
}

export function renewChatAbortControllerEntry(params: {
  entry: ChatAbortControllerEntry;
  now: number;
  activitySource: ChatAbortActivitySource;
  timeoutMs?: number;
}): ChatAbortControllerEntry {
  const activitySource =
    params.activitySource.trim() || params.entry.lastActivitySource || "unknown";
  const timeoutMs =
    params.timeoutMs ??
    params.entry.timeoutMs ??
    Math.max(0, params.entry.expiresAtMs - params.entry.startedAtMs);
  const nextExpiresAtMs = resolveChatRunExpiresAtMs({
    now: params.now,
    timeoutMs,
  });
  // Async activity callbacks can arrive out of order. Keep expiry monotonic so
  // a delayed callback cannot shorten a fresher lease.
  if (nextExpiresAtMs >= params.entry.expiresAtMs) {
    params.entry.lastRenewedAtMs = params.now;
    params.entry.lastActivitySource = activitySource;
    params.entry.expiresAtMs = nextExpiresAtMs;
  }
  return params.entry;
}

export function renewChatRunExpiry(params: {
  entry: ChatAbortControllerEntry;
  now: number;
  timeoutMs: number;
}): number {
  renewChatAbortControllerEntry({
    entry: params.entry,
    now: params.now,
    timeoutMs: params.timeoutMs,
    activitySource: params.entry.lastActivitySource ?? "agent:activity",
  });
  return params.entry.expiresAtMs;
}

export function buildChatTimeoutAbortReason(params: {
  runId: string;
  sessionKey: string;
  startedAtMs: number;
  expiresAtMs: number;
  lastRenewedAtMs: number;
  lastActivitySource: ChatAbortActivitySource;
}) {
  const error = new Error(
    `chat lease timed out run=${params.runId} session=${params.sessionKey} started=${params.startedAtMs} expires=${params.expiresAtMs} renewed=${params.lastRenewedAtMs} source=${params.lastActivitySource}`,
  );
  error.name = "TimeoutError";
  return error;
}

export function formatChatTimeoutAbortLog(params: {
  runId: string;
  entry: ChatAbortControllerEntry;
  now: number;
}): string {
  const ageMs = Math.max(0, params.now - params.entry.startedAtMs);
  const overdueMs = Math.max(0, params.now - params.entry.expiresAtMs);
  // Some older tests still construct legacy entries directly. Runtime chat.send entries carry
  // these fields, but logging should stay useful instead of printing raw undefined values.
  const lastRenewedAtMs = params.entry.lastRenewedAtMs ?? params.entry.startedAtMs;
  const lastActivitySource = params.entry.lastActivitySource ?? "unknown";
  return [
    `chat timeout abort runId=${params.runId}`,
    `sessionKey=${params.entry.sessionKey}`,
    `startedAtMs=${params.entry.startedAtMs}`,
    `expiresAtMs=${params.entry.expiresAtMs}`,
    `lastRenewedAtMs=${lastRenewedAtMs}`,
    `lastActivitySource=${lastActivitySource}`,
    `ageMs=${ageMs}`,
    `overdueMs=${overdueMs}`,
  ].join(" ");
}

export type ChatAbortOps = {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  chatAbortedRuns: Map<string, number>;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => { sessionKey: string; clientRunId: string } | undefined;
  agentRunSeq: Map<string, number>;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
};

function broadcastChatAborted(
  ops: ChatAbortOps,
  params: {
    runId: string;
    sessionKey: string;
    stopReason?: string;
    partialText?: string;
  },
) {
  const { runId, sessionKey, stopReason, partialText } = params;
  const payload = {
    runId,
    sessionKey,
    seq: (ops.agentRunSeq.get(runId) ?? 0) + 1,
    state: "aborted" as const,
    stopReason,
    message: partialText
      ? {
          role: "assistant",
          content: [{ type: "text", text: partialText }],
          timestamp: Date.now(),
        }
      : undefined,
  };
  ops.broadcast("chat", payload);
  ops.nodeSendToSession(sessionKey, "chat", payload);
}

export function abortChatRunById(
  ops: ChatAbortOps,
  params: {
    runId: string;
    sessionKey: string;
    stopReason?: string;
    abortReason?: unknown;
  },
): { aborted: boolean } {
  const { runId, sessionKey, stopReason, abortReason } = params;
  const active = ops.chatAbortControllers.get(runId);
  if (!active) {
    return { aborted: false };
  }
  if (active.sessionKey !== sessionKey) {
    return { aborted: false };
  }

  const bufferedText = ops.chatRunBuffers.get(runId);
  const partialText = bufferedText && bufferedText.trim() ? bufferedText : undefined;
  ops.chatAbortedRuns.set(runId, Date.now());
  if (abortReason !== undefined) {
    active.controller.abort(abortReason);
  } else {
    active.controller.abort();
  }
  ops.chatAbortControllers.delete(runId);
  ops.chatRunBuffers.delete(runId);
  ops.chatDeltaSentAt.delete(runId);
  const removed = ops.removeChatRun(runId, runId, sessionKey);
  broadcastChatAborted(ops, { runId, sessionKey, stopReason, partialText });
  ops.agentRunSeq.delete(runId);
  if (removed?.clientRunId) {
    ops.agentRunSeq.delete(removed.clientRunId);
  }
  return { aborted: true };
}

export function abortChatRunsForSessionKey(
  ops: ChatAbortOps,
  params: {
    sessionKey: string;
    stopReason?: string;
  },
): { aborted: boolean; runIds: string[] } {
  const { sessionKey, stopReason } = params;
  const runIds: string[] = [];
  for (const [runId, active] of ops.chatAbortControllers) {
    if (active.sessionKey !== sessionKey) {
      continue;
    }
    const res = abortChatRunById(ops, { runId, sessionKey, stopReason });
    if (res.aborted) {
      runIds.push(runId);
    }
  }
  return { aborted: runIds.length > 0, runIds };
}
