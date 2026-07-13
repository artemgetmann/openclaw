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
import { completeDurableFollowup } from "./durable-store.js";
import { FOLLOWUP_QUEUES, type FollowupQueueState } from "./state.js";
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
 * Keep their IDs on the process-global queue object so both successful drain
 * and explicit cancellation can acknowledge the same ownership set.
 */
export function retainSummarizedDurableFollowups(
  queue: FollowupQueueState,
  ids: Iterable<string>,
): void {
  const pending = (queue.summarizedDurableIds ??= new Set<string>());
  for (const id of ids) {
    if (!id.trim()) {
      continue;
    }
    pending.add(id);
  }
}

function snapshotSummarizedDurableFollowups(queue: FollowupQueueState): string[] {
  return [...(queue.summarizedDurableIds ?? [])];
}

function collectDurableIds(items: FollowupRun[], summarizedIds: string[] = []): string[] {
  return [...new Set([...items.map((item) => item.durableId), ...summarizedIds])].filter(
    (id): id is string => Boolean(id?.trim()),
  );
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
    queue.summarizedDurableIds?.delete(id);
  }
}

type QueueSummarySnapshot = Pick<
  FollowupQueueState,
  "dropPolicy" | "droppedCount" | "summaryLines"
>;

function captureQueueSummaryState(queue: FollowupQueueState): QueueSummarySnapshot {
  return {
    dropPolicy: queue.dropPolicy,
    droppedCount: queue.droppedCount,
    summaryLines: [...queue.summaryLines],
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
  const newerDroppedCount = Math.max(0, queue.droppedCount - snapshot.droppedCount);
  const newerLineCount = Math.min(newerDroppedCount, queue.cap, queue.summaryLines.length);
  queue.droppedCount = newerDroppedCount;
  queue.summaryLines = newerLineCount > 0 ? queue.summaryLines.slice(-newerLineCount) : [];
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
    try {
      const collectState = { forceIndividualCollect: false };
      while (queue.items.length > 0 || queue.droppedCount > 0) {
        await waitForQueueDebounce(queue);
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
              await runFollowup(item);
              // Mixed-target collect mode shifts exactly one item after this
              // callback succeeds. Match that removal boundary on disk so a
              // restart cannot resurrect work that already completed.
              await completeDurableFollowup(item.durableId);
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
          await runFollowup({
            prompt,
            run,
            enqueuedAt: Date.now(),
            // A collected turn is synthetic, but its failure semantics are not:
            // every represented disk record must survive model/routing errors.
            durableIds: collectDurableIds(items, summarizedDurableIds),
            ...routing,
          });
          // The collected turn represents every snapshotted item. Only remove
          // their records after the agent turn and reply routing both return.
          await Promise.all(items.map((item) => completeDurableFollowup(item.durableId)));
          if (summary) {
            await completeSummarizedDurableFollowups(queue, summarizedDurableIds);
            consumeQueueSummarySnapshot(queue, summaryState);
          }
          queue.items.splice(0, items.length);
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
              await runFollowup({
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
              });
              await completeDurableFollowup(item.durableId);
              await completeSummarizedDurableFollowups(queue, summarizedDurableIds);
              consumeQueueSummarySnapshot(queue, summaryState);
            }))
          ) {
            break;
          }
          continue;
        }

        if (
          !(await drainNextQueueItem(queue.items, async (item) => {
            await runFollowup(item);
            await completeDurableFollowup(item.durableId);
          }))
        ) {
          break;
        }
      }
    } catch (err) {
      queue.lastEnqueuedAt = Date.now();
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
