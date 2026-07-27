import type { Chat, Message } from "@grammyjs/types";
import { describe, expect, it } from "vitest";
import {
  getTelegramBusyAwareSequentialKey,
  getTelegramSequentialKey,
  markTelegramSequentialKeyBusy,
} from "./sequential-key.js";

const mockChat = (chat: Pick<Chat, "id"> & Partial<Pick<Chat, "type" | "is_forum">>): Chat =>
  chat as Chat;
const mockMessage = (message: Pick<Message, "chat"> & Partial<Message>): Message =>
  ({
    message_id: 1,
    date: 0,
    ...message,
  }) as Message;

describe("getTelegramSequentialKey", () => {
  it.each([
    [{ message: mockMessage({ chat: mockChat({ id: 123 }) }) }, "telegram:123"],
    [
      {
        message: mockMessage({
          chat: mockChat({ id: 123, type: "private" }),
          message_thread_id: 9,
        }),
      },
      "telegram:123:topic:9",
    ],
    [
      {
        message: mockMessage({
          chat: mockChat({ id: 123, type: "private" }),
          direct_messages_topic: {
            topic_id: 11,
            user: { id: 11, is_bot: false, first_name: "Topic" },
          },
        }),
      },
      "telegram:123:topic:11",
    ],
    [
      {
        message: mockMessage({
          chat: mockChat({ id: 123, type: "supergroup" }),
          message_thread_id: 9,
        }),
      },
      "telegram:123",
    ],
    [
      {
        message: mockMessage({
          chat: mockChat({ id: 123, type: "supergroup", is_forum: true }),
        }),
      },
      "telegram:123:topic:1",
    ],
    [{ update: { message: mockMessage({ chat: mockChat({ id: 555 }) }) } }, "telegram:555"],
    [
      {
        channelPost: mockMessage({ chat: mockChat({ id: -100777111222, type: "channel" }) }),
      },
      "telegram:-100777111222",
    ],
    [
      {
        update: {
          channel_post: mockMessage({ chat: mockChat({ id: -100777111223, type: "channel" }) }),
        },
      },
      "telegram:-100777111223",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "/stop" }) },
      "telegram:123:control",
    ],
    [{ message: mockMessage({ chat: mockChat({ id: 123 }), text: "/status" }) }, "telegram:123"],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "/btw what is the time?" }) },
      "telegram:123:btw:1",
    ],
    [
      {
        me: { username: "openclaw_bot" } as never,
        message: mockMessage({
          chat: mockChat({ id: 123 }),
          text: "/btw@openclaw_bot what is the time?",
        }),
      },
      "telegram:123:btw:1",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "stop" }) },
      "telegram:123:control",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "stop please" }) },
      "telegram:123:control",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "do not do that" }) },
      "telegram:123:control",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "остановись" }) },
      "telegram:123:control",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "halt" }) },
      "telegram:123:control",
    ],
    [{ message: mockMessage({ chat: mockChat({ id: 123 }), text: "/abort" }) }, "telegram:123"],
    [{ message: mockMessage({ chat: mockChat({ id: 123 }), text: "/abort now" }) }, "telegram:123"],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "please do not do that" }) },
      "telegram:123",
    ],
  ])("resolves key %#", (input, expected) => {
    expect(getTelegramSequentialKey(input)).toBe(expected);
  });
});

describe("getTelegramBusyAwareSequentialKey", () => {
  it("gives a busy conversation plain follow-ups a unique ingress key", () => {
    const ctx = {
      message: mockMessage({
        chat: mockChat({ id: 123, type: "private" }),
        message_id: 44,
        text: "change the requirement",
      }),
    };
    const release = markTelegramSequentialKeyBusy("telegram:123");
    try {
      expect(getTelegramBusyAwareSequentialKey(ctx)).toBe("telegram:123:queued-message:44");
    } finally {
      release();
    }
    expect(getTelegramBusyAwareSequentialKey(ctx)).toBe("telegram:123");
  });

  it("lets an exact Queue/Steer callback bypass the busy message handler", () => {
    const ctx = {
      update: {
        callback_query: {
          id: "callback-9",
          data: "oqs:12345678-1234-4234-8234-123456789abc",
          message: mockMessage({ chat: mockChat({ id: 123, type: "private" }) }),
        },
      },
    };
    const release = markTelegramSequentialKeyBusy("telegram:123");
    try {
      expect(getTelegramBusyAwareSequentialKey(ctx)).toBe("telegram:123:queue-control:callback-9");
    } finally {
      release();
    }
  });

  it("keeps commands serialized while the conversation is busy", () => {
    const ctx = {
      message: mockMessage({
        chat: mockChat({ id: 123, type: "private" }),
        message_id: 45,
        text: "/status",
      }),
    };
    const release = markTelegramSequentialKeyBusy("telegram:123");
    try {
      expect(getTelegramBusyAwareSequentialKey(ctx)).toBe("telegram:123");
    } finally {
      release();
    }
  });
});
