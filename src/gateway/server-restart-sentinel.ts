import { resolveAnnounceTargetFromKey } from "../agents/tools/sessions-send-helpers.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import type { CliDeps } from "../cli/deps.js";
import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
import { parseSessionThreadInfo } from "../config/sessions/delivery-info.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { createAsyncLock } from "../infra/json-files.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { resolveOutboundTarget } from "../infra/outbound/targets.js";
import {
  buildSentinelRestartContinuationContext,
  RESTART_CONTINUATION_PROMPT,
} from "../infra/restart-continuation.js";
import {
  consumeRestartSentinelIfTerminal,
  consumeRestartSentinel,
  formatRestartSentinelMessage,
  readRestartRecoveryMarker,
  readRestartSentinel,
  summarizeRestartSentinel,
  updateRestartSentinel,
  type RestartOperationRecord,
} from "../infra/restart-sentinel.js";
import { enqueueSystemEvent, peekSystemEventEntries } from "../infra/system-events.js";
import { scopedHeartbeatWakeOptions } from "../routing/session-key.js";
import { deliveryContextFromSession, mergeDeliveryContext } from "../utils/delivery-context.js";
import { loadSessionEntry } from "./session-utils.js";

const withRestartOperationLock = createAsyncLock();
const RESTART_OPERATION_RETRY_MS = 1_000;
const restartOperationRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function buildRecoveryReceipt(operation: RestartOperationRecord): string {
  const detail = operation.note ?? operation.reason;
  return detail
    ? `Gateway restarted and is back online. ${detail}`
    : "Gateway restarted and is back online.";
}

function clearRestartOperationRetry(operationId: string): void {
  const timer = restartOperationRetryTimers.get(operationId);
  if (timer) {
    clearTimeout(timer);
    restartOperationRetryTimers.delete(operationId);
  }
}

function scheduleRestartOperationRetry(params: {
  operationId: string;
  expiresAt: number;
  deps: CliDeps;
}): void {
  if (restartOperationRetryTimers.has(params.operationId)) {
    return;
  }
  const remainingMs = params.expiresAt - Date.now();
  if (remainingMs <= 0) {
    return;
  }

  // Reconciliation remains idempotent under the operation lock. The timer is
  // process-local by design: a process restart gets a fresh startup attempt,
  // while expiresAt remains the durable upper bound across every process.
  const delayMs = Math.min(RESTART_OPERATION_RETRY_MS, remainingMs);
  const timer = setTimeout(() => {
    restartOperationRetryTimers.delete(params.operationId);
    void scheduleRestartSentinelWake({ deps: params.deps }).catch(() => {
      // A transient sentinel I/O failure should not permanently strand the
      // operation. Retry again only while the original durable TTL permits it.
      scheduleRestartOperationRetry(params);
    });
  }, delayMs);
  timer.unref?.();
  restartOperationRetryTimers.set(params.operationId, timer);
}

export function resetRestartOperationRetryStateForTests(): void {
  for (const timer of restartOperationRetryTimers.values()) {
    clearTimeout(timer);
  }
  restartOperationRetryTimers.clear();
}

async function markOperationDelivery(params: {
  operationId: string;
  field: "receipt" | "continuation";
  state: RestartOperationRecord["delivery"]["receipt"];
  error?: string;
}): Promise<void> {
  const updated = await updateRestartSentinel((current) => {
    if (!current.operation || current.operation.id !== params.operationId) {
      return current;
    }
    return {
      ...current,
      operation: {
        ...current.operation,
        delivery: {
          ...current.operation.delivery,
          [params.field]: params.state,
          updatedAt: Date.now(),
          lastError: params.error,
        },
      },
    };
  });
  if (updated?.operation?.id === params.operationId) {
    await consumeRestartSentinelIfTerminal(params.operationId);
  }
}

