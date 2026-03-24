import { describe, expect, it } from "vitest";
import {
  appendIgnoredTelegramUserCandidate,
  matchTelegramUserMessage,
  resolveTelegramUserThreadAnchor,
} from "./match.js";
import type { TelegramUserMessage } from "./types.js";

function createMessage(overrides: Partial<TelegramUserMessage> = {}): TelegramUserMessage {
  return {
    chat_id: 1,
    chat_title: null,
    chat_username: null,
    date: "2026-03-24T00:00:00.000Z",
    direct_messages_topic: null,
    direct_messages_topic_id: null,
    message_id: 101,
    out: false,
    reply_to_msg_id: null,
    reply_to_top_id: null,
    sender_id: 42,
    text: "hello",
    thread_anchor: null,
    ...overrides,
  };
}

describe("resolveTelegramUserThreadAnchor", () => {
  it("prefers the DM topic id when Telegram exposes a private-thread topic", () => {
    const message = createMessage({
      direct_messages_topic: { topic_id: 999 },
      direct_messages_topic_id: 999,
      reply_to_msg_id: 123,
      reply_to_top_id: 456,
    });
    expect(resolveTelegramUserThreadAnchor(message)).toBe(999);
  });
});

describe("matchTelegramUserMessage", () => {
  it("matches DM topic replies before reply ids", () => {
    const message = createMessage({
      direct_messages_topic: { topic_id: 777 },
      direct_messages_topic_id: 777,
      reply_to_msg_id: 111,
      reply_to_top_id: 222,
    });
    const result = matchTelegramUserMessage(message, {
      afterId: 100,
      contains: "hello",
      senderId: 42,
      threadAnchor: 777,
    });
    expect(result).toEqual({ matched: true, matchedBy: "direct_messages_topic.topic_id" });
  });

  it("returns a thread mismatch reason when reply metadata does not line up", () => {
    const message = createMessage({
      direct_messages_topic_id: 12,
      reply_to_msg_id: 34,
      reply_to_top_id: 56,
    });
    const result = matchTelegramUserMessage(message, {
      afterId: 100,
      contains: "hello",
      senderId: 42,
      threadAnchor: 99,
    });
    expect(result).toEqual({ matched: false, reason: "thread_mismatch:12" });
  });

  it("keeps only the last ignored candidates", () => {
    const ignored = Array.from({ length: 12 }, (_, index) =>
      createMessage({ message_id: index + 1, text: `msg-${index + 1}` }),
    ).reduce(
      (acc, message) => {
        return appendIgnoredTelegramUserCandidate(acc, message, "text_mismatch", 3);
      },
      [] as ReturnType<typeof appendIgnoredTelegramUserCandidate>,
    );

    expect(ignored.map((entry) => entry.message_id)).toEqual([10, 11, 12]);
  });
});
