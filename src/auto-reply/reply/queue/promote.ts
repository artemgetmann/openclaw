import { queueEmbeddedPiMessageAsync } from "../../../agents/pi-embedded.js";
import { loadConfig } from "../../../config/config.js";
import {
  ackDurableFollowupsSync,
  hydrateDurableFollowup,
  loadDurableFollowups,
} from "./durable-store.js";
import { FOLLOWUP_QUEUES, syncFollowupQueueSummary } from "./state.js";

export type PromoteQueuedFollowupResult =
  | { status: "promoted" }
  | { status: "still-queued"; reason: "not-streaming" | "in-flight" }
  | { status: "missing" }
  | { status: "route-mismatch" };

type ExpectedTelegramRoute = {
  chatId: string;
  accountId?: string;
  threadId?: number;
};

export type QueuedFollowupState = "queued" | "in-flight" | "missing" | "route-mismatch";

function matchesExpectedTelegramRoute(
  item: {
    originatingChannel?: string;
    originatingTo?: string;
    originatingAccountId?: string;
    originatingThreadId?: string | number;
  },
  expected: ExpectedTelegramRoute,
): boolean {
  const expectedTargets = new Set([expected.chatId, `telegram:${expected.chatId}`]);
  if (
    item.originatingChannel !== "telegram" ||
    !item.originatingTo ||
    !expectedTargets.has(item.originatingTo)
  ) {
    return false;
  }
  if (
    expected.accountId &&
    item.originatingAccountId &&
    item.originatingAccountId !== expected.accountId
  ) {
    return false;
  }
  const itemThread =
    item.originatingThreadId == null || item.originatingThreadId === ""
      ? undefined
      : Number(item.originatingThreadId);
  return itemThread === expected.threadId;
}

/** Read the durable/RAM ownership state without moving or acknowledging work. */
export async function getQueuedFollowupState(params: {
  durableId: string;
  expectedTelegramRoute: ExpectedTelegramRoute;
}): Promise<QueuedFollowupState> {
  const durableId = params.durableId.trim();
  for (const queue of FOLLOWUP_QUEUES.values()) {
    const item = queue.items.find((candidate) => candidate.durableId === durableId);
    const summarized = queue.summarizedDurableFollowups?.has(durableId);
    if (!item && !summarized && !queue.inFlightDurableIds.has(durableId)) {
      continue;
    }
    if (queue.inFlightDurableIds.has(durableId)) {
      return "in-flight";
    }
    if (item) {
      return matchesExpectedTelegramRoute(item, params.expectedTelegramRoute)
        ? "queued"
        : "route-mismatch";
    }
  }

  // Startup can receive a callback before RAM restoration finishes. The disk
  // record remains the authoritative proof that this exact input is deferred.
  const record = (await loadDurableFollowups()).find(
    (candidate) => candidate.id === durableId && !candidate.delivery,
  );
  if (!record) {
    return "missing";
  }
  const item = hydrateDurableFollowup(record, loadConfig());
  return matchesExpectedTelegramRoute(item, params.expectedTelegramRoute)
    ? "queued"
    : "route-mismatch";
}

/**
 * Promote one exact durable follow-up into Pi's active steering queue.
 *
 * The durable unlink and RAM removal run inside Pi's synchronous pre-queue
 * boundary. If Pi is no longer streamable (or is compacting), nothing moves
 * and the message remains safely queued for its ordinary follow-up turn.
 */