async function reconcileRestartOperation(params: {
  operation: RestartOperationRecord;
  deps: CliDeps;
}): Promise<void> {
  const { operation } = params;
  const now = Date.now();
  const isTerminal = (state: RestartOperationRecord["delivery"]["receipt"]) =>
    state === "delivered" || state === "skipped";
  if (isTerminal(operation.delivery.receipt) && isTerminal(operation.delivery.continuation)) {
    // A prior process may crash after the terminal state write but before its
    // unlink. Startup must consume that stale success instead of treating it as
    // an operation that still needs reconciliation forever.
    clearRestartOperationRetry(operation.id);
    await consumeRestartSentinelIfTerminal(operation.id);
    return;
  }
  if (operation.expiresAt <= now) {
    clearRestartOperationRetry(operation.id);
    const updated = await updateRestartSentinel((current) => {
      if (!current.operation || current.operation.id !== operation.id) {
        return current;
      }
      return {
        ...current,
        operation: {
          ...current.operation,
          delivery: {
            ...current.operation.delivery,
            receipt: current.operation.delivery.receipt === "delivered" ? "delivered" : "skipped",
            continuation:
              current.operation.delivery.continuation === "delivered" ? "delivered" : "skipped",
            updatedAt: now,
            lastError: "restart operation expired before recovery delivery",
          },
        },
      };
    });
    if (updated?.operation?.id === operation.id) {
      await consumeRestartSentinelIfTerminal(operation.id);
    }
    return;
  }

  // The detached process normally writes this marker first. If startup wins
  // the race, reaching this code is itself recovery proof; record that truth
  // without delaying channel startup on an observer process.
  const marker = await readRestartRecoveryMarker(operation.id);
  await updateRestartSentinel((current) => {
    if (!current.operation || current.operation.id !== operation.id) {
      return current;
    }
    return {
      ...current,
      operation: {
        ...current.operation,
        recovery: {
          state: marker?.state ?? "ok",
          observedAt: marker?.observedAt ?? Date.now(),
          error: marker?.error,
        },
      },
    };
  });

  const fresh = (await readRestartSentinel())?.operation;
  if (!fresh || fresh.id !== operation.id || fresh.recovery.state === "error") {
    clearRestartOperationRetry(operation.id);
    return;
  }

  if (fresh.delivery.receipt === "pending") {
    await markOperationDelivery({ operationId: fresh.id, field: "receipt", state: "delivering" });
    try {
      const sessionKey = fresh.sessionKey ?? resolveMainSessionKeyFromConfig();
      const { baseSessionKey, threadId: sessionThreadId } = parseSessionThreadInfo(sessionKey);
      const { cfg, entry } = loadSessionEntry(sessionKey);
      const parsedTarget = resolveAnnounceTargetFromKey(baseSessionKey ?? sessionKey);

      // A restart request can predate route capture. Recover from the current
      // session entry, including legacy lastChannel/lastTo fields, while still
      // treating any captured operation fields as authoritative.
      let sessionDeliveryContext = deliveryContextFromSession(entry);
      if (!sessionDeliveryContext && baseSessionKey && baseSessionKey !== sessionKey) {
        const { entry: baseEntry } = loadSessionEntry(baseSessionKey);
        sessionDeliveryContext = deliveryContextFromSession(baseEntry);
      }
      const route = mergeDeliveryContext(
        {
          channel: fresh.channel,
          to: fresh.to,
          accountId: fresh.accountId,
          threadId: fresh.topicId,
        },
        mergeDeliveryContext(sessionDeliveryContext, parsedTarget ?? undefined),
      );
      const channel = route?.channel ? normalizeChannelId(route.channel) : null;
      const resolved =
        channel && route?.to
          ? resolveOutboundTarget({
              channel,
              to: route.to,
              cfg,
              accountId: route.accountId,
              mode: "implicit",
            })
          : null;
      if (!route || !channel || !resolved?.ok) {
        throw new Error("restart receipt route is unavailable");
      }
      const threadId =
        fresh.topicId ??
        parsedTarget?.threadId ??
        sessionThreadId ??
        (route.threadId != null ? String(route.threadId) : undefined);
      let receiptError: unknown;
      await deliverOutboundPayloads({
        cfg,
        channel,
        to: resolved.to,
        accountId: route.accountId,
        threadId: channel === "slack" ? undefined : threadId,
        replyToId: channel === "slack" ? threadId : undefined,
        payloads: [{ text: buildRecoveryReceipt(fresh) }],
        session: buildOutboundSessionContext({ cfg, sessionKey: fresh.sessionKey }),
        bestEffort: true,
        // bestEffort reports provider failures here instead of rejecting.
        // Capture the first one so durable receipt state cannot advance to a
        // false success merely because the outer promise resolved.
        onError: (err) => {
          receiptError ??= err;
        },
      });
      if (receiptError) {
        throw receiptError;
      }
      await markOperationDelivery({ operationId: fresh.id, field: "receipt", state: "delivered" });
      clearRestartOperationRetry(fresh.id);
    } catch (err) {
      // A definite pre-send failure is retryable. Provider acceptance followed
      // by a transport error remains the standard unavoidable exactly-once gap.
      await markOperationDelivery({
        operationId: fresh.id,
        field: "receipt",
        state: "pending",
        error: String(err),
      });
      scheduleRestartOperationRetry({
        operationId: fresh.id,
        expiresAt: fresh.expiresAt,
        deps: params.deps,
      });
      return;
    }
  }

  const afterReceipt = (await readRestartSentinel())?.operation;
  if (
    !afterReceipt ||
    afterReceipt.id !== operation.id ||
    (afterReceipt.delivery.continuation !== "pending" &&
      afterReceipt.delivery.continuation !== "delivering") ||
    !afterReceipt.sessionKey
  ) {
    return;
  }
  await markOperationDelivery({
    operationId: afterReceipt.id,
    field: "continuation",
    state: "delivering",
  });
  const contextKey = buildSentinelRestartContinuationContext(afterReceipt.id);
  const alreadyQueued = peekSystemEventEntries(afterReceipt.sessionKey).some(
    (event) => event.contextKey === contextKey,
  );
  if (!alreadyQueued) {
    // The sentinel remains `delivering` until heartbeat execution consumes
    // this tagged input. A process crash clears this in-memory event but leaves
    // the durable sentinel replayable for the replacement process.
    enqueueSystemEvent(RESTART_CONTINUATION_PROMPT, {
      sessionKey: afterReceipt.sessionKey,
      contextKey,
    });
  }
  requestHeartbeatNow(
    scopedHeartbeatWakeOptions(afterReceipt.sessionKey, { reason: "restart-continuation" }),
  );
}

