// Telegram Bot API 10.1 rich-message helpers. grammY may lag the raw method
// type, so this module keeps the untyped call narrow and fallback-friendly.
import type { Bot } from "grammy";
import type {
  ForceReply,
  InlineKeyboardMarkup,
  Message,
  ReplyKeyboardMarkup,
  ReplyKeyboardRemove,
  ReplyParameters,
} from "grammy/types";
import type { MarkdownTableMode } from "../../../src/config/types.base.js";
import {
  markdownToTelegramRichHtml,
  sanitizeTelegramRichHtml,
  type TelegramRichTextChunk,
} from "./format.js";

type TelegramRichMessageReplyMarkup =
  | InlineKeyboardMarkup
  | ReplyKeyboardMarkup
  | ReplyKeyboardRemove
  | ForceReply;

export const TELEGRAM_RICH_TEXT_LIMIT = 32_768;

export type TelegramInputRichMessage =
  | {
      html: string;
      markdown?: never;
      skip_entity_detection?: boolean;
    }
  | {
      markdown: string;
      html?: never;
      skip_entity_detection?: boolean;
    };

type TelegramRichResponseLike = {
  text?: unknown;
  caption?: unknown;
  rich_message?: unknown;
};

export type TelegramSendRichMessageParams = {
  chat_id: number | string;
  message_thread_id?: number;
  rich_message: TelegramInputRichMessage;
  disable_notification?: boolean;
  reply_parameters?: ReplyParameters;
  reply_markup?: TelegramRichMessageReplyMarkup;
};

export type TelegramRichMessageContextParams = Pick<
  TelegramSendRichMessageParams,
  "disable_notification" | "message_thread_id" | "reply_parameters"
>;

type TelegramRichRawApi = {
  sendRichMessage: (params: TelegramSendRichMessageParams) => Promise<Message>;
};

export type TelegramSendRichMessageDraftParams = {
  chat_id: number;
  message_thread_id?: number;
  draft_id: number;
  rich_message: TelegramInputRichMessage;
};

export type TelegramEditRichMessageTextParams = {
  chat_id?: number | string;
  message_id?: number;
  inline_message_id?: string;
  rich_message: TelegramInputRichMessage;
  link_preview_options?: { is_disabled?: boolean };
  reply_markup?: TelegramRichMessageReplyMarkup;
};

type TelegramRichDraftRawApi = {
  sendRichMessageDraft: (params: TelegramSendRichMessageDraftParams) => Promise<boolean>;
};

type TelegramRichEditRawApi = {
  editMessageText: (params: TelegramEditRichMessageTextParams) => Promise<Message | true>;
};

type TelegramApiWithRichRaw = Bot["api"] & {
  raw?: Partial<TelegramRichRawApi & TelegramRichDraftRawApi & TelegramRichEditRawApi>;
};

export function getTelegramRichRawApi(api: Bot["api"]): TelegramRichRawApi | null {
  const sendRichMessage = (api as TelegramApiWithRichRaw).raw?.sendRichMessage;
  if (typeof sendRichMessage !== "function") {
    return null;
  }
  return { sendRichMessage };
}

export function getTelegramRichDraftRawApi(api: Bot["api"]): TelegramRichDraftRawApi | null {
  const sendRichMessageDraft = (api as TelegramApiWithRichRaw).raw?.sendRichMessageDraft;
  if (typeof sendRichMessageDraft !== "function") {
    return null;
  }
  return { sendRichMessageDraft };
}