export async function promoteQueuedFollowupToSteer(params: {
  durableId: string;
  expectedTelegramRoute: ExpectedTelegramRoute;
}): Promise<PromoteQueuedFollowupResult> {
  const durableId = params.durableId.trim();
  if (!durableId) {
    return { status: "missing" };
  }

  for (const [queueKey, queue] of FOLLOWUP_QUEUES) {
    const itemIndex = queue.items.findIndex((item) => item.durableId === durableId);
    if (itemIndex < 0) {
      // `drop:summarize` removes overflowed items from the live FIFO while
      // retaining their exact durable IDs and disk records. Their already-sent
      // Telegram controls must remain truthful: recover the addressed input
      // instead of treating the visible Steer action as stale.
      const summarizedEntry = queue.summarizedDurableFollowups?.get(durableId);
      if (!summarizedEntry) {
        continue;
      }
      if (queue.inFlightDurableIds.has(durableId)) {
        return { status: "still-queued", reason: "in-flight" };
      }

      const record = (await loadDurableFollowups()).find(
        (candidate) => candidate.id === durableId && candidate.queueKey === queueKey,
      );
      // The drain may have claimed or completed this summary while disk I/O was
      // pending. Re-check ownership before moving any state.
      if (
        !record ||
        !queue.summarizedDurableFollowups?.has(durableId) ||
        queue.inFlightDurableIds.has(durableId)
      ) {
        return queue.inFlightDurableIds.has(durableId)
          ? { status: "still-queued", reason: "in-flight" }
          : { status: "missing" };
      }

      const summarizedItem = hydrateDurableFollowup(record, loadConfig());
      if (!matchesExpectedTelegramRoute(summarizedItem, params.expectedTelegramRoute)) {
        return { status: "route-mismatch" };
      }

      // Removing the exact summary contribution is the synchronous promotion
      // claim. A concurrent drain can no longer fold it into a summary turn.
      queue.summarizedDurableFollowups.delete(durableId);
      syncFollowupQueueSummary(queue);
      try {
        const accepted = await queueEmbeddedPiMessageAsync(
          summarizedItem.run.sessionId,
          summarizedItem.prompt,
        );
        if (!accepted) {
          queue.summarizedDurableFollowups.set(durableId, summarizedEntry);
          syncFollowupQueueSummary(queue);
          return { status: "still-queued", reason: "not-streaming" };
        }

        ackDurableFollowupsSync([durableId]);
        if (!queue.draining && queue.items.length === 0 && queue.droppedCount === 0) {
          FOLLOWUP_QUEUES.delete(queueKey);
        }
        return { status: "promoted" };
      } catch (err) {
        // Pi did not accept the instruction. Restore the same ordered summary
        // provenance so the normal follow-up turn still represents it.
        queue.summarizedDurableFollowups.set(durableId, summarizedEntry);
        syncFollowupQueueSummary(queue);
        throw err;
      }
    }
    if (queue.inFlightDurableIds.has(durableId)) {
      return { status: "still-queued", reason: "in-flight" };
    }

    const item = queue.items[itemIndex];
    if (!item || !matchesExpectedTelegramRoute(item, params.expectedTelegramRoute)) {
      return { status: "route-mismatch" };
    }

    // Remove the RAM item as the promotion claim while retaining its durable
    // disk record. A concurrent drain cannot see the item during the awaited
    // Pi steer, while a crash still restores it from disk.
    queue.items.splice(itemIndex, 1);
    try {
      const accepted = await queueEmbeddedPiMessageAsync(item.run.sessionId, item.prompt);
      if (!accepted) {
        queue.items.splice(Math.min(itemIndex, queue.items.length), 0, item);
        return { status: "still-queued", reason: "not-streaming" };
      }

      // Pi accepted the instruction. Only now remove restart ownership.
      // If unlinking fails, the disk record remains for conservative replay;
      // accepted user work is never silently discarded.
      ackDurableFollowupsSync([durableId]);
      if (!queue.draining && queue.items.length === 0 && queue.droppedCount === 0) {
        FOLLOWUP_QUEUES.delete(queueKey);
      }
      return { status: "promoted" };
    } catch (err) {
      // A rejected Pi steer has not accepted the instruction. Restore its
      // original FIFO position so the ordinary follow-up drain remains valid.
      if (!queue.items.some((candidate) => candidate.durableId === durableId)) {
        queue.items.splice(Math.min(itemIndex, queue.items.length), 0, item);
      }
      throw err;
    }
  }

  return { status: "missing" };
}
