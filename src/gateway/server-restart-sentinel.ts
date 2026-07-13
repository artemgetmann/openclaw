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

const RESTART_CONTINUATION_PROMPT = [
  "The gateway restarted while this session had active work.",
  "Reassess the current external state before continuing from the latest user intent.",
  "Never blindly repeat an irreversible side effect such as sending, publishing, deleting, paying, or restarting.",
  "If the task is already complete, report that and stop. If no task remains active, do nothing.",
].join(" ");

function buildRecoveryReceipt(operation: RestartOperationRecord): string {
  const detail = operation.note ?? operation.reason;
  return detail
    ? `Gateway restarted and is back online. ${detail}`
    : "Gateway restarted and is back online.";
}

async function markOperationDelivery(params: {
  operationId: string;
  field: "receipt" | "continuation";
  state: RestartOperationRecord["delivery"]["receipt"];
  error?: string;
}): Promise<void> {
  await updateRestartSentinel((current) => {
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
}

async function reconcileRestartOperation(params: {
  operation: RestartOperationRecord;
}): Promise<void> {
  const { operation } = params;
  const now = Date.now();
  if (operation.expiresAt <= now) {
    await updateRestartSentinel((current) => {
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
    return;
  }

  if (fresh.delivery.receipt === "pending") {
    await markOperationDelivery({ operationId: fresh.id, field: "receipt", state: "delivering" });
    try {
      if (fresh.channel && fresh.to) {
        const { cfg } = loadSessionEntry(fresh.sessionKey ?? resolveMainSessionKeyFromConfig());
        const channel = normalizeChannelId(fresh.channel);
        const resolved = channel
          ? resolveOutboundTarget({
              channel,
              to: fresh.to,
              cfg,
              accountId: fresh.accountId,
              mode: "implicit",
            })
          : null;
        if (!channel || !resolved?.ok) {
          throw new Error("restart receipt route is unavailable");
        }
        let receiptError: unknown;
        await deliverOutboundPayloads({
          cfg,
          channel,
          to: resolved.to,
          accountId: fresh.accountId,
          threadId: channel === "slack" ? undefined : fresh.topicId,
          replyToId: channel === "slack" ? fresh.topicId : undefined,
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
      }
      await markOperationDelivery({ operationId: fresh.id, field: "receipt", state: "delivered" });
    } catch (err) {
      // A definite pre-send failure is retryable. Provider acceptance followed
      // by a transport error remains the standard unavoidable exactly-once gap.
      await markOperationDelivery({
        operationId: fresh.id,
        field: "receipt",
        state: "pending",
        error: String(err),
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
  const contextKey = `restart:${afterReceipt.id}`;
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

export async function scheduleRestartSentinelWake(_params: { deps: CliDeps }) {
  const persisted = await readRestartSentinel();
  if (persisted?.operation) {
    await withRestartOperationLock(async () => {
      const current = await readRestartSentinel();
      if (current?.operation) {
        await reconcileRestartOperation({ operation: current.operation });
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
