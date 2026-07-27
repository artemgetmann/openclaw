import { loadConfig } from "../../../config/config.js";
import { createDedupeCache } from "../../../infra/dedupe.js";
import { resolveGlobalSingleton } from "../../../shared/global-singleton.js";
import { applyQueueDropPolicy, shouldSkipQueueItem } from "../../../utils/queue-helpers.js";
import {
  kickFollowupDrainIfIdle,
  retainSummarizedDurableFollowups,
  scheduleFollowupDrain,
} from "./drain.js";
import {
  ackDurableFollowup,
  cleanupDurableProcessedMessages,
  DurableFollowupCancelledError,
  hydrateDurableFollowup,
  isDurableFollowupRecordCancelled,
  isDurableFollowupMessageProcessed,
  isDurableFollowupRecordProcessed,
  loadDurableFollowups,
  persistDurableFollowup,
} from "./durable-store.js";
import {
  getExistingFollowupQueue,
  getFollowupQueue,
  recordFollowupQueueSummaryDrops,
  syncFollowupQueueSummary,
  type FollowupQueueState,
} from "./state.js";
import type { FollowupRun, QueueDedupeMode, QueueSettings } from "./types.js";

/**
 * Keep queued message-id dedupe shared across bundled chunks so redeliveries
 * are rejected no matter which chunk receives the enqueue call.
 */
const RECENT_QUEUE_MESSAGE_IDS_KEY = Symbol.for("openclaw.recentQueueMessageIds");

const RECENT_QUEUE_MESSAGE_IDS = resolveGlobalSingleton(RECENT_QUEUE_MESSAGE_IDS_KEY, () =>
  createDedupeCache({
    ttlMs: 5 * 60 * 1000,
    maxSize: 10_000,
  }),
);

function buildRecentMessageIdKey(run: FollowupRun, queueKey: string): string | undefined {
  const messageId = run.messageId?.trim();
  if (!messageId) {
    return undefined;
  }
  // Use JSON tuple serialization to avoid delimiter-collision edge cases when
  // channel/to/account values contain "|" characters.
  return JSON.stringify([
    "queue",
    queueKey,
    run.originatingChannel ?? "",
    run.originatingTo ?? "",
    run.originatingAccountId ?? "",
    run.originatingThreadId == null ? "" : String(run.originatingThreadId),
    messageId,
  ]);
}

function isRunAlreadyQueued(
  run: FollowupRun,
  items: FollowupRun[],
  allowPromptFallback = false,
): boolean {
  const hasSameRouting = (item: FollowupRun) =>
    item.originatingChannel === run.originatingChannel &&
    item.originatingTo === run.originatingTo &&
    item.originatingAccountId === run.originatingAccountId &&
    item.originatingThreadId === run.originatingThreadId;

  const messageId = run.messageId?.trim();
  if (messageId) {
    return items.some((item) => item.messageId?.trim() === messageId && hasSameRouting(item));
  }
  if (!allowPromptFallback) {
    return false;
  }
  return items.some((item) => item.prompt === run.prompt && hasSameRouting(item));
}

