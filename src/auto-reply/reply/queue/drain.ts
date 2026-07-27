import { defaultRuntime } from "../../../runtime.js";
import { resolveGlobalMap } from "../../../shared/global-singleton.js";
import {
  buildCollectPrompt,
  beginQueueDrain,
  drainCollectQueueStep,
  drainNextQueueItem,
  hasCrossChannelItems,
  previewQueueSummaryPrompt,
  waitForQueueDebounce,
} from "../../../utils/queue-helpers.js";
import { isRoutableChannel } from "../route-reply.js";
import {
  ackDurableFollowup,
  completeDurableFollowup,
  DurableFollowupActiveOwnerError,
  DURABLE_FOLLOWUP_RETRY_BASE_MS,
  hydrateDurableFollowup,
  loadDurableFollowupDeliveryCarrier,
  scheduleDurableFollowupRetries,
} from "./durable-store.js";
import { FOLLOWUP_QUEUES, syncFollowupQueueSummary, type FollowupQueueState } from "./state.js";
import type { FollowupRun } from "./types.js";

// Persists the most recent runFollowup callback per queue key so that
// enqueueFollowupRun can restart a drain that finished and deleted the queue.
const FOLLOWUP_DRAIN_CALLBACKS_KEY = Symbol.for("openclaw.followupDrainCallbacks");

const FOLLOWUP_RUN_CALLBACKS = resolveGlobalMap<string, (run: FollowupRun) => Promise<void>>(
  FOLLOWUP_DRAIN_CALLBACKS_KEY,
);

/**
 * Durable records removed from the live item list by `drop:summarize` cannot
 * be deleted yet: their only replacement is the summary text held in RAM.
 * Update expiry metadata after durable persistence. The summary contribution
 * itself is recorded at the exact item-removal boundary in enqueue.ts.
 */
export function retainSummarizedDurableFollowups(
  queue: FollowupQueueState,
  ids: Iterable<string>,
  expiresAtById?: ReadonlyMap<string, number>,
): void {
  for (const id of ids) {
    const entry = queue.summarizedDurableFollowups?.get(id);
    if (!entry) {
      continue;
    }
    const expiresAt = expiresAtById?.get(id);
    if (typeof expiresAt === "number") {
      entry.expiresAt = expiresAt;
    }
  }
}

function snapshotSummarizedDurableFollowups(queue: FollowupQueueState): string[] {
  return [...(queue.summarizedDurableFollowups?.keys() ?? [])];
}

function collectDurableIds(items: FollowupRun[], summarizedIds: string[] = []): string[] {
  return [...new Set([...items.map((item) => item.durableId), ...summarizedIds])].filter(
    (id): id is string => Boolean(id?.trim()),
  );
}

function collectQueueDurableIds(queue: FollowupQueueState): string[] {
  return collectDurableIds(queue.items, snapshotSummarizedDurableFollowups(queue));
}

/**
 * Return a completed delivery carrier only when it owns the FIFO queue head.
 *
 * Restored carriers and same-process failed deliveries both expose
 * `deliveryPayloads`. Ordinary queue items must avoid a disk probe here so the
 * scheduler preserves its immediate-start contract.
 */
async function loadStagedDeliveryAtQueueHead(queue: FollowupQueueState): Promise<
  | {
      carrierId: string;
      sourceDurableIds: string[];
      run: FollowupRun;
    }
  | undefined
> {
  const first = queue.items[0];
  const firstDurableId = first?.durableId?.trim();
  if (!first || !firstDurableId) {
    return undefined;
  }
  if (first.deliveryPayloads === undefined) {
    return undefined;
  }
  const staged = await loadDurableFollowupDeliveryCarrier(firstDurableId);
  if (staged?.delivery && staged.id === firstDurableId) {
    return {
      carrierId: staged.id,
      sourceDurableIds: staged.delivery.sourceDurableIds,
      run: hydrateDurableFollowup(staged, first.run.config),
    };
  }
  return undefined;
}

