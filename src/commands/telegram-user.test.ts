import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

const backendMocks = vi.hoisted(() => ({
  getTelegramUserDefaultPollIntervalMs: vi.fn(() => 1),
  getTelegramUserDefaultWaitTimeoutMs: vi.fn(() => 5),
  runTelegramUserPrecheck: vi.fn(),
  runTelegramUserRead: vi.fn(),
  runTelegramUserSend: vi.fn(),
  sleep: vi.fn(async () => {}),
}));

const backendMeta = {
  api_hash_source: "env-file" as const,
  api_id_source: "process-env" as const,
  env_file: "scripts/telegram-e2e/.env.local",
  session_path: "scripts/telegram-e2e/tmp/userbot.session",
};

vi.mock("../telegram-user/backend.js", () => backendMocks);

const runtime: RuntimeEnv = {
  error: vi.fn(),
  exit: vi.fn(),
  log: vi.fn(),
};

const {
  telegramUserPrecheckCommand,
  telegramUserReadCommand,
  telegramUserSendCommand,
  telegramUserWaitCommand,
} = await import("./telegram-user.js");

describe("telegram-user commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders precheck JSON output", async () => {
    backendMocks.runTelegramUserPrecheck.mockResolvedValueOnce({
      backend_meta: backendMeta,
      chat: { chat_id: 10, peer_type: "User", title: null, username: "jarvis_tester_1_bot" },
      session_path: "scripts/telegram-e2e/tmp/userbot.session",
      user: { first_name: "Tester", user_id: 99, username: "artem" },
    });

    await telegramUserPrecheckCommand({ chat: "@jarvis_tester_1_bot", json: true }, runtime);

    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining('"user_id": 99'));
  });

  it("renders send text output with raw reply metadata", async () => {
    backendMocks.runTelegramUserSend.mockResolvedValueOnce({
      backend_meta: backendMeta,
      message: {
        chat_id: 10,
        chat_title: null,
        chat_username: "jarvis_tester_1_bot",
        date: "2026-03-24T00:00:00.000Z",
        direct_messages_topic: { topic_id: 7001 },
        direct_messages_topic_id: 7001,
        message_id: 123,
        out: true,
        reply_to_msg_id: 122,
        reply_to_top_id: 120,
        sender_id: 99,
        text: "hello",
        thread_anchor: 7001,
      },
    });

    await telegramUserSendCommand(
      { chat: "@jarvis_tester_1_bot", message: "hello", replyTo: "122" },
      runtime,
    );

    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("message_id=123"));
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("env_file="));
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("direct_messages_topic.topic_id=7001"),
    );
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining('text="hello"'));
  });

  it("renders recent messages as a table", async () => {
    backendMocks.runTelegramUserRead.mockResolvedValueOnce({
      backend_meta: backendMeta,
      messages: [
        {
          chat_id: 10,
          chat_title: null,
          chat_username: "jarvis_tester_1_bot",
          date: "2026-03-24T00:00:00.000Z",
          direct_messages_topic: null,
          direct_messages_topic_id: null,
          message_id: 200,
          out: false,
          reply_to_msg_id: 123,
          reply_to_top_id: 120,
          sender_id: 555,
          text: "reply text",
          thread_anchor: 120,
        },
      ],
    });

    await telegramUserReadCommand({ chat: "@jarvis_tester_1_bot", limit: "5" }, runtime);

    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("reply text"));
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("200"));
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("messages=1"));
  });

  it("waits until a reply matches by DM topic id", async () => {
    backendMocks.runTelegramUserRead
      .mockResolvedValueOnce({
        backend_meta: backendMeta,
        messages: [
          {
            chat_id: 10,
            chat_title: null,
            chat_username: "jarvis_tester_1_bot",
            date: "2026-03-24T00:00:00.000Z",
            direct_messages_topic: null,
            direct_messages_topic_id: null,
            message_id: 200,
            out: false,
            reply_to_msg_id: null,
            reply_to_top_id: null,
            sender_id: 123,
            text: "wrong sender",
            thread_anchor: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        backend_meta: backendMeta,
        messages: [
          {
            chat_id: 10,
            chat_title: null,
            chat_username: "jarvis_tester_1_bot",
            date: "2026-03-24T00:00:00.000Z",
            direct_messages_topic: { topic_id: 7001 },
            direct_messages_topic_id: 7001,
            message_id: 201,
            out: false,
            reply_to_msg_id: null,
            reply_to_top_id: null,
            sender_id: 456,
            text: "bot reply",
            thread_anchor: 7001,
          },
        ],
      });

    await telegramUserWaitCommand(
      {
        afterId: "199",
        chat: "@jarvis_tester_1_bot",
        contains: "reply",
        pollIntervalMs: "1",
        senderId: "456",
        threadAnchor: "7001",
        timeoutMs: "10",
      },
      runtime,
    );

    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("via direct_messages_topic.topic_id"),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("session=scripts/telegram-e2e/tmp/userbot.session"),
    );
  });

  it("throws a strong timeout diagnostic when matching fails", async () => {
    backendMocks.runTelegramUserRead.mockResolvedValue({
      messages: [
        {
          chat_id: 10,
          chat_title: null,
          chat_username: "jarvis_tester_1_bot",
          date: "2026-03-24T00:00:00.000Z",
          direct_messages_topic: null,
          direct_messages_topic_id: null,
          message_id: 300,
          out: false,
          reply_to_msg_id: 299,
          reply_to_top_id: null,
          sender_id: 123,
          text: "still wrong",
          thread_anchor: 299,
        },
      ],
    });

    await expect(
      telegramUserWaitCommand(
        {
          afterId: "250",
          chat: "@jarvis_tester_1_bot",
          contains: "reply",
          pollIntervalMs: "1",
          senderId: "456",
          timeoutMs: "5",
        },
        runtime,
      ),
    ).rejects.toThrow(/Ignored recent candidates/);
  });
});
