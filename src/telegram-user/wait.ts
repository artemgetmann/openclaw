import {
  getTelegramUserDefaultPollIntervalMs,
  getTelegramUserDefaultWaitTimeoutMs,
  runTelegramUserRead,
  sleep,
} from "./backend.js";
import {
  appendIgnoredTelegramUserCandidate,
  buildTelegramUserWaitResult,
  buildTelegramUserWaitTimeoutError,
  matchTelegramUserMessage,
} from "./match.js";
import type { TelegramUserBackendOptions, TelegramUserWaitResult } from "./types.js";

export async function runTelegramUserWait(
  params: {
    chat: string;
    afterId?: number | null;
    contains?: string | null;
    limit?: number | null;
    pollIntervalMs?: number | null;
    senderId?: number | null;
    threadAnchor?: number | null;
    timeoutMs?: number | null;
  } & TelegramUserBackendOptions,
): Promise<TelegramUserWaitResult> {
  const startedAt = Date.now();
  const timeoutMs = params.timeoutMs ?? getTelegramUserDefaultWaitTimeoutMs();
  const pollIntervalMs = params.pollIntervalMs ?? getTelegramUserDefaultPollIntervalMs();
  const limit = params.limit ?? 80;
  const afterId = params.afterId ?? 0;
  const contains = params.contains ?? "";
  const senderId = params.senderId ?? 0;
  const threadAnchor = params.threadAnchor ?? 0;

  let attempts = 0;
  let ignoredRecent: ReturnType<typeof appendIgnoredTelegramUserCandidate> = [];
  const seenMessageIds = new Set<number>();

  // The high-level smoke command and the low-level CLI both need identical
  // polling semantics so reply matching cannot drift between operator surfaces.
  while (Date.now() - startedAt < timeoutMs) {
    attempts += 1;
    const readResult = await runTelegramUserRead({
      ...params,
      chat: params.chat,
      limit,
      afterId,
    });

    for (const message of readResult.messages) {
      if (seenMessageIds.has(message.message_id)) {
        continue;
      }
      seenMessageIds.add(message.message_id);

      const match = matchTelegramUserMessage(message, {
        afterId,
        contains,
        senderId,
        threadAnchor,
      });
      if (match.matched) {
        return buildTelegramUserWaitResult({
          attempts,
          elapsedMs: Date.now() - startedAt,
          ignoredRecent,
          backendMeta: readResult.backend_meta,
          matched: message,
          matchedBy: match.matchedBy,
        });
      }

      ignoredRecent = appendIgnoredTelegramUserCandidate(ignoredRecent, message, match.reason);
    }

    await sleep(pollIntervalMs);
  }

  throw buildTelegramUserWaitTimeoutError(
    {
      ...params,
      chat: params.chat,
      afterId,
      contains,
      limit,
      pollIntervalMs,
      senderId,
      threadAnchor,
      timeoutMs,
    },
    attempts,
    Date.now() - startedAt,
    ignoredRecent,
  );
}
