import { type Message, type UserFromGetMe } from "@grammyjs/types";
import { isAbortRequestText } from "../../../src/auto-reply/reply/abort.js";
import { isBtwRequestText } from "../../../src/auto-reply/reply/btw-command.js";
import { resolveGlobalMap } from "../../../src/shared/global-singleton.js";
import { resolveTelegramForumThreadId, resolveTelegramInboundThreadId } from "./bot/helpers.js";

export type TelegramSequentialKeyContext = {
  chat?: { id?: number };
  me?: UserFromGetMe;
  message?: Message;
  channelPost?: Message;
  editedChannelPost?: Message;
  update?: {
    message?: Message;
    edited_message?: Message;
    channel_post?: Message;
    edited_channel_post?: Message;
    callback_query?: { message?: Message };
    message_reaction?: { chat?: { id?: number } };
  };
};

const TELEGRAM_BUSY_SEQUENTIAL_KEYS = resolveGlobalMap<string, number>(
  Symbol.for("openclaw.telegramBusySequentialKeys"),
);

/**
 * Mark one Telegram conversation as actively running model work.
 *
 * The reference count survives overlapping lifecycle callbacks and module
 * reloads. The returned release function is idempotent so both typing cleanup
 * and dispatch-finally paths can close the same lease safely.
 */
export function markTelegramSequentialKeyBusy(key: string): () => void {
  TELEGRAM_BUSY_SEQUENTIAL_KEYS.set(key, (TELEGRAM_BUSY_SEQUENTIAL_KEYS.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const remaining = (TELEGRAM_BUSY_SEQUENTIAL_KEYS.get(key) ?? 1) - 1;
    if (remaining > 0) {
      TELEGRAM_BUSY_SEQUENTIAL_KEYS.set(key, remaining);
    } else {
      TELEGRAM_BUSY_SEQUENTIAL_KEYS.delete(key);
    }
  };
}

export function getTelegramSequentialKey(ctx: TelegramSequentialKeyContext): string {
  const reaction = ctx.update?.message_reaction;
  if (reaction?.chat?.id) {
    return `telegram:${reaction.chat.id}`;
  }
  const msg =
    ctx.message ??
    ctx.channelPost ??
    ctx.editedChannelPost ??
    ctx.update?.message ??
    ctx.update?.edited_message ??
    ctx.update?.channel_post ??
    ctx.update?.edited_channel_post ??
    ctx.update?.callback_query?.message;
  const chatId = msg?.chat?.id ?? ctx.chat?.id;
  const rawText = msg?.text ?? msg?.caption;
  const botUsername = ctx.me?.username;
  if (isAbortRequestText(rawText, botUsername ? { botUsername } : undefined)) {
    if (typeof chatId === "number") {
      return `telegram:${chatId}:control`;
    }
    return "telegram:control";
  }
  if (isBtwRequestText(rawText, botUsername ? { botUsername } : undefined)) {
    const messageId = msg?.message_id;
    if (typeof chatId === "number" && typeof messageId === "number") {
      return `telegram:${chatId}:btw:${messageId}`;
    }
    if (typeof chatId === "number") {
      return `telegram:${chatId}:btw`;
    }
    return "telegram:btw";
  }
  const isGroup = msg?.chat?.type === "group" || msg?.chat?.type === "supergroup";
  const messageThreadId = resolveTelegramInboundThreadId(msg);
  const isForum = msg?.chat?.is_forum;
  const threadId = isGroup
    ? resolveTelegramForumThreadId({ isForum, messageThreadId })
    : messageThreadId;
  if (typeof chatId === "number") {
    return threadId != null ? `telegram:${chatId}:topic:${threadId}` : `telegram:${chatId}`;
  }
  return "telegram:unknown";
}

/**
 * Let plain follow-up messages and Queue/Steer callbacks reach the durable
 * agent queue while the original Telegram handler is still awaiting its model.
 *
 * All other updates keep the historical per-chat/topic serialization. The
 * unique suffix is used only after an actual agent run has started, avoiding a
 * race where two fresh messages could both start the same idle session.
 */
export function getTelegramBusyAwareSequentialKey(ctx: TelegramSequentialKeyContext): string {
  const baseKey = getTelegramSequentialKey(ctx);
  if (!TELEGRAM_BUSY_SEQUENTIAL_KEYS.has(baseKey)) {
    return baseKey;
  }

  const callback = ctx.update?.callback_query;
  const callbackData = (callback as { data?: unknown } | undefined)?.data;
  if (typeof callbackData === "string" && /^oq[ksd]:/.test(callbackData)) {
    const callbackId = (callback as { id?: unknown } | undefined)?.id;
    return `${baseKey}:queue-control:${String(callbackId ?? "unknown")}`;
  }

  const msg = ctx.message ?? ctx.update?.message;
  const text = msg?.text;
  if (
    typeof msg?.message_id === "number" &&
    typeof text === "string" &&
    text.trim() &&
    !text.trimStart().startsWith("/")
  ) {
    return `${baseKey}:queued-message:${msg.message_id}`;
  }
  return baseKey;
}