export function enqueueFollowupRun(
  key: string,
  run: FollowupRun,
  settings: QueueSettings,
  dedupeMode: QueueDedupeMode = "message-id",
): boolean {
  const queue = getFollowupQueue(key, settings);
  const recentMessageIdKey = dedupeMode !== "none" ? buildRecentMessageIdKey(run, key) : undefined;
  if (recentMessageIdKey && RECENT_QUEUE_MESSAGE_IDS.peek(recentMessageIdKey)) {
    return false;
  }

  const dedupe =
    dedupeMode === "none"
      ? undefined
      : (item: FollowupRun, items: FollowupRun[]) =>
          isRunAlreadyQueued(item, items, dedupeMode === "prompt");

  // Deduplicate: skip if the same message is already queued.
  if (shouldSkipQueueItem({ item: run, items: queue.items, dedupe })) {
    return false;
  }

  queue.lastEnqueuedAt = Date.now();
  queue.lastRun = run.run;
  if (typeof run.durableNextAttemptAt === "number") {
    // Preserve FIFO ownership: newer work cannot pull an older restored retry
    // forward. The queue waits for the latest durable boundary it owns.
    queue.nextAttemptAt = Math.max(queue.nextAttemptAt ?? 0, run.durableNextAttemptAt);
  }

  // The shared helper mutates the aggregate summary projection. Snapshot the
  // concrete items first, then replace that projection from provenance-aware
  // entries so one durable expiry never requires matching summary text.
  syncFollowupQueueSummary(queue);
  const itemsBeforeDrop = queue.items.slice();
  const shouldEnqueue = applyQueueDropPolicy({
    queue,
    summarize: (item) => item.summaryLine?.trim() || item.prompt.trim(),
  });
  if (!shouldEnqueue) {
    return false;
  }
  const droppedCount = itemsBeforeDrop.length - queue.items.length;
  if (queue.dropPolicy === "summarize" && droppedCount > 0) {
    recordFollowupQueueSummaryDrops(queue, itemsBeforeDrop.slice(0, droppedCount));
  }

  queue.items.push(run);
  if (recentMessageIdKey) {
    RECENT_QUEUE_MESSAGE_IDS.check(recentMessageIdKey);
  }
  // If drain finished and deleted the queue before this item arrived, a new queue
  // object was created (draining: false) but nobody scheduled a drain for it.
  // Use the cached callback to restart the drain now.
  if (!queue.draining) {
    kickFollowupDrainIfIdle(key);
  }
  return true;
}

/**
 * Persist-before-enqueue is the acknowledgement boundary for busy-session
 * inbound messages. Callers must await this function before allowing their
 * transport offset/cursor to advance.
 */
export type DurableFollowupEnqueueResult =
  | { accepted: true; durableId: string }
  | { accepted: false };

export async function enqueueFollowupRunDurableWithReceipt(
  key: string,
  run: FollowupRun,
  settings: QueueSettings,
  dedupeMode: QueueDedupeMode = "message-id",
): Promise<DurableFollowupEnqueueResult> {
  // A provider may redeliver after this queue has successfully drained but
  // before its transport cursor reaches disk. Check the bounded durable receipt
  // before creating a second replayable input record.
  if (await isDurableFollowupMessageProcessed({ queueKey: key, run })) {
    return { accepted: false };
  }
  let record;
  try {
    record = await persistDurableFollowup({ queueKey: key, run, settings });
  } catch (err) {
    if (err instanceof DurableFollowupCancelledError) {
      return { accepted: false };
    }
    throw err;
  }
  // The cancellation may run after persistence's post-write check but before
  // this continuation resumes. From here through RAM enqueue is synchronous,
  // so this final cutoff check closes the remaining interleaving window.
  if (isDurableFollowupRecordCancelled(record)) {
    await ackDurableFollowup(record.id);
    return { accepted: false };
  }
  // Close the race where the original drain publishes its success receipt
  // while this duplicate's initial receipt lookup/persist is in flight.
  if (await isDurableFollowupRecordProcessed(record)) {
    await ackDurableFollowup(record.id);
    return { accepted: false };
  }
  const beforeItems = new Map(
    (getExistingFollowupQueue(key)?.items ?? [])
      .filter((item): item is FollowupRun & { durableId: string } => Boolean(item.durableId))
      .map((item) => [item.durableId, item]),
  );
  const accepted = enqueueFollowupRun(
    key,
    { ...run, durableId: record.id, durableExpiresAt: record.expiresAt },
    settings,
    dedupeMode,
  );
  if (!accepted) {
    await ackDurableFollowup(record.id);
    return { accepted: false };
  }
  const afterIds = new Set(
    (getExistingFollowupQueue(key)?.items ?? [])
      .map((item) => item.durableId)
      .filter((id): id is string => Boolean(id)),
  );
  await handleRemovedDurableFollowups({
    queue: getExistingFollowupQueue(key),
    beforeItems,
    afterIds,
  });
  return { accepted: true, durableId: record.id };
}

/**
 * Compatibility wrapper for callers that only need the historical boolean.
 * Channel UX should use the receipt variant so the visible control addresses
 * one exact durable item instead of inferring queue state.
 */