export async function scheduleRestartSentinelWake(params: { deps: CliDeps }) {
  const persisted = await readRestartSentinel();
  if (persisted?.operation) {
    await withRestartOperationLock(async () => {
      const current = await readRestartSentinel();
      if (current?.operation) {
        await reconcileRestartOperation({ operation: current.operation, deps: params.deps });
      }
    });
    return;
  }
  const sentinel = await consumeRestartSentinel();
  if (!sentinel) {
    return;
  }
  const payload = sentinel.payload;
  const sessionKey = payload.sessionKey?.trim();
  const message = formatRestartSentinelMessage(payload);
  const summary = summarizeRestartSentinel(payload);

  if (!sessionKey) {
    const mainSessionKey = resolveMainSessionKeyFromConfig();
    enqueueSystemEvent(message, { sessionKey: mainSessionKey });
    return;
  }

  const { baseSessionKey, threadId: sessionThreadId } = parseSessionThreadInfo(sessionKey);

  const { cfg, entry } = loadSessionEntry(sessionKey);
  const parsedTarget = resolveAnnounceTargetFromKey(baseSessionKey ?? sessionKey);

  // Prefer delivery context from sentinel (captured at restart) over session store
  // Handles race condition where store wasn't flushed before restart
  const sentinelContext = payload.deliveryContext;
  let sessionDeliveryContext = deliveryContextFromSession(entry);
  if (!sessionDeliveryContext && baseSessionKey && baseSessionKey !== sessionKey) {
    const { entry: baseEntry } = loadSessionEntry(baseSessionKey);
    sessionDeliveryContext = deliveryContextFromSession(baseEntry);
  }

  const origin = mergeDeliveryContext(
    sentinelContext,
    mergeDeliveryContext(sessionDeliveryContext, parsedTarget ?? undefined),
  );

  const channelRaw = origin?.channel;
  const channel = channelRaw ? normalizeChannelId(channelRaw) : null;
  const to = origin?.to;
  if (!channel || !to) {
    enqueueSystemEvent(message, { sessionKey });
    return;
  }

  const resolved = resolveOutboundTarget({
    channel,
    to,
    cfg,
    accountId: origin?.accountId,
    mode: "implicit",
  });
  if (!resolved.ok) {
    enqueueSystemEvent(message, { sessionKey });
    return;
  }

  const threadId =
    payload.threadId ??
    parsedTarget?.threadId ?? // From resolveAnnounceTargetFromKey (extracts :topic:N)
    sessionThreadId ??
    (origin?.threadId != null ? String(origin.threadId) : undefined);

  // Slack uses replyToId (thread_ts) for threading, not threadId.
  // The reply path does this mapping but deliverOutboundPayloads does not,
  // so we must convert here to ensure post-restart notifications land in
  // the originating Slack thread. See #17716.
  const isSlack = channel === "slack";
  const replyToId = isSlack && threadId != null && threadId !== "" ? String(threadId) : undefined;
  const resolvedThreadId = isSlack ? undefined : threadId;
  const outboundSession = buildOutboundSessionContext({
    cfg,
    sessionKey,
  });

  try {
    await deliverOutboundPayloads({
      cfg,
      channel,
      to: resolved.to,
      accountId: origin?.accountId,
      replyToId,
      threadId: resolvedThreadId,
      payloads: [{ text: message }],
      session: outboundSession,
      bestEffort: true,
    });
  } catch (err) {
    enqueueSystemEvent(`${summary}\n${String(err)}`, { sessionKey });
  }
}

export function shouldWakeFromRestartSentinel() {
  return !process.env.VITEST && process.env.NODE_ENV !== "test";
}
