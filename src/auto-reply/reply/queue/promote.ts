import { queueEmbeddedPiMessageAsync } from "../../../agents/pi-embedded.js";
import { ackDurableFollowupsSync } from "./durable-store.js";
import { FOLLOWUP_QUEUES } from "./state.js";

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

function matchesExpectedTelegramRoute(
  item: {
    originatingChannel?: string;
    originatingTo?: string;
    originatingAccountId?: string;
    originatingThreadId?: string | number;
  },
  expected: ExpectedTelegramRoute,
): boolean {
  if (item.originatingChannel !== "telegram" || item.originatingTo !== expected.chatId) {
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
      continue;
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
