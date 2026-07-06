import type { MonitorEventEnvelope } from "../monitor/types.js";
import type { TelegramUserMessage } from "./types.js";

export type TelegramUserMonitorEventOptions = {
  accountId?: string;
  chat: string;
  eventType?: string;
  nowMs?: number;
};

export type TelegramUserMonitorCandidateOptions = {
  afterId: number;
  contains?: string;
  threadAnchor?: number;
};

function readNumberishString(raw: unknown): string | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return String(raw);
  }
  if (typeof raw !== "string") {
    return undefined;
  }
  const value = raw.trim();
  return value ? value : undefined;
}

export function resolveTelegramUserMonitorThreadAnchor(
  message: TelegramUserMessage,
): string | undefined {
  return (
    readNumberishString(message.direct_messages_topic?.topic_id) ??
    readNumberishString(message.direct_messages_topic_id) ??
    readNumberishString(message.reply_to_top_id) ??
    readNumberishString(message.reply_to_msg_id) ??
    readNumberishString(message.thread_anchor)
  );
}

function matchesMonitorListenCandidate(
  message: TelegramUserMessage,
  options: TelegramUserMonitorCandidateOptions,
): boolean {
  if (message.out) {
    return false;
  }
  if (message.message_id <= options.afterId) {
    return false;
  }
  const contains = options.contains?.trim();
  if (contains && !message.text.includes(contains)) {
    return false;
  }
  if (options.threadAnchor && options.threadAnchor > 0) {
    return resolveTelegramUserMonitorThreadAnchor(message) === String(options.threadAnchor);
  }
  return true;
}

export function pickTelegramUserMonitorMessage(
  messages: TelegramUserMessage[],
  options: TelegramUserMonitorCandidateOptions,
): TelegramUserMessage | undefined {
  return messages
    .filter((message) => matchesMonitorListenCandidate(message, options))
    .toSorted((left, right) => left.message_id - right.message_id)
    .at(0);
}

export function buildTelegramUserMonitorEventEnvelope(
  message: TelegramUserMessage,
  options: TelegramUserMonitorEventOptions,
): MonitorEventEnvelope {
  const threadAnchor = resolveTelegramUserMonitorThreadAnchor(message);
  const sourceTarget: Record<string, unknown> = {
    chat: options.chat,
    ...(options.accountId ? { accountId: options.accountId } : {}),
    ...(threadAnchor ? { threadAnchor } : {}),
  };
  const evidence: Record<string, unknown> = {
    messageId: String(message.message_id),
    out: message.out,
  };

  // Source-target keys are stable routing facts. Everything from the inbound
  // message body stays evidence so a routed monitor still has to inspect source
  // state before acting.
  const evidenceEntries: Array<[string, unknown]> = [
    ["chatId", message.chat_id],
    ["chatUsername", message.chat_username],
    ["chatTitle", message.chat_title],
    ["senderId", message.sender_id],
    ["replyToMessageId", message.reply_to_msg_id],
    ["replyToTopId", message.reply_to_top_id],
    ["threadAnchor", threadAnchor],
    ["mediaKind", message.media_kind],
    ["date", message.date],
    ["text", message.text],
  ];
  for (const [key, value] of evidenceEntries) {
    const normalized = readNumberishString(value);
    if (normalized) {
      evidence[key] = normalized;
    }
  }

  return {
    triggerKind: "local_listener",
    sourceType: "telegram-user",
    sourceTarget,
    eventType: options.eventType ?? "message.created",
    idempotencyKey: `telegram-user:${options.accountId ?? "default"}:${options.chat}:${
      threadAnchor ?? "root"
    }:${message.message_id}`,
    receivedAtMs: options.nowMs ?? Date.now(),
    evidence,
  };
}