export async function enqueueFollowupRunDurable(
  key: string,
  run: FollowupRun,
  settings: QueueSettings,
  dedupeMode: QueueDedupeMode = "message-id",
  onAccepted?: (durableId: string) => Promise<void> | void,
): Promise<boolean> {
  const result = await enqueueFollowupRunDurableWithReceipt(key, run, settings, dedupeMode);
  if (result.accepted) {
    await onAccepted?.(result.durableId);
  }
  return result.accepted;
}

async function handleRemovedDurableFollowups(params: {
  queue: FollowupQueueState | undefined;
  beforeItems: Map<string, FollowupRun>;
  afterIds: Set<string>;
}): Promise<void> {
  const removedIds = [...params.beforeItems.keys()].filter((id) => !params.afterIds.has(id));
  if (params.queue?.dropPolicy === "summarize") {
    // The replacement summary is process-local until its followup turn returns.
    // Retaining these disk records makes a crash replay the original accepted
    // messages instead of silently losing work represented only in RAM.
    retainSummarizedDurableFollowups(
      params.queue,
      removedIds,
      new Map(
        removedIds.flatMap((id) => {
          const expiresAt = params.beforeItems.get(id)?.durableExpiresAt;
          return typeof expiresAt === "number" ? [[id, expiresAt] as const] : [];
        }),
      ),
    );
    return;
  }
  // `drop:old` is explicit durable intent, so a restart must not resurrect it.
  await Promise.all(removedIds.map((id) => ackDurableFollowup(id)));
}

/** Restore disk-backed items before channels begin accepting new updates. */
export async function restoreDurableFollowupRuns(params?: {
  runFollowup?: (run: FollowupRun) => Promise<void>;
}): Promise<number> {
  // Startup is the guaranteed maintenance tick even when no new completions
  // occur. Keep normal runner delivery lookups O(queue-records), not O(10k
  // processed receipts), by pruning explicitly at restore instead.
  await cleanupDurableProcessedMessages();
  const records = await loadDurableFollowups();
  const config = loadConfig();
  const restoredQueueKeys = new Set<string>();
  let restored = 0;
  for (const record of records) {
    if (await isDurableFollowupRecordProcessed(record)) {
      // Completion receipts are the durable source of truth if an unlink failed
      // after delivery. Do not resurrect that stale queue input on startup.
      await ackDurableFollowup(record.id);
      continue;
    }
    const existingItems = getExistingFollowupQueue(record.queueKey)?.items ?? [];
    if (existingItems.some((item) => item.durableId === record.id)) {
      // Queue state is process-global and can survive a SIGUSR1 module reload.
      // The durable directory remains the restore source, but one record must
      // still correspond to at most one live queue item in this process.
      continue;
    }
    // The disk directory is already the dedupe source. In-memory message-id
    // caches may have survived a module reload, so they must not suppress a
    // record whose durable acknowledgement still exists.
    const before = new Map(
      (getExistingFollowupQueue(record.queueKey)?.items ?? [])
        .filter((item): item is FollowupRun & { durableId: string } => Boolean(item.durableId))
        .map((item) => [item.durableId, item]),
    );
    if (
      enqueueFollowupRun(
        record.queueKey,
        hydrateDurableFollowup(record, config),
        record.settings,
        "none",
      )
    ) {
      restored += 1;
      restoredQueueKeys.add(record.queueKey);
      const after = new Set(
        (getExistingFollowupQueue(record.queueKey)?.items ?? [])
          .map((item) => item.durableId)
          .filter((id): id is string => Boolean(id)),
      );
      await handleRemovedDurableFollowups({
        queue: getExistingFollowupQueue(record.queueKey),
        beforeItems: before,
        afterIds: after,
      });
    }
  }
  if (params?.runFollowup) {
    // A fresh process has no callback cache. Restoring records into RAM alone
    // therefore cannot start their drains; every restored queue must be armed
    // explicitly before channel cursors are allowed to accept newer work.
    for (const queueKey of restoredQueueKeys) {
      scheduleFollowupDrain(queueKey, params.runFollowup);
    }
  }
  return restored;
}

export function getFollowupQueueDepth(key: string): number {
  const queue = getExistingFollowupQueue(key);
  if (!queue) {
    return 0;
  }
  return queue.items.length;
}

export function resetRecentQueuedMessageIdDedupe(): void {
  RECENT_QUEUE_MESSAGE_IDS.clear();
}