export function getTelegramRichEditRawApi(api: Bot["api"]): TelegramRichEditRawApi | null {
  const editMessageText = (api as TelegramApiWithRichRaw).raw?.editMessageText;
  if (typeof editMessageText !== "function") {
    return null;
  }
  return { editMessageText };
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasNonBlankString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function richTreeHasVisibleContent(value: unknown, depth = 0): boolean {
  if (depth > 16) {
    return false;
  }
  if (hasNonBlankString(value)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((item) => richTreeHasVisibleContent(item, depth + 1));
  }
  if (!isRecord(value)) {
    return false;
  }

  // Telegram's RichMessage response is a tree: rich_message.blocks[] contains
  // block objects, those blocks contain text/caption/items/cells, and RichText
  // objects recursively contain text. Walk only known visible fields so an id,
  // type tag, or empty structural array cannot masquerade as readable content.
  const visibleKeys = [
    "blocks",
    "text",
    "caption",
    "credit",
    "summary",
    "items",
    "cells",
    "title",
    "label",
  ];
  for (const key of visibleKeys) {
    if (hasOwn(value, key) && richTreeHasVisibleContent(value[key], depth + 1)) {
      return true;
    }
  }

  // Rich media blocks are visible even when their optional captions are empty.
  // The current text-send path should not generate these, but this keeps the
  // validator aligned with Bot API RichMessage semantics instead of hard-coding
  // text-only assumptions.
  return ["photo", "video", "animation", "audio", "voice_note", "map"].some((key) =>
    hasOwn(value, key),
  );
}

export function assertTelegramRichMessageInputHasContent(
  richMessage: TelegramInputRichMessage,
): void {
  const rawText = "html" in richMessage ? richMessage.html : richMessage.markdown;
  if (!hasNonBlankString(rawText)) {
    throw new Error("Telegram rich_message payload is empty");
  }
}

export function assertTelegramRichSendResponseHasVisibleContent(response: unknown): void {
  if (!isRecord(response)) {
    return;
  }

  const message = response as TelegramRichResponseLike;
  if (message.rich_message !== undefined) {
    if (
      richTreeHasVisibleContent(message.rich_message) ||
      hasNonBlankString(message.text) ||
      hasNonBlankString(message.caption)
    ) {
      return;
    }
    throw new Error("Telegram sendRichMessage returned empty rich_message content");
  }

  // Bot API 10.1 added Message.rich_message, but local wrappers can lag the
  // schema and omit that field. Absence is unknown, not blank. Explicit empty
  // legacy text/caption is different: it is Telegram telling us the visible
  // response body it exposed is blank, so the caller must fall back to HTML.
  if (
    hasOwn(response, "text") &&
    typeof message.text === "string" &&
    !hasNonBlankString(message.text)
  ) {
    throw new Error("Telegram sendRichMessage returned empty text");
  }
  if (
    hasOwn(response, "caption") &&
    typeof message.caption === "string" &&
    !hasNonBlankString(message.caption)
  ) {
    throw new Error("Telegram sendRichMessage returned empty caption");
  }
}

function isReplyParameters(value: unknown): value is ReplyParameters {
  if (!value || typeof value !== "object") {
    return false;
  }
  return finiteInteger((value as { message_id?: unknown }).message_id) !== undefined;
}

export function toTelegramRichMessageContextParams(
  params: Record<string, unknown> | undefined,
): TelegramRichMessageContextParams {
  const richParams: TelegramRichMessageContextParams = {};
  const messageThreadId = finiteInteger(params?.message_thread_id);
  if (messageThreadId !== undefined) {
    richParams.message_thread_id = messageThreadId;
  }
  if (params?.disable_notification === true) {
    richParams.disable_notification = true;
  }
  if (isReplyParameters(params?.reply_parameters)) {
    richParams.reply_parameters = params.reply_parameters;
    return richParams;
  }
  const replyToMessageId = finiteInteger(params?.reply_to_message_id);
  if (replyToMessageId !== undefined) {
    richParams.reply_parameters = {
      message_id: replyToMessageId,
      allow_sending_without_reply: true,
    };
  }
  return richParams;
}

export function removeTelegramRichNativeQuoteParam(
  params: Record<string, unknown>,
): TelegramRichMessageContextParams {
  const richParams = toTelegramRichMessageContextParams(params);
  if (!richParams.reply_parameters) {
    return richParams;
  }
  const {
    quote: _quote,
    quote_entities: _quoteEntities,
    quote_parse_mode: _quoteParseMode,
    quote_position: _quotePosition,
    ...replyParameters
  } = richParams.reply_parameters;
  return {
    ...richParams,
    reply_parameters: replyParameters,
  };
}

export function buildTelegramRichMessage(
  chunk: Pick<TelegramRichTextChunk, "text" | "textMode">,
  options: {
    tableMode?: MarkdownTableMode;
    skipEntityDetection?: boolean;
    copySafeBlockquotes?: boolean;
  } = {},
): TelegramInputRichMessage {
  const html =
    chunk.textMode === "html"
      ? sanitizeTelegramRichHtml(chunk.text)
      : markdownToTelegramRichHtml(chunk.text, {
          tableMode: options.tableMode,
          copySafeBlockquotes: options.copySafeBlockquotes,
        });
  return options.skipEntityDetection === true ? { html, skip_entity_detection: true } : { html };
}
