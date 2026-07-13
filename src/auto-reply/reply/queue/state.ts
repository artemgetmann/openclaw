import { resolveGlobalMap } from "../../../shared/global-singleton.js";
import { applyQueueRuntimeSettings, buildQueueSummaryLine } from "../../../utils/queue-helpers.js";
import { ackDurableFollowupsForQueueSync, ackDurableFollowupsSync } from "./durable-store.js";
import type { FollowupRun, QueueDropPolicy, QueueMode, QueueSettings } from "./types.js";

export type FollowupQueueSummaryEntry = {
  sequence: number;
  summaryLine: string;
};

export type SummarizedDurableFollowup = FollowupQueueSummaryEntry & {
  id: string;
  expiresAt?: number;
};

export type FollowupQueueState = {
  items: FollowupRun[];
  draining: boolean;
  lastEnqueuedAt: number;
  /** Latest eligibility boundary among ordered durable work in this queue. */
  nextAttemptAt?: number;
  mode: QueueMode;
  debounceMs: number;
  cap: number;
  dropPolicy: QueueDropPolicy;
  /** Aggregate projection consumed by the shared queue helpers. */
  droppedCount: number;
  summaryLines: string[];
  /** Monotonic order shared by durable and process-local summary entries. */
  summarySequence?: number;
  /** Process-local drops have no durable ID but keep their existing count semantics. */
  processLocalDroppedCount?: number;
  /** Bounded process-local summary lines, ordered with durable contributions. */
  processLocalSummaryEntries?: FollowupQueueSummaryEntry[];
  /** Durable ownership and exact summary content, in original ID insertion order. */
  summarizedDurableFollowups?: Map<string, SummarizedDurableFollowup>;
  lastRun?: FollowupRun["run"];
};

export const DEFAULT_QUEUE_DEBOUNCE_MS = 1000;
export const DEFAULT_QUEUE_CAP = 20;
export const DEFAULT_QUEUE_DROP: QueueDropPolicy = "summarize";

/**
 * Share followup queues across bundled chunks so busy-session enqueue/drain
 * logic observes one queue registry per process.
 */
const FOLLOWUP_QUEUES_KEY = Symbol.for("openclaw.followupQueues");

export const FOLLOWUP_QUEUES = resolveGlobalMap<string, FollowupQueueState>(FOLLOWUP_QUEUES_KEY);

export function getExistingFollowupQueue(key: string): FollowupQueueState | undefined {
  const cleaned = key.trim();
  if (!cleaned) {
    return undefined;
  }
  return FOLLOWUP_QUEUES.get(cleaned);
}

/**
 * True while a queue owns the next turn for this session.
 *
 * Startup restoration establishes this synchronously before channels open.
 * Inbound dispatch must treat that ownership like an active embedded run so a
 * newer message cannot leapfrog restored disk-backed work into direct execution.
 */
export function hasFollowupQueueOwnership(key: string): boolean {
  const queue = getExistingFollowupQueue(key);
  return Boolean(queue && (queue.draining || queue.items.length > 0 || queue.droppedCount > 0));
}

function ensureFollowupQueueSummaryTracking(queue: FollowupQueueState): void {
  queue.summarySequence ??= 0;
  queue.processLocalDroppedCount ??= queue.droppedCount;
  queue.processLocalSummaryEntries ??= queue.summaryLines.map((summaryLine, index) => ({
    sequence: index + 1,
    summaryLine,
  }));
  queue.summarizedDurableFollowups ??= new Map<string, SummarizedDurableFollowup>();
  if (queue.summarySequence < queue.processLocalSummaryEntries.length) {
    queue.summarySequence = queue.processLocalSummaryEntries.length;
  }
}

/** Rebuild the legacy count/line projection from addressable queue summary state. */
export function syncFollowupQueueSummary(queue: FollowupQueueState): void {
  ensureFollowupQueueSummaryTracking(queue);
  const durable = [...(queue.summarizedDurableFollowups?.values() ?? [])];
  const processLocal = queue.processLocalSummaryEntries ?? [];
  queue.droppedCount = (queue.processLocalDroppedCount ?? 0) + durable.length;
  queue.summaryLines = [...processLocal, ...durable]
    .toSorted((a, b) => a.sequence - b.sequence)
    .slice(-Math.max(0, queue.cap))
    .map((entry) => entry.summaryLine);
}

