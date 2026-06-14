import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

const backendMocks = vi.hoisted(() => ({
  getTelegramUserDefaultPollIntervalMs: vi.fn(() => 1),
  getTelegramUserDefaultWaitTimeoutMs: vi.fn(() => 5),
  runTelegramUserInbox: vi.fn(),
  runTelegramUserLogin: vi.fn(),
  runTelegramUserLogout: vi.fn(),
  runTelegramUserPrecheck: vi.fn(),
  runTelegramUserRead: vi.fn(),
  runTelegramUserDownload: vi.fn(),
  runTelegramUserSend: vi.fn(),
  runTelegramUserStatus: vi.fn(),
  runTelegramUserTopicCreate: vi.fn(),
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
  telegramUserInboxCommand,
  telegramUserLoginCommand,
  telegramUserLogoutCommand,
  telegramUserPrecheckCommand,
  telegramUserReadCommand,
  telegramUserDownloadCommand,
  telegramUserSendCommand,
  telegramUserStatusCommand,
  telegramUserTopicCreateCommand,
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

  it("renders status output for an expired session", async () => {
    backendMocks.runTelegramUserStatus.mockResolvedValueOnce({
      backend_meta: backendMeta,
      chat: null,
      pending_login: null,
      session_path: "scripts/telegram-e2e/tmp/userbot.session",
      state: "needs_reauth",
      user: null,
    });

    await telegramUserStatusCommand({}, runtime);

    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("state=needs_reauth"));
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("pending_state=-"));
  });

  it("renders login output when a code was sent", async () => {
    backendMocks.runTelegramUserLogin.mockResolvedValueOnce({
      backend_meta: backendMeta,
      pending_login: { phone: "+15551234567", state: "awaiting_code" },
      session_path: "scripts/telegram-e2e/tmp/userbot.session",
      state: "awaiting_code",
      user: null,
    });

    await telegramUserLoginCommand({ phone: "+15551234567", code: "12345" }, runtime);

    expect(backendMocks.runTelegramUserLogin).toHaveBeenCalledWith({
      code: "12345",
      envFile: undefined,
      password: undefined,
      phone: "+15551234567",
      session: undefined,
    });
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("login pending"));
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("state=awaiting_code"));
  });

  it("keeps login JSON mode non-interactive and reads 2FA from env", async () => {
    vi.stubEnv("OPENCLAW_TELEGRAM_USER_LOGIN_PASSWORD", "super-secret");
    backendMocks.runTelegramUserLogin.mockResolvedValueOnce({
      backend_meta: backendMeta,
      pending_login: { phone: "+15551234567", state: "awaiting_password" },
      session_path: "scripts/telegram-e2e/tmp/userbot.session",
      state: "awaiting_password",
      user: null,
    });

    await telegramUserLoginCommand({ phone: "+15551234567", json: true }, runtime);

    expect(backendMocks.runTelegramUserLogin).toHaveBeenCalledWith({
      code: undefined,
      envFile: undefined,
      password: "super-secret",
      phone: "+15551234567",
      session: undefined,
    });
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining('"state": "awaiting_password"'),
    );
    vi.unstubAllEnvs();
  });

  it("rejects login JSON mode without a phone instead of prompting", async () => {
    await expect(telegramUserLoginCommand({ json: true }, runtime)).rejects.toThrow(
      /requires --phone when --json is enabled/i,
    );
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

  it("preserves text send behavior when media flags are absent", async () => {
    backendMocks.runTelegramUserSend.mockResolvedValueOnce({
      backend_meta: backendMeta,
      message: {
        chat_id: 10,
        chat_title: null,
        chat_username: "jarvis_tester_1_bot",
        date: "2026-03-24T00:00:00.000Z",
        direct_messages_topic: null,
        direct_messages_topic_id: null,
        media_kind: null,
        message_id: 124,
        out: true,
        reply_to_msg_id: null,
        reply_to_top_id: null,
        sender_id: 99,
        text: "hello",
        thread_anchor: null,
      },
    });

    await telegramUserSendCommand({ chat: "@jarvis_tester_1_bot", message: "hello" }, runtime);

    expect(backendMocks.runTelegramUserSend).toHaveBeenCalledWith({
      caption: undefined,
      chat: "@jarvis_tester_1_bot",
      envFile: undefined,
      media: undefined,
      message: "hello",
      session: undefined,
      voice: false,
      replyTo: undefined,
    });
  });

  it("sends media with optional caption and explicit voice mode", async () => {
    backendMocks.runTelegramUserSend.mockResolvedValueOnce({
      backend_meta: backendMeta,
      message: {
        chat_id: 10,
        chat_title: null,
        chat_username: "jarvis_tester_1_bot",
        date: "2026-03-24T00:00:00.000Z",
        direct_messages_topic: null,
        direct_messages_topic_id: null,
        media_kind: "voice",
        message_id: 125,
        out: true,
        reply_to_msg_id: 120,
        reply_to_top_id: 120,
        sender_id: 99,
        text: "voice caption",
        thread_anchor: 120,
      },
    });

    await telegramUserSendCommand(
      {
        caption: "voice caption",
        chat: "-1003783709877",
        media: "/tmp/proof.ogg",
        replyTo: "120",
        voice: true,
      },
      runtime,
    );

    expect(backendMocks.runTelegramUserSend).toHaveBeenCalledWith({
      caption: "voice caption",
      chat: "-1003783709877",
      envFile: undefined,
      media: "/tmp/proof.ogg",
      message: undefined,
      session: undefined,
      voice: true,
      replyTo: 120,
    });
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("message_id=125"));
  });

  it("uses message text as the media caption when caption is omitted", async () => {
    backendMocks.runTelegramUserSend.mockResolvedValueOnce({
      backend_meta: backendMeta,
      message: {
        chat_id: 10,
        chat_title: null,
        chat_username: "jarvis_tester_1_bot",
        date: "2026-03-24T00:00:00.000Z",
        direct_messages_topic: null,
        direct_messages_topic_id: null,
        media_kind: "document",
        message_id: 126,
        out: true,
        reply_to_msg_id: null,
        reply_to_top_id: null,
        sender_id: 99,
        text: "fallback caption",
        thread_anchor: null,
      },
    });

    await telegramUserSendCommand(
      {
        chat: "-1003783709877",
        media: "/tmp/proof.pdf",
        message: "fallback caption",
      },
      runtime,
    );

    expect(backendMocks.runTelegramUserSend).toHaveBeenCalledWith(
      expect.objectContaining({
        caption: "fallback caption",
        media: "/tmp/proof.pdf",
        message: undefined,
      }),
    );
  });

  it("rejects send without text or media", async () => {
    await expect(
      telegramUserSendCommand({ chat: "@jarvis_tester_1_bot" }, runtime),
    ).rejects.toThrow(/requires --chat and either --message or --media/i);
  });

  it("renders topic-create JSON with topic anchor metadata", async () => {
    backendMocks.runTelegramUserTopicCreate.mockResolvedValueOnce({
      backend_meta: backendMeta,
      chat_id: -1003783709877,
      message_id: 15250,
      topic_anchor: 15250,
      topic_title: "voice proof",
    });

    await telegramUserTopicCreateCommand(
      { chat: "-1003783709877", json: true, title: "voice proof" },
      runtime,
    );

    expect(backendMocks.runTelegramUserTopicCreate).toHaveBeenCalledWith({
      chat: "-1003783709877",
      envFile: undefined,
      session: undefined,
      title: "voice proof",
    });
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining('"topic_anchor": 15250'));
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

    await telegramUserReadCommand(
      { chat: "@jarvis_tester_1_bot", contains: "reply", limit: "5" },
      runtime,
    );

    expect(backendMocks.runTelegramUserRead).toHaveBeenCalledWith({
      afterId: undefined,
      beforeId: undefined,
      chat: "@jarvis_tester_1_bot",
      contains: "reply",
      envFile: undefined,
      limit: 5,
      session: undefined,
    });
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("reply text"));
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("200"));
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("messages=1"));
  });

  it("downloads message media by chat and message id", async () => {
    backendMocks.runTelegramUserDownload.mockResolvedValueOnce({
      backend_meta: backendMeta,
      chat: "@jarvis_tester_1_bot",
      media_kind: "voice",
      message: {
        chat_id: 10,
        chat_title: null,
        chat_username: "jarvis_tester_1_bot",
        date: "2026-03-24T00:00:00.000Z",
        direct_messages_topic: null,
        direct_messages_topic_id: null,
        media_kind: "voice",
        message_id: 52830,
        out: false,
        reply_to_msg_id: null,
        reply_to_top_id: null,
        sender_id: 555,
        text: "",
        thread_anchor: null,
      },
      message_id: 52830,
      path: "/tmp/openclaw-media/telegram-jarvis_tester_1_bot-52830.oga",
      size_bytes: 1234,
    });

    await telegramUserDownloadCommand(
      {
        chat: "@jarvis_tester_1_bot",
        messageId: "52830",
        output: "/tmp/openclaw-media",
      },
      runtime,
    );

    expect(backendMocks.runTelegramUserDownload).toHaveBeenCalledWith({
      chat: "@jarvis_tester_1_bot",
      envFile: undefined,
      messageId: 52830,
      output: "/tmp/openclaw-media",
      session: undefined,
    });
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("download ok"));
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("media_kind=voice"));
  });

  it("renders media download JSON output", async () => {
    backendMocks.runTelegramUserDownload.mockResolvedValueOnce({
      backend_meta: backendMeta,
      chat: "@jarvis_tester_1_bot",
      media_kind: "voice",
      message: {
        chat_id: 10,
        chat_title: null,
        chat_username: "jarvis_tester_1_bot",
        date: null,
        direct_messages_topic: null,
        direct_messages_topic_id: null,
        media_kind: "voice",
        message_id: 52830,
        out: false,
        reply_to_msg_id: null,
        reply_to_top_id: null,
        sender_id: 555,
        text: "",
        thread_anchor: null,
      },
      message_id: 52830,
      path: "/tmp/voice.oga",
      size_bytes: 1234,
    });

    await telegramUserDownloadCommand(
      {
        chat: "@jarvis_tester_1_bot",
        json: true,
        messageId: 52830,
        output: "/tmp/voice.oga",
      },
      runtime,
    );

    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining('"path": "/tmp/voice.oga"'));
  });

  it("renders inbox JSON output with unread DM filters", async () => {
    backendMocks.runTelegramUserInbox.mockResolvedValueOnce({
      backend_meta: backendMeta,
      dialogs: [
        {
          archived: false,
          chat_id: 10,
          chat_title: null,
          chat_username: "jarvis_tester_1_bot",
          display_name: "Jarvis Tester 1",
          folder_id: null,
          is_bot: true,
          is_channel: false,
          is_group: false,
          is_user: true,
          last_message: {
            chat_id: 10,
            chat_title: null,
            chat_username: "jarvis_tester_1_bot",
            date: "2026-03-24T00:00:00.000Z",
            direct_messages_topic: null,
            direct_messages_topic_id: null,
            message_id: 321,
            out: false,
            reply_to_msg_id: null,
            reply_to_top_id: null,
            sender_id: 555,
            text: "Need attention",
            thread_anchor: null,
          },
          muted: false,
          pinned: true,
          unread_count: 3,
          unread_mentions_count: 1,
          unread_reactions_count: 0,
        },
      ],
    });

    await telegramUserInboxCommand(
      { contains: "attention", dmOnly: true, json: true, limit: "5", unread: true },
      runtime,
    );

    expect(backendMocks.runTelegramUserInbox).toHaveBeenCalledWith({
      contains: "attention",
      dmOnly: true,
      envFile: undefined,
      limit: 5,
      session: undefined,
      unreadOnly: true,
    });
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining('"display_name": "Jarvis Tester 1"'),
    );
  });

  it("renders inbox text output with triage summary", async () => {
    backendMocks.runTelegramUserInbox.mockResolvedValueOnce({
      backend_meta: backendMeta,
      dialogs: [
        {
          archived: true,
          chat_id: 10,
          chat_title: "Ops Room",
          chat_username: null,
          display_name: "Ops Room",
          folder_id: 1,
          is_bot: false,
          is_channel: false,
          is_group: true,
          is_user: false,
          last_message: {
            chat_id: 10,
            chat_title: "Ops Room",
            chat_username: null,
            date: "2026-03-24T00:00:00.000Z",
            direct_messages_topic: null,
            direct_messages_topic_id: null,
            message_id: 322,
            out: false,
            reply_to_msg_id: null,
            reply_to_top_id: null,
            sender_id: 556,
            text: "server down",
            thread_anchor: null,
          },
          muted: true,
          pinned: false,
          unread_count: 9,
          unread_mentions_count: 2,
          unread_reactions_count: 1,
        },
      ],
    });

    await telegramUserInboxCommand({}, runtime);

    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("dialogs=1 unread_only=false dm_only=false"),
    );
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("Ops Room"));
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("server down"));
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

  it("renders logout output with cleared paths", async () => {
    backendMocks.runTelegramUserLogout.mockResolvedValueOnce({
      backend_meta: backendMeta,
      cleared: true,
      removed_paths: [
        "scripts/telegram-e2e/tmp/userbot.session",
        "scripts/telegram-e2e/tmp/userbot.session.openclaw-login.json",
      ],
      session_path: "scripts/telegram-e2e/tmp/userbot.session",
    });

    await telegramUserLogoutCommand({}, runtime);

    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("cleared session state"));
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("userbot.session.openclaw-login.json"),
    );
  });
});
