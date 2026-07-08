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