/**
 * Project a synthetic collect/summary delivery stage back onto its live FIFO
 * carrier. The runner mutates the synthetic run after persisting its outbound
 * payload; retaining that marker avoids replaying the model turn after a route
 * failure while leaving newer queue items untouched.
 */
function retainStagedDeliveryOnQueue(
  queue: FollowupQueueState,
  run: FollowupRun | undefined,
): void {
  if (!run?.durableId || run.deliveryPayloads === undefined) {
    return;
  }
  const carrier = queue.items.find((item) => item.durableId === run.durableId);
  if (!carrier) {
    return;
  }
  carrier.durableIds = run.durableIds;
  carrier.deliveryPayloads = run.deliveryPayloads;
}

/** Remove only the FIFO head and summary entries represented by a staged turn. */
function consumeStagedDeliveryQueueHead(
  queue: FollowupQueueState,
  sourceDurableIds: string[],
): void {
  const represented = new Set(sourceDurableIds);
  let itemCount = 0;
  for (const item of queue.items) {
    if (!item.durableId || !represented.has(item.durableId)) {
      break;
    }
    itemCount += 1;
  }
  queue.items.splice(0, itemCount);
  for (const id of represented) {
    queue.summarizedDurableFollowups?.delete(id);
  }
  syncFollowupQueueSummary(queue);
}

