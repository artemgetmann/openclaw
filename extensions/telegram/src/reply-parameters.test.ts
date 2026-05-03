import { describe, expect, it } from "vitest";
import {
  buildTelegramSendParams,
  removeTelegramNativeQuoteParam,
  resolveTelegramSendThreadSpec,
} from "./reply-parameters.js";

describe("Telegram reply parameters", () => {
  it("builds native quote reply parameters when quote text belongs to the reply target", () => {
    const params = buildTelegramSendParams({
      replyToMessageId: 42,
      replyQuoteMessageId: 42,
      replyQuoteText: "quoted text",
      replyQuotePosition: 7,
      replyQuoteEntities: [{ type: "bold", offset: 0, length: 6 }],
      thread: { id: 99, scope: "forum" },
    });

    expect(params).toEqual({
      message_thread_id: 99,
      reply_parameters: {
        message_id: 42,
        quote: "quoted text",
        quote_position: 7,
        quote_entities: [{ type: "bold", offset: 0, length: 6 }],
        allow_sending_without_reply: true,
      },
    });
  });

  it("falls back to legacy reply when quote metadata does not match the reply target", () => {
    const params = buildTelegramSendParams({
      replyToMessageId: 42,
      replyQuoteMessageId: 43,
      replyQuoteText: "quoted text",
    });

    expect(params).toEqual({
      reply_to_message_id: 42,
      allow_sending_without_reply: true,
    });
  });

  it("preserves direct chat topic thread ids", () => {
    expect(
      resolveTelegramSendThreadSpec({
        targetMessageThreadId: 777,
        chatType: "direct",
      }),
    ).toEqual({ id: 777, scope: "dm" });
  });

  it("removes native quote params for legacy retry", () => {
    expect(
      removeTelegramNativeQuoteParam({
        message_thread_id: 99,
        reply_parameters: {
          message_id: 42,
          quote: "quoted text",
          allow_sending_without_reply: true,
        },
      }),
    ).toEqual({
      message_thread_id: 99,
      reply_to_message_id: 42,
      allow_sending_without_reply: true,
    });
  });
});
