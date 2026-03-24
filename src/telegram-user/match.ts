import type {
  TelegramUserMessage,
  TelegramUserWaitCandidate,
  TelegramUserWaitMatchReason,
  TelegramUserWaitParams,
  TelegramUserWaitResult,
} from "./types.js";

export function resolveTelegramUserThreadAnchor(message: TelegramUserMessage): number | null {
  const directTopicId = message.direct_messages_topic?.topic_id ?? message.direct_messages_topic_id;
  if (typeof directTopicId === "number" && Number.isFinite(directTopicId)) {
    return directTopicId;
  }
  if (typeof message.reply_to_top_id === "number" && Number.isFinite(message.reply_to_top_id)) {
    return message.reply_to_top_id;
  }
  if (typeof message.reply_to_msg_id === "number" && Number.isFinite(message.reply_to_msg_id)) {
    return message.reply_to_msg_id;
  }
  return null;
}

export function matchTelegramUserMessage(
  message: TelegramUserMessage,
  params: Pick<TelegramUserWaitParams, "afterId" | "contains" | "senderId" | "threadAnchor">,
):
  | { matched: false; reason: TelegramUserWaitMatchReason }
  | {
      matched: true;
      matchedBy:
        | "direct_messages_topic.topic_id"
        | "no_thread_filter"
        | "reply_to_msg_id"
        | "reply_to_top_id";
    } {
  const afterId = params.afterId ?? 0;
  if (message.message_id <= afterId) {
    return { matched: false, reason: `too_old:${message.message_id}` };
  }

  const senderId = params.senderId ?? 0;
  if (senderId > 0) {
    const actualSenderId = message.sender_id ?? 0;
    if (actualSenderId !== senderId) {
      return { matched: false, reason: `sender_mismatch:${actualSenderId}!=${senderId}` };
    }
  }

  const text = message.text.trim();
  if (!text) {
    return { matched: false, reason: "empty_text" };
  }

  const contains = params.contains ?? "";
  if (contains && !text.includes(contains)) {
    return { matched: false, reason: "text_mismatch" };
  }

  const threadAnchor = params.threadAnchor ?? 0;
  if (threadAnchor <= 0) {
    return { matched: true, matchedBy: "no_thread_filter" };
  }

  const directTopicId = message.direct_messages_topic?.topic_id ?? message.direct_messages_topic_id;
  if (directTopicId === threadAnchor) {
    return { matched: true, matchedBy: "direct_messages_topic.topic_id" };
  }
  if (message.reply_to_top_id === threadAnchor) {
    return { matched: true, matchedBy: "reply_to_top_id" };
  }
  if (message.reply_to_msg_id === threadAnchor) {
    return { matched: true, matchedBy: "reply_to_msg_id" };
  }

  return {
    matched: false,
    reason: `thread_mismatch:${String(resolveTelegramUserThreadAnchor(message))}`,
  };
}

export function appendIgnoredTelegramUserCandidate(
  candidates: TelegramUserWaitCandidate[],
  message: TelegramUserMessage,
  reason: TelegramUserWaitMatchReason,
  maxItems = 10,
): TelegramUserWaitCandidate[] {
  return [...candidates, { ...message, ignored_reason: reason }].slice(-Math.max(1, maxItems));
}

export function buildTelegramUserWaitTimeoutError(
  params: TelegramUserWaitParams,
  attempts: number,
  elapsedMs: number,
  ignoredRecent: TelegramUserWaitCandidate[],
): Error {
  const parts = [
    `Telegram user wait timed out after ${elapsedMs}ms`,
    `(chat=${params.chat}, afterId=${params.afterId ?? 0}, senderId=${params.senderId ?? 0}, threadAnchor=${params.threadAnchor ?? 0}).`,
  ];
  if (ignoredRecent.length > 0) {
    const sample = ignoredRecent
      .map((entry) => {
        return `msg=${entry.message_id} sender=${entry.sender_id ?? "?"} reason=${entry.ignored_reason}`;
      })
      .join("; ");
    parts.push(`Ignored recent candidates after ${attempts} poll(s): ${sample}`);
  }
  return new Error(parts.join(" "));
}

export function buildTelegramUserWaitResult(params: {
  attempts: number;
  elapsedMs: number;
  ignoredRecent: TelegramUserWaitCandidate[];
  matched: TelegramUserMessage;
  matchedBy:
    | "direct_messages_topic.topic_id"
    | "no_thread_filter"
    | "reply_to_msg_id"
    | "reply_to_top_id";
}): TelegramUserWaitResult {
  return {
    attempts: params.attempts,
    elapsed_ms: params.elapsedMs,
    ignored_recent: params.ignoredRecent,
    matched: params.matched,
    matched_by: params.matchedBy,
  };
}
