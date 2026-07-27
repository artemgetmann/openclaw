import { queueEmbeddedPiMessage } from "../../../agents/pi-embedded.js";
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
export function promoteQueuedFollowupToSteer(params: {
  durableId: string;
  expectedTelegramRoute: ExpectedTelegramRoute;
}): PromoteQueuedFollowupResult {
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

    const accepted = queueEmbeddedPiMessage(item.run.sessionId, item.prompt, {
      beforeQueue: () => {
        // Disk first: if the unlink fails, Pi never receives a second copy.
        // RAM then follows in the same synchronous turn so the drain cannot
        // observe this item after steering accepts it.
        ackDurableFollowupsSync([durableId]);
        const currentIndex = queue.items.findIndex(
          (candidate) => candidate.durableId === durableId,
        );
        if (currentIndex < 0 || queue.inFlightDurableIds.has(durableId)) {
          throw new Error(`Queued follow-up ${durableId} changed before steering`);
        }
        queue.items.splice(currentIndex, 1);
        if (!queue.draining && queue.items.length === 0 && queue.droppedCount === 0) {
          FOLLOWUP_QUEUES.delete(queueKey);
        }
      },
    });
    return accepted ? { status: "promoted" } : { status: "still-queued", reason: "not-streaming" };
  }

  return { status: "missing" };
}