async function waitForDurableRetry(queue: FollowupQueueState): Promise<void> {
  const nextAttemptAt = queue.nextAttemptAt;
  if (typeof nextAttemptAt !== "number") {
    return;
  }
  const delayMs = nextAttemptAt - Date.now();
  if (delayMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
  // Clear only the boundary we observed. An enqueue/failure racing this wait
  // may publish a later one that the next loop must still honor.
  if (queue.nextAttemptAt === nextAttemptAt) {
    queue.nextAttemptAt = undefined;
  }
}

async function discardExpiredDurableItems(queue: FollowupQueueState): Promise<void> {
  const now = Date.now();
  const expiredItemIds = queue.items
    .filter((item) => typeof item.durableExpiresAt === "number" && item.durableExpiresAt <= now)
    .map((item) => item.durableId)
    .filter((id): id is string => Boolean(id));
  const expiredSummaryIds = [...(queue.summarizedDurableFollowups?.values() ?? [])]
    .filter((entry) => typeof entry.expiresAt === "number" && entry.expiresAt <= now)
    .map((entry) => entry.id);
  const expiredIds = [...new Set([...expiredItemIds, ...expiredSummaryIds])];
  if (expiredIds.length === 0) {
    return;
  }
  const expired = new Set(expiredIds);
  await Promise.all(expiredIds.map((id) => ackDurableFollowup(id)));
  queue.items = queue.items.filter((item) => !item.durableId || !expired.has(item.durableId));
  for (const id of expiredSummaryIds) {
    queue.summarizedDurableFollowups?.delete(id);
  }
  syncFollowupQueueSummary(queue);
}

async function completeSummarizedDurableFollowups(
  queue: FollowupQueueState,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  // Delete from the in-memory ownership set only after every disk ack succeeds.
  // IDs added while the summary turn is running are intentionally left for the
  // next summary snapshot, because the current prompt did not represent them.
  await Promise.all(ids.map((id) => completeDurableFollowup(id)));
  for (const id of ids) {
    queue.summarizedDurableFollowups?.delete(id);
  }
  syncFollowupQueueSummary(queue);
}

type QueueSummarySnapshot = Pick<
  FollowupQueueState,
  "dropPolicy" | "droppedCount" | "summaryLines"
> & {
  processLocalDroppedCount: number;
  summarySequence: number;
};

function captureQueueSummaryState(queue: FollowupQueueState): QueueSummarySnapshot {
  return {
    dropPolicy: queue.dropPolicy,
    droppedCount: queue.droppedCount,
    summaryLines: [...queue.summaryLines],
    processLocalDroppedCount: queue.processLocalDroppedCount ?? 0,
    summarySequence: queue.summarySequence ?? 0,
  };
}

function renderQueueSummarySnapshot(snapshot: QueueSummarySnapshot): string | undefined {
  // The shared prompt helper consumes its input. Render from a clone so failed
  // processing leaves the live summary available for the next drain attempt.
  return previewQueueSummaryPrompt({
    state: { ...snapshot, summaryLines: [...snapshot.summaryLines] },
    noun: "message",
  });
}

function consumeQueueSummarySnapshot(
  queue: FollowupQueueState,
  snapshot: QueueSummarySnapshot,
): void {
  if (snapshot.droppedCount <= 0) {
    return;
  }
  // Enqueue can append more drops while the summary turn is running. Consume
  // only the snapshotted prefix; keep the newest bounded lines for the next
  // prompt instead of clearing work the successful turn never represented.
  queue.processLocalDroppedCount = Math.max(
    0,
    (queue.processLocalDroppedCount ?? 0) - snapshot.processLocalDroppedCount,
  );
  queue.processLocalSummaryEntries = (queue.processLocalSummaryEntries ?? []).filter(
    (entry) => entry.sequence > snapshot.summarySequence,
  );
  syncFollowupQueueSummary(queue);
}

export function clearFollowupDrainCallback(key: string): void {
  FOLLOWUP_RUN_CALLBACKS.delete(key);
}

/** Restart the drain for `key` if it is currently idle, using the stored callback. */
export function kickFollowupDrainIfIdle(key: string): void {
  const cb = FOLLOWUP_RUN_CALLBACKS.get(key);
  if (!cb) {
    return;
  }
  scheduleFollowupDrain(key, cb);
}

type OriginRoutingMetadata = Pick<
  FollowupRun,
  "originatingChannel" | "originatingTo" | "originatingAccountId" | "originatingThreadId"
>;

function resolveOriginRoutingMetadata(items: FollowupRun[]): OriginRoutingMetadata {
  return {
    originatingChannel: items.find((item) => item.originatingChannel)?.originatingChannel,
    originatingTo: items.find((item) => item.originatingTo)?.originatingTo,
    originatingAccountId: items.find((item) => item.originatingAccountId)?.originatingAccountId,
    // Support both number (Telegram topic) and string (Slack thread_ts) thread IDs.
    originatingThreadId: items.find(
      (item) => item.originatingThreadId != null && item.originatingThreadId !== "",
    )?.originatingThreadId,
  };
}

function resolveCrossChannelKey(item: FollowupRun): { cross?: true; key?: string } {
  const { originatingChannel: channel, originatingTo: to, originatingAccountId: accountId } = item;
  const threadId = item.originatingThreadId;
  if (!channel && !to && !accountId && (threadId == null || threadId === "")) {
    return {};
  }
  if (!isRoutableChannel(channel) || !to) {
    return { cross: true };
  }
  // Support both number (Telegram topic IDs) and string (Slack thread_ts) thread IDs.
  const threadKey = threadId != null && threadId !== "" ? String(threadId) : "";
  return {
    key: [channel, to, accountId || "", threadKey].join("|"),
  };
}

export function scheduleFollowupDrain(
  key: string,
  runFollowup: (run: FollowupRun) => Promise<void>,
): void {
  const queue = beginQueueDrain(FOLLOWUP_QUEUES, key);
  if (!queue) {
    return;
  }
  // Cache callback only when a drain actually starts. Avoid keeping stale
  // callbacks around from finalize calls where no queue work is pending.
  FOLLOWUP_RUN_CALLBACKS.set(key, runFollowup);
  void (async () => {
    let attemptedDurableIds: string[] = [];
    let attemptedRun: FollowupRun | undefined;
    try {
      const collectState = { forceIndividualCollect: false };
      while (queue.items.length > 0 || queue.droppedCount > 0) {
        await waitForDurableRetry(queue);
        await discardExpiredDurableItems(queue);
        if (queue.items.length === 0 && queue.droppedCount === 0) {
          break;
        }
        await waitForQueueDebounce(queue);
        const stagedHead = await loadStagedDeliveryAtQueueHead(queue);
        if (stagedHead) {
          // A completed turn owns only this FIFO head. A later enqueue must
          // survive for a fresh model turn after the staged send succeeds.
          attemptedDurableIds = [stagedHead.carrierId];
          await runFollowup(stagedHead.run);
          await completeDurableFollowup(stagedHead.carrierId);
          consumeStagedDeliveryQueueHead(queue, stagedHead.sourceDurableIds);
          attemptedDurableIds = [];
          continue;
        }
        if (queue.mode === "collect") {
          // Once the batch is mixed, never collect again within this drain.
          // Prevents “collect after shift” collapsing different targets.
          //
          // Debug: `pnpm test src/auto-reply/reply/reply-flow.test.ts`
          // Check if messages span multiple channels.
          // If so, process individually to preserve per-message routing.
          const isCrossChannel = hasCrossChannelItems(queue.items, resolveCrossChannelKey);

          const collectDrainResult = await drainCollectQueueStep({
            collectState,
            isCrossChannel,
            items: queue.items,
            run: async (item) => {
              attemptedDurableIds = collectDurableIds([item]);
              attemptedRun = item;
              await runFollowup(item);
              // Mixed-target collect mode shifts exactly one item after this
              // callback succeeds. Match that removal boundary on disk so a
              // restart cannot resurrect work that already completed.
              await completeDurableFollowup(item.durableId);
              attemptedDurableIds = [];
            },
          });
          if (collectDrainResult === "empty") {
            break;
          }
          if (collectDrainResult === "drained") {
            continue;
          }

          const items = queue.items.slice();
          const summaryState = captureQueueSummaryState(queue);
          const summarizedDurableIds = snapshotSummarizedDurableFollowups(queue);
          const summary = renderQueueSummarySnapshot(summaryState);
          const run = items.at(-1)?.run ?? queue.lastRun;
          if (!run) {
            break;
          }

          const routing = resolveOriginRoutingMetadata(items);

          const prompt = buildCollectPrompt({
            title: "[Queued messages while agent was busy]",
            items,
            summary,
            renderItem: (item, idx) => `---\nQueued #${idx + 1}\n${item.prompt}`.trim(),
          });
          const collectedRun: FollowupRun = {
            prompt,
            run,
            enqueuedAt: Date.now(),
            // A collected turn is synthetic, but its failure semantics are not:
            // every represented disk record must survive model/routing errors.
            durableIds: collectDurableIds(items, summarizedDurableIds),
            ...routing,
          };
          attemptedDurableIds = collectDurableIds(items, summarizedDurableIds);
          attemptedRun = collectedRun;
          await runFollowup(collectedRun);
          // The collected turn represents every snapshotted item. Only remove
          // their records after the agent turn and reply routing both return.
          await Promise.all(items.map((item) => completeDurableFollowup(item.durableId)));
          if (summary) {
            await completeSummarizedDurableFollowups(queue, summarizedDurableIds);
            consumeQueueSummarySnapshot(queue, summaryState);
          }
          queue.items.splice(0, items.length);
          attemptedDurableIds = [];
          continue;
        }

        const summaryState = captureQueueSummaryState(queue);
        const summarizedDurableIds = snapshotSummarizedDurableFollowups(queue);
        const summaryPrompt = renderQueueSummarySnapshot(summaryState);
        if (summaryPrompt) {
          const run = queue.lastRun;
          if (!run) {
            break;
          }
          if (
            !(await drainNextQueueItem(queue.items, async (item) => {
              const summaryRun: FollowupRun = {
                prompt: summaryPrompt,
                run,
                enqueuedAt: Date.now(),
                // Include both the carrier item and overflow records represented
                // only by this summary so delivery staging covers the full turn.
                durableIds: collectDurableIds([item], summarizedDurableIds),
                originatingChannel: item.originatingChannel,
                originatingTo: item.originatingTo,
                originatingAccountId: item.originatingAccountId,
                originatingThreadId: item.originatingThreadId,
              };
              attemptedDurableIds = collectDurableIds([item], summarizedDurableIds);
              attemptedRun = summaryRun;
              await runFollowup(summaryRun);
              await completeDurableFollowup(item.durableId);
              await completeSummarizedDurableFollowups(queue, summarizedDurableIds);
              consumeQueueSummarySnapshot(queue, summaryState);
              attemptedDurableIds = [];
            }))
          ) {
            break;
          }
          continue;
        }

        if (
          !(await drainNextQueueItem(queue.items, async (item) => {
            attemptedDurableIds = collectDurableIds([item]);
            attemptedRun = item;
            await runFollowup(item);
            await completeDurableFollowup(item.durableId);
            attemptedDurableIds = [];
          }))
        ) {
          break;
        }
      }
    } catch (err) {
      queue.lastEnqueuedAt = Date.now();
      retainStagedDeliveryOnQueue(queue, attemptedRun);
      if (err instanceof DurableFollowupActiveOwnerError) {
        // A replacement gateway may restore disk state while the old process
        // still owns transport finalization. Never rewrite that carrier from
        // this process: the live owner can still replace its blocker with an
        // exact final or delete it after provider confirmation.
        queue.nextAttemptAt = Date.now() + DURABLE_FOLLOWUP_RETRY_BASE_MS;
        defaultRuntime.log?.(`followup queue waiting for active owner ${err.ownerPid}`);
        return;
      }
      try {
        // Only the attempted turn earns backoff. Collect/summary attempts name
        // every represented record; untouched FIFO items keep attempt zero.
        const retry = await scheduleDurableFollowupRetries({
          ids: attemptedDurableIds.length > 0 ? attemptedDurableIds : collectQueueDurableIds(queue),
        });
        const terminalIds = new Set(retry.terminalIds);
        if (terminalIds.size > 0) {
          queue.items = queue.items.filter(
            (item) => !item.durableId || !terminalIds.has(item.durableId),
          );
          for (const id of terminalIds) {
            queue.summarizedDurableFollowups?.delete(id);
          }
          syncFollowupQueueSummary(queue);
        }
        const updates = new Map(retry.scheduled.map((update) => [update.id, update]));
        for (const item of queue.items) {
          const update = item.durableId ? updates.get(item.durableId) : undefined;
          if (update) {
            item.durableRetryCount = update.retryCount;
            item.durableNextAttemptAt = update.nextAttemptAt;
            item.durableExpiresAt = update.expiresAt;
          }
        }
        for (const update of retry.scheduled) {
          const summarized = queue.summarizedDurableFollowups?.get(update.id);
          if (summarized) {
            summarized.expiresAt = update.expiresAt;
          }
        }
        if (retry.scheduled.length > 0) {
          queue.nextAttemptAt = Math.max(
            queue.nextAttemptAt ?? 0,
            ...retry.scheduled.map((update) => update.nextAttemptAt),
          );
        } else if (queue.items.length > 0 || queue.droppedCount > 0) {
          // Process-local/test-only work has no disk record. It still needs a
          // floor so debounce=0 cannot create a tight retry loop.
          queue.nextAttemptAt = Date.now() + DURABLE_FOLLOWUP_RETRY_BASE_MS;
        }
      } catch (retryErr) {
        // A persistence failure must not become a paid hot loop. Keep the live
        // process bounded while leaving the original disk input untouched.
        queue.nextAttemptAt = Date.now() + DURABLE_FOLLOWUP_RETRY_BASE_MS;
        defaultRuntime.error?.(`followup queue retry state failed for ${key}: ${String(retryErr)}`);
      }
      defaultRuntime.error?.(`followup queue drain failed for ${key}: ${String(err)}`);
    } finally {
      queue.draining = false;
      if (queue.items.length === 0 && queue.droppedCount === 0) {
        FOLLOWUP_QUEUES.delete(key);
      } else {
        scheduleFollowupDrain(key, runFollowup);
      }
    }
  })();
}