/** Record the exact overflow contributions before the removed items leave RAM. */
export function recordFollowupQueueSummaryDrops(
  queue: FollowupQueueState,
  dropped: FollowupRun[],
): void {
  ensureFollowupQueueSummaryTracking(queue);
  for (const item of dropped) {
    const entry: FollowupQueueSummaryEntry = {
      sequence: (queue.summarySequence ?? 0) + 1,
      summaryLine: buildQueueSummaryLine(item.summaryLine?.trim() || item.prompt.trim()),
    };
    queue.summarySequence = entry.sequence;
    if (item.durableId) {
      queue.summarizedDurableFollowups?.set(item.durableId, {
        ...entry,
        id: item.durableId,
        expiresAt: item.durableExpiresAt,
      });
      continue;
    }
    queue.processLocalDroppedCount = (queue.processLocalDroppedCount ?? 0) + 1;
    (queue.processLocalSummaryEntries ??= []).push(entry);
    if (queue.processLocalSummaryEntries.length > queue.cap) {
      queue.processLocalSummaryEntries.splice(
        0,
        queue.processLocalSummaryEntries.length - queue.cap,
      );
    }
  }
  syncFollowupQueueSummary(queue);
}

export function getFollowupQueue(key: string, settings: QueueSettings): FollowupQueueState {
  const existing = FOLLOWUP_QUEUES.get(key);
  if (existing) {
    applyQueueRuntimeSettings({
      target: existing,
      settings,
    });
    return existing;
  }

  const created: FollowupQueueState = {
    items: [],
    draining: false,
    lastEnqueuedAt: 0,
    nextAttemptAt: undefined,
    mode: settings.mode,
    debounceMs:
      typeof settings.debounceMs === "number"
        ? Math.max(0, settings.debounceMs)
        : DEFAULT_QUEUE_DEBOUNCE_MS,
    cap:
      typeof settings.cap === "number" && settings.cap > 0
        ? Math.floor(settings.cap)
        : DEFAULT_QUEUE_CAP,
    dropPolicy: settings.dropPolicy ?? DEFAULT_QUEUE_DROP,
    droppedCount: 0,
    summaryLines: [],
    summarySequence: 0,
    processLocalDroppedCount: 0,
    processLocalSummaryEntries: [],
    summarizedDurableFollowups: new Map<string, SummarizedDurableFollowup>(),
  };
  applyQueueRuntimeSettings({
    target: created,
    settings,
  });
  FOLLOWUP_QUEUES.set(key, created);
  return created;
}

export function clearFollowupQueue(key: string): number {
  const cleaned = key.trim();
  const queue = getExistingFollowupQueue(cleaned);
  // Cancellation must remove both visible items and overflow records whose
  // payloads were replaced by a process-local summary. Ack known IDs first,
  // then scan by queue key for records not restored into RAM after startup.
  if (queue) {
    ackDurableFollowupsSync([
      ...queue.items.flatMap((item) => [item.durableId, ...(item.durableIds ?? [])]),
      ...(queue.summarizedDurableFollowups?.keys() ?? []),
    ]);
  }
  ackDurableFollowupsForQueueSync(cleaned);
  if (!queue) {
    return 0;
  }
  const cleared = queue.items.length + queue.droppedCount;
  // Mutate RAM only after all disk acknowledgement succeeds, so an unlink or
  // scan failure leaves the queue available for a safe cancellation retry.
  queue.items.length = 0;
  queue.droppedCount = 0;
  queue.summaryLines = [];
  queue.processLocalDroppedCount = 0;
  queue.processLocalSummaryEntries = [];
  queue.summarizedDurableFollowups?.clear();
  queue.lastRun = undefined;
  queue.lastEnqueuedAt = 0;
  FOLLOWUP_QUEUES.delete(cleaned);
  return cleared;
}
