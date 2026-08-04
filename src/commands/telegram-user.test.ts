import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

const backendMocks = vi.hoisted(() => ({
  getTelegramUserDefaultPollIntervalMs: vi.fn(() => 1),
  getTelegramUserDefaultWaitTimeoutMs: vi.fn(() => 5),
  runTelegramUserButtonClick: vi.fn(),
  runTelegramUserInbox: vi.fn(),
  runTelegramUserLogin: vi.fn(),
  runTelegramUserLogout: vi.fn(),
  runTelegramUserMarkRead: vi.fn(),
  runTelegramUserMarkUnread: vi.fn(),
  runTelegramUserPrecheck: vi.fn(),
  runTelegramUserRead: vi.fn(),
  runTelegramUserDownload: vi.fn(),
  runTelegramUserSend: vi.fn(),
  runTelegramUserStatus: vi.fn(),
  runTelegramUserTopicCreate: vi.fn(),
  runTelegramUserTopicDelete: vi.fn(),
  runTelegramUserTopicList: vi.fn(),
  runTelegramUserTopicResolve: vi.fn(),
  sleep: vi.fn(async () => {}),
}));

const listenerHealthMocks = vi.hoisted(() => ({
  classifyFatalListenerHealthError: vi.fn(() => "poll_failed:error"),
  resolveListenerHealthStorePath: vi.fn(() => "/tmp/telegram-listener-health.json"),
  updateListenerHealth: vi.fn(async () => ({
    record: { lastError: null as string | null },
    state: "healthy",
    transition: null as "degraded" | "recovered" | null,
  })),
}));

const backendMeta = {
  api_hash_source: "env-file" as const,
  api_id_source: "process-env" as const,
  env_file: "scripts/telegram-e2e/.env.local",
  session_path: "scripts/telegram-e2e/tmp/userbot.session",
};

vi.mock("../telegram-user/backend.js", () => backendMocks);
vi.mock("../monitor/listener-health.js", () => listenerHealthMocks);

const runtime: RuntimeEnv = {
  error: vi.fn(),
  exit: vi.fn(),
  log: vi.fn(),
};

const {
  telegramUserButtonClickCommand,
  telegramUserInboxCommand,
  telegramUserMonitorListenCommand,
  telegramUserMonitorPollCommand,
  telegramUserDoctorCommand,
  telegramUserLoginCommand,
  telegramUserLogoutCommand,
  telegramUserMarkReadCommand,
  telegramUserMarkUnreadCommand,
  telegramUserPrecheckCommand,
  telegramUserReadCommand,
  telegramUserDownloadCommand,
  telegramUserSendCommand,
  telegramUserStatusCommand,
  telegramUserTopicCreateCommand,
  telegramUserTopicDeleteCommand,
  telegramUserTopicResolveCommand,
  telegramUserWaitCommand,
} = await import("./telegram-user.js");

describe("telegram-user commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENCLAW_TELEGRAM_LIVE_MONITOR_LISTENER_INSTANCE;
  });

  it("forwards exact button selectors and renders bounded JSON", async () => {
    backendMocks.runTelegramUserButtonClick.mockResolvedValueOnce({
      backend_meta: backendMeta,
      button: {
        callback_data: "queue:proof",
        callback_data_base64: "cXVldWU6cHJvb2Y=",
        column: 0,
        row: 1,
        text: " Queue ",
        url: null,
      },
      chat: "@jarvis_tester_1_bot",
      click_result: { alert: false, cache_time: 0, message: "Queued", url: null },
      clicked: true,
      message_id: 52831,
    });

    await telegramUserButtonClickCommand(
      {
        buttonText: " Queue ",
        chat: "@jarvis_tester_1_bot",
        expectedCallbackData: " queue:proof ",
        json: true,
        messageId: "52831",
      },
      runtime,
    );

    expect(backendMocks.runTelegramUserButtonClick).toHaveBeenCalledWith({
      buttonText: " Queue ",
      chat: "@jarvis_tester_1_bot",
      envFile: undefined,
      expectedCallbackData: " queue:proof ",
      expectedUrl: undefined,
      messageId: 52831,
      session: undefined,
    });
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining('"clicked": true'));
  });

  it("rejects a non-positive button-click message id before the backend", async () => {
    await expect(
      telegramUserButtonClickCommand(
        {
          buttonText: "Queue",
          chat: "@jarvis_tester_1_bot",
          expectedCallbackData: "queue:proof",
          messageId: "0",
        },
        runtime,
      ),
    ).rejects.toThrow("positive integer");

    expect(backendMocks.runTelegramUserButtonClick).not.toHaveBeenCalled();
  });

  it("forwards an exact URL button guard without normalizing it", async () => {
    backendMocks.runTelegramUserButtonClick.mockResolvedValueOnce({
      backend_meta: backendMeta,
      button: {
        callback_data: null,
        callback_data_base64: null,
        column: 0,
        row: 0,
        text: "Participant chat",
        url: "https://t.me/+exact-participant-invite",
      },
      chat: "@jarvis_tester_1_bot",
      click_result: {
        alert: false,
        cache_time: 0,
        message: null,
        url: "https://t.me/+exact-participant-invite",
      },
      clicked: true,
      message_id: 52832,
    });

    await telegramUserButtonClickCommand(
      {
        buttonText: "Participant chat",
        chat: "@jarvis_tester_1_bot",
        expectedUrl: "https://t.me/+exact-participant-invite",
        json: true,
        messageId: "52832",
      },
      runtime,
    );

    expect(backendMocks.runTelegramUserButtonClick).toHaveBeenCalledWith({
      buttonText: "Participant chat",
      chat: "@jarvis_tester_1_bot",
      envFile: undefined,
      expectedCallbackData: undefined,
      expectedUrl: "https://t.me/+exact-participant-invite",
      messageId: 52832,
      session: undefined,
    });
  });

  it("renders a pending Telegram join request as structured non-retry success", async () => {
    backendMocks.runTelegramUserButtonClick.mockResolvedValueOnce({
      backend_meta: backendMeta,
      button: {
        callback_data: null,
        callback_data_base64: null,
        column: 0,
        row: 0,
        text: "Participant chat",
        url: "https://t.me/+PendingInviteHash",
      },
      chat: "@jarvis_tester_1_bot",
      click_result: {
        alert: false,
        cache_time: 0,
        message: null,
        url: "https://t.me/+PendingInviteHash",
      },
      clicked: true,
      message_id: 52838,
      url_action: {
        kind: "import_chat_invite",
        status: "request_sent",
        url: "https://t.me/+PendingInviteHash",
      },
    });

    await telegramUserButtonClickCommand(
      {
        buttonText: "Participant chat",
        chat: "@jarvis_tester_1_bot",
        expectedUrl: "https://t.me/+PendingInviteHash",
        json: true,
        messageId: "52838",
      },
      runtime,
    );

    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining('"status": "request_sent"'));
  });

  it("rejects button-click when callback and URL guards are both supplied", async () => {
    await expect(
      telegramUserButtonClickCommand(
        {
          buttonText: "Queue",
          chat: "@jarvis_tester_1_bot",
          expectedCallbackData: "queue:proof",
          expectedUrl: "https://example.com/queue",
          messageId: "52831",
        },
        runtime,
      ),
    ).rejects.toThrow(/exactly one of --expected-callback-data or --expected-url/i);

    expect(backendMocks.runTelegramUserButtonClick).not.toHaveBeenCalled();
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

  it("renders doctor JSON for missing credentials with setup paths and missing fields", async () => {
    backendMocks.runTelegramUserStatus.mockResolvedValueOnce({
      backend_meta: {
        api_hash_source: "missing",
        api_id_source: "missing",
        env_file: "/Users/test/.openclaw/telegram-user/.env.local",
        session_path: "/Users/test/.openclaw/telegram-user/userbot.session",
      },
      chat: null,
      pending_login: null,
      session_path: "/Users/test/.openclaw/telegram-user/userbot.session",
      state: "missing_credentials",
      user: null,
    });

    await telegramUserDoctorCommand({ json: true }, runtime);

    const payload = JSON.parse(vi.mocked(runtime.log).mock.calls[0]?.[0] as string);
    expect(payload).toMatchObject({
      expected: {
        env_file: "/Users/test/.openclaw/telegram-user/.env.local",
        session_path: "/Users/test/.openclaw/telegram-user/userbot.session",
      },
      missing: {
        api_hash: true,
        api_id: true,
        session: false,
      },
      ready: false,
      state: "missing_credentials",
    });
    expect(payload.next_step).toContain("consumer-setup");
  });

  it("renders doctor text for missing session without claiming credentials are missing", async () => {
    backendMocks.runTelegramUserStatus.mockResolvedValueOnce({
      backend_meta: backendMeta,
      chat: null,
      pending_login: null,
      session_path: "scripts/telegram-e2e/tmp/userbot.session",
      state: "missing_session",
      user: null,
    });

    await telegramUserDoctorCommand({}, runtime);

    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("state=missing_session"));
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("has API credentials but no saved real-account session"),
    );
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("Expected session:"));
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("complete login"));
  });

  it("renders doctor text for sessions that need reauth", async () => {
    backendMocks.runTelegramUserStatus.mockResolvedValueOnce({
      backend_meta: backendMeta,
      chat: null,
      pending_login: null,
      session_path: "scripts/telegram-e2e/tmp/userbot.session",
      state: "needs_reauth",
      user: null,
    });

    await telegramUserDoctorCommand({}, runtime);

    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("state=needs_reauth"));
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Telegram no longer accepts it"),
    );
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("Reconnect Telegram-as-me"));
  });

  it("renders doctor JSON for a ready session with user and optional chat resolution", async () => {
    backendMocks.runTelegramUserStatus.mockResolvedValueOnce({
      backend_meta: backendMeta,
      chat: { chat_id: 10, peer_type: "User", title: null, username: "jarvis_tester_1_bot" },
      pending_login: null,
      session_path: "scripts/telegram-e2e/tmp/userbot.session",
      state: "ready",
      user: { first_name: "Tester", user_id: 99, username: "artem" },
    });

    await telegramUserDoctorCommand({ chat: "@jarvis_tester_1_bot", json: true }, runtime);

    expect(backendMocks.runTelegramUserStatus).toHaveBeenCalledWith({
      chat: "@jarvis_tester_1_bot",
      envFile: undefined,
      session: undefined,
    });
    const payload = JSON.parse(vi.mocked(runtime.log).mock.calls[0]?.[0] as string);
    expect(payload).toMatchObject({
      chat: { chat_id: 10, username: "jarvis_tester_1_bot" },
      ready: true,
      state: "ready",
      user: { user_id: 99, username: "artem" },
    });
  });

  it("renders doctor JSON for an in-progress login requiring Telegram 2FA", async () => {
    backendMocks.runTelegramUserStatus.mockResolvedValueOnce({
      backend_meta: backendMeta,
      chat: null,
      pending_login: { phone: "+15551234567", state: "awaiting_password" },
      session_path: "scripts/telegram-e2e/tmp/userbot.session",
      state: "awaiting_password",
      user: null,
    });

    await telegramUserDoctorCommand({ json: true }, runtime);

    const payload = JSON.parse(vi.mocked(runtime.log).mock.calls[0]?.[0] as string);
    expect(payload.state).toBe("awaiting_password");
    expect(payload.diagnosis).toContain("Telegram 2FA");
    expect(payload.next_step).toContain("secure local login prompt");
  });

  it("renders login output when a local code is still awaited", async () => {
    backendMocks.runTelegramUserLogin.mockResolvedValueOnce({
      backend_meta: backendMeta,
      pending_login: { phone: "+15551234567", state: "awaiting_code" },
      session_path: "scripts/telegram-e2e/tmp/userbot.session",
      state: "awaiting_code",
      user: null,
    });

    await telegramUserLoginCommand({ phone: "+15551234567", json: true }, runtime);

    expect(backendMocks.runTelegramUserLogin).toHaveBeenCalledWith({
      code: undefined,
      envFile: undefined,
      password: undefined,
      phone: "+15551234567",
      session: undefined,
    });
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining('"state": "awaiting_code"'));
  });

  it("does not read Telegram 2FA from the process environment", async () => {
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
      password: undefined,
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
      topicAnchor: undefined,
      topicTitle: undefined,
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
      topicAnchor: undefined,
      topicTitle: undefined,
    });
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("message_id=125"));
  });

  it("uses topic anchor as the reply target for forum-topic sends", async () => {
    backendMocks.runTelegramUserSend.mockResolvedValueOnce({
      backend_meta: backendMeta,
      message: {
        chat_id: -1003783709877,
        chat_title: "Jarvis Warm Discovery Calls",
        chat_username: null,
        date: "2026-06-27T10:00:00.000Z",
        direct_messages_topic: null,
        direct_messages_topic_id: null,
        media_kind: null,
        message_id: 18328,
        out: true,
        reply_to_msg_id: 18327,
        reply_to_top_id: 18327,
        sender_id: 99,
        text: "seed prompt",
        thread_anchor: 18327,
      },
    });

    await telegramUserSendCommand(
      {
        chat: "-1003783709877",
        message: "seed prompt",
        topicAnchor: "18327",
        topicTitle: "Jarvis Warm Discovery Calls",
      },
      runtime,
    );

    expect(backendMocks.runTelegramUserSend).toHaveBeenCalledWith(
      expect.objectContaining({
        chat: "-1003783709877",
        message: "seed prompt",
        replyTo: undefined,
        topicAnchor: 18327,
        topicTitle: "Jarvis Warm Discovery Calls",
      }),
    );
  });

  it("rejects an unlabelled topic anchor before calling the backend", async () => {
    await expect(
      telegramUserSendCommand(
        { chat: "-1003783709877", message: "seed prompt", topicAnchor: "28340" },
        runtime,
      ),
    ).rejects.toThrow(/requires --topic-title with --topic-anchor/i);
    expect(backendMocks.runTelegramUserSend).not.toHaveBeenCalled();
  });

  it("rejects conflicting reply and topic targets", async () => {
    await expect(
      telegramUserSendCommand(
        {
          chat: "-1003783709877",
          message: "seed prompt",
          replyTo: "111",
          topicAnchor: "222",
        },
        runtime,
      ),
    ).rejects.toThrow(/cannot combine --reply-to with a different topic anchor/i);
  });

  it("rejects malformed topic targets instead of sending unthreaded", async () => {
    await expect(
      telegramUserSendCommand(
        {
          chat: "-1003783709877",
          message: "seed prompt",
          topicAnchor: "not-a-number",
        },
        runtime,
      ),
    ).rejects.toThrow(/requires --topic-anchor to be a numeric message\/topic id/i);
    expect(backendMocks.runTelegramUserSend).not.toHaveBeenCalled();
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

  it("renders topic-delete JSON with bounded cleanup metadata", async () => {
    backendMocks.runTelegramUserTopicDelete.mockResolvedValueOnce({
      affected: {
        offset: 0,
        pts: 123,
        pts_count: 1,
      },
      backend_meta: backendMeta,
      chat_id: -1003783709877,
      deleted: true,
      topic_anchor: 15250,
    });

    await telegramUserTopicDeleteCommand(
      { chat: "-1003783709877", json: true, topicAnchor: "15250" },
      runtime,
    );

    expect(backendMocks.runTelegramUserTopicDelete).toHaveBeenCalledWith({
      chat: "-1003783709877",
      envFile: undefined,
      session: undefined,
      topicAnchor: 15250,
    });
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining('"topic_anchor": 15250'));
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining('"deleted": true'));
  });

  it("rejects topic-delete without an explicit topic anchor", async () => {
    await expect(
      telegramUserTopicDeleteCommand({ chat: "-1003783709877" }, runtime),
    ).rejects.toThrow(/requires --chat and --topic-anchor/i);
  });

  it("resolves an exact topic title to authoritative metadata", async () => {
    backendMocks.runTelegramUserTopicResolve.mockResolvedValueOnce({
      backend_meta: backendMeta,
      chat: "-1003783709877",
      topic: {
        closed: false,
        hidden: false,
        topic_anchor: 15250,
        topic_title: "Gmail Keychain Auth RCA",
      },
    });

    await telegramUserTopicResolveCommand(
      {
        chat: "-1003783709877",
        json: true,
        title: "Gmail Keychain Auth RCA",
      },
      runtime,
    );

    expect(backendMocks.runTelegramUserTopicResolve).toHaveBeenCalledWith({
      chat: "-1003783709877",
      envFile: undefined,
      session: undefined,
      title: "Gmail Keychain Auth RCA",
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
      topic: {
        closed: false,
        hidden: false,
        topic_anchor: 15250,
        topic_title: "Gmail Keychain Auth RCA",
      },
    });

    await telegramUserReadCommand(
      {
        chat: "-1003783709877",
        contains: "reply",
        limit: "5",
        topicAnchor: "15250",
      },
      runtime,
    );

    expect(backendMocks.runTelegramUserRead).toHaveBeenCalledWith({
      afterId: undefined,
      beforeId: undefined,
      chat: "-1003783709877",
      contains: "reply",
      envFile: undefined,
      limit: 5,
      session: undefined,
      topicAnchor: 15250,
    });
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("reply text"));
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("200"));
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("messages=1"));
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining('topic_title="Gmail Keychain Auth RCA"'),
    );
  });

  it("rejects a non-positive topic anchor before reading", async () => {
    await expect(
      telegramUserReadCommand({ chat: "-1003783709877", topicAnchor: "0" }, runtime),
    ).rejects.toThrow(/--topic-anchor to be a positive integer/i);
    expect(backendMocks.runTelegramUserRead).not.toHaveBeenCalled();
  });

  it("rejects a blank topic anchor before reading", async () => {
    await expect(
      telegramUserReadCommand({ chat: "-1003783709877", topicAnchor: "" }, runtime),
    ).rejects.toThrow(/--topic-anchor to be a positive integer/i);
    expect(backendMocks.runTelegramUserRead).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "rejects a boolean topic anchor before reading: %s",
    async (topicAnchor) => {
      await expect(
        telegramUserReadCommand({ chat: "-1003783709877", topicAnchor }, runtime),
      ).rejects.toThrow(/--topic-anchor to be a positive integer/i);
      expect(backendMocks.runTelegramUserRead).not.toHaveBeenCalled();
    },
  );

  it("keeps a genuinely absent topic anchor unscoped", async () => {
    backendMocks.runTelegramUserRead.mockResolvedValueOnce({
      backend_meta: backendMeta,
      messages: [],
    });

    await telegramUserReadCommand({ chat: "@jarvis_tester_1_bot" }, runtime);

    expect(backendMocks.runTelegramUserRead).toHaveBeenCalledWith({
      afterId: undefined,
      beforeId: undefined,
      chat: "@jarvis_tester_1_bot",
      contains: undefined,
      envFile: undefined,
      limit: 20,
      session: undefined,
      topicAnchor: undefined,
    });
  });

  it("renders recent messages in compact agent-friendly text", async () => {
    backendMocks.runTelegramUserRead.mockResolvedValueOnce({
      backend_meta: backendMeta,
      messages: [
        {
          chat_id: 10,
          chat_title: null,
          chat_username: "jarvis_tester_1_bot",
          date: "2026-03-24T00:00:00.000Z",
          direct_messages_topic: { topic_id: 7001 },
          direct_messages_topic_id: 7001,
          inline_buttons: [
            {
              callback_data: "oqs:12345678-1234-4234-8234-123456789abc",
              callback_data_base64: "b3FzOjEyMzQ1Njc4LTEyMzQtNDIzNC04MjM0LTEyMzQ1Njc4OWFiYw==",
              column: 1,
              row: 0,
              text: "Steer",
              url: null,
            },
            {
              callback_data: null,
              callback_data_base64: null,
              column: 0,
              row: 1,
              text: "Participant chat",
              url: "https://t.me/+exact-participant-invite",
            },
          ],
          media_kind: "voice",
          message_id: 200,
          out: false,
          reply_to_msg_id: 123,
          reply_to_top_id: 120,
          sender_id: 555,
          text: "reply\ntext",
          thread_anchor: 7001,
        },
      ],
    });

    await telegramUserReadCommand(
      { chat: "@jarvis_tester_1_bot", format: "compact", limit: "5" },
      runtime,
    );

    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "Telegram user read compact. chat=@jarvis_tester_1_bot messages=1 order=newest-first",
      ),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining(
        'id=200 date=2026-03-24T00:00:00.000Z dir=in sender=555 reply_to=123 top=120 topic=7001 media=voice buttons=[{"callback_data":"oqs:12345678-1234-4234-8234-123456789abc"',
      ),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining('"url":"https://t.me/+exact-participant-invite"'),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Paging: newer --after-id 200 | older --before-id 200"),
    );
  });

  it("renders recent messages as compact JSON without raw backend metadata", async () => {
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
          message_id: 201,
          out: true,
          reply_to_msg_id: null,
          reply_to_top_id: null,
          sender_id: 99,
          text: "sent text",
          thread_anchor: null,
        },
      ],
    });

    await telegramUserReadCommand(
      { chat: "@jarvis_tester_1_bot", format: "compact", json: true },
      runtime,
    );

    const payload = JSON.parse(vi.mocked(runtime.log).mock.calls[0]?.[0] as string);
    expect(payload).toEqual({
      chat: "@jarvis_tester_1_bot",
      messages: [
        {
          buttons: [],
          date: "2026-03-24T00:00:00.000Z",
          dir: "out",
          id: 201,
          media: null,
          reply_to: null,
          sender: 99,
          text: "sent text",
          top: null,
          topic: null,
        },
      ],
      order: "newest_first",
      paging: {
        newer_after_id: 201,
        older_before_id: 201,
      },
    });
  });

  it("rejects unknown Telegram read formats", async () => {
    await expect(
      telegramUserReadCommand({ chat: "@jarvis_tester_1_bot", format: "full-table" }, runtime),
    ).rejects.toThrow(/--format must be either table or compact/i);
    expect(backendMocks.runTelegramUserRead).not.toHaveBeenCalled();
  });

  it("marks current chat history read and renders structured JSON", async () => {
    backendMocks.runTelegramUserMarkRead.mockResolvedValueOnce({
      backend_meta: backendMeta,
      chat: "@jarvis_tester_1_bot",
      marked_read: true,
    });

    await telegramUserMarkReadCommand(
      {
        chat: "@jarvis_tester_1_bot",
        envFile: "/tmp/tg.env",
        json: true,
        session: "/tmp/userbot.session",
      },
      runtime,
    );

    expect(backendMocks.runTelegramUserMarkRead).toHaveBeenCalledWith({
      chat: "@jarvis_tester_1_bot",
      envFile: "/tmp/tg.env",
      session: "/tmp/userbot.session",
    });
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining('"marked_read": true'));
  });

  it("marks a dialog unread and renders text confirmation", async () => {
    backendMocks.runTelegramUserMarkUnread.mockResolvedValueOnce({
      backend_meta: backendMeta,
      chat: "-1003783709877",
      marked_unread: true,
    });

    await telegramUserMarkUnreadCommand({ chat: "-1003783709877" }, runtime);

    expect(backendMocks.runTelegramUserMarkUnread).toHaveBeenCalledWith({
      chat: "-1003783709877",
      envFile: undefined,
      session: undefined,
    });
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Telegram user mark-unread ok. chat=-1003783709877"),
    );
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

  it("emits a monitor event envelope for one new inbound Telegram-as-me message", async () => {
    backendMocks.runTelegramUserRead.mockResolvedValueOnce({
      backend_meta: backendMeta,
      messages: [
        {
          chat_id: 10,
          chat_title: null,
          chat_username: "jarvis_tester_1_bot",
          date: "2026-07-06T00:00:00.000Z",
          direct_messages_topic: { topic_id: 7001 },
          direct_messages_topic_id: 7001,
          message_id: 201,
          out: false,
          reply_to_msg_id: null,
          reply_to_top_id: null,
          sender_id: 456,
          text: "monitor reply",
          thread_anchor: 7001,
        },
      ],
    });

    await telegramUserMonitorListenCommand(
      {
        accountId: "personal",
        afterId: "200",
        chat: "@jarvis_tester_1_bot",
        contains: "reply",
        limit: "5",
        pollIntervalMs: "1",
        timeoutMs: "10",
      },
      runtime,
    );

    expect(backendMocks.runTelegramUserRead).toHaveBeenCalledWith({
      afterId: 200,
      chat: "@jarvis_tester_1_bot",
      contains: "reply",
      envFile: undefined,
      limit: 5,
      session: undefined,
    });
    expect(backendMocks.runTelegramUserSend).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining('"triggerKind": "local_listener"'),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining('"sourceType": "telegram-user"'),
    );
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining('"text": "monitor reply"'));
  });

  it("rejects remote monitor-poll hook URLs before reading Telegram", async () => {
    await expect(
      telegramUserMonitorPollCommand(
        {
          hookUrl: "https://example.com/hooks/telegram-user-monitor-event",
        },
        runtime,
      ),
    ).rejects.toThrow("must point to the local gateway");
    expect(backendMocks.runTelegramUserRead).not.toHaveBeenCalled();
  });

  it("rejects monitor-poll watch mode without dispatch or explicit cursor commit", async () => {
    await expect(
      telegramUserMonitorPollCommand(
        {
          watch: true,
        },
        runtime,
      ),
    ).rejects.toThrow("--watch requires --hook-url or --commit-without-dispatch");
    expect(backendMocks.runTelegramUserRead).not.toHaveBeenCalled();
  });

  it("rejects invalid monitor-poll watch bounds before looping", async () => {
    await expect(
      telegramUserMonitorPollCommand(
        {
          commitWithoutDispatch: true,
          maxRuns: "abc",
          watch: true,
        },
        runtime,
      ),
    ).rejects.toThrow("--max-runs");
    await expect(
      telegramUserMonitorPollCommand(
        {
          commitWithoutDispatch: true,
          pollIntervalMs: "0",
          watch: true,
        },
        runtime,
      ),
    ).rejects.toThrow("--poll-interval-ms");
    expect(backendMocks.runTelegramUserRead).not.toHaveBeenCalled();
    expect(backendMocks.sleep).not.toHaveBeenCalled();
  });

  it("runs monitor-poll watch mode repeatedly until max-runs", async () => {
    const instanceId = "c".repeat(48);
    process.env.OPENCLAW_TELEGRAM_LIVE_MONITOR_LISTENER_INSTANCE = instanceId;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-monitor-poll-"));
    const monitorStore = path.join(root, "monitors.json");
    await fs.writeFile(monitorStore, JSON.stringify({ version: 1, monitors: [] }), "utf-8");

    await telegramUserMonitorPollCommand(
      {
        commitWithoutDispatch: true,
        json: true,
        maxRuns: "2",
        monitorStore,
        pollIntervalMs: "7",
        watch: true,
      },
      runtime,
    );

    expect(backendMocks.runTelegramUserRead).not.toHaveBeenCalled();
    expect(backendMocks.sleep).toHaveBeenCalledTimes(1);
    expect(backendMocks.sleep).toHaveBeenCalledWith(7);
    expect(runtime.log).toHaveBeenCalledTimes(2);
    expect(runtime.log).toHaveBeenNthCalledWith(1, expect.stringContaining('"run": 1'));
    expect(runtime.log).toHaveBeenNthCalledWith(2, expect.stringContaining('"run": 2'));
    expect(listenerHealthMocks.updateListenerHealth).toHaveBeenCalledTimes(2);
    expect(listenerHealthMocks.updateListenerHealth).toHaveBeenLastCalledWith(
      expect.objectContaining({
        check: "success",
        owner: expect.objectContaining({ instanceId }),
        routedEvent: false,
        service: "telegram-user",
      }),
    );
  });

  it("does not persist managed listener health for one-shot monitor polls", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-monitor-poll-"));
    const monitorStore = path.join(root, "monitors.json");
    await fs.writeFile(monitorStore, JSON.stringify({ version: 1, monitors: [] }), "utf-8");

    await telegramUserMonitorPollCommand({ json: true, monitorStore }, runtime);

    expect(listenerHealthMocks.updateListenerHealth).not.toHaveBeenCalled();
  });

  it("persists a bounded failure before a fatal watch poll exits", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-monitor-poll-"));
    const monitorStore = path.join(root, "monitors.json");
    await fs.writeFile(monitorStore, "not-json", "utf8");

    await expect(
      telegramUserMonitorPollCommand(
        { commitWithoutDispatch: true, monitorStore, watch: true },
        runtime,
      ),
    ).rejects.toThrow();

    expect(listenerHealthMocks.updateListenerHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        check: "failure",
        error: "poll_failed:error",
        service: "telegram-user",
      }),
    );
  });

  it("keeps polling when health persistence is temporarily unavailable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-monitor-poll-"));
    const monitorStore = path.join(root, "monitors.json");
    await fs.writeFile(monitorStore, JSON.stringify({ version: 1, monitors: [] }), "utf8");
    listenerHealthMocks.updateListenerHealth.mockRejectedValueOnce(new Error("permission denied"));
    const healthError = vi.fn();

    await telegramUserMonitorPollCommand(
      {
        commitWithoutDispatch: true,
        maxRuns: 2,
        monitorStore,
        pollIntervalMs: 1,
        watch: true,
      },
      { error: healthError, exit: vi.fn(), log: vi.fn() },
    );

    expect(listenerHealthMocks.updateListenerHealth).toHaveBeenCalledTimes(2);
    expect(healthError).toHaveBeenCalledTimes(1);
    expect(healthError).toHaveBeenCalledWith(
      expect.stringContaining("health persistence unavailable"),
    );
  });

  it("surfaces degraded and recovered listener transitions once", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-monitor-poll-"));
    const monitorStore = path.join(root, "monitors.json");
    await fs.writeFile(monitorStore, JSON.stringify({ version: 1, monitors: [] }), "utf-8");
    listenerHealthMocks.updateListenerHealth
      .mockResolvedValueOnce({
        record: { lastError: "safe backend error" },
        state: "degraded",
        transition: "degraded",
      })
      .mockResolvedValueOnce({
        record: { lastError: null },
        state: "healthy",
        transition: "recovered",
      });
    const transitionLog = vi.fn();
    const runtimeWithErrors = { error: vi.fn(), log: transitionLog, exit: vi.fn() } as RuntimeEnv;

    await telegramUserMonitorPollCommand(
      {
        commitWithoutDispatch: true,
        json: true,
        maxRuns: "2",
        monitorStore,
        pollIntervalMs: "1",
        watch: true,
      },
      runtimeWithErrors,
    );

    expect(runtimeWithErrors.error).toHaveBeenCalledTimes(1);
    expect(runtimeWithErrors.error).toHaveBeenCalledWith(
      expect.stringContaining("listener health degraded"),
    );
    expect(runtimeWithErrors.log).toHaveBeenCalledWith(
      expect.stringContaining("listener health recovered"),
    );
    expect(
      transitionLog.mock.calls.filter(([message]) =>
        String(message).includes("listener health recovered"),
      ),
    ).toHaveLength(1);
  });

  it("accepts custom local hooks.path monitor-poll URLs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-monitor-poll-"));
    const monitorStore = path.join(root, "monitors.json");
    await fs.writeFile(monitorStore, JSON.stringify({ version: 1, monitors: [] }), "utf-8");

    await telegramUserMonitorPollCommand(
      {
        hookUrl: "http://127.0.0.1:18789/secret/telegram-user-monitor-event",
        json: true,
        monitorStore,
      },
      runtime,
    );

    expect(backendMocks.runTelegramUserRead).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining('"checked": 0'));
  });

  it("posts monitor-poll hook payloads scoped to the filtered monitor", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-monitor-poll-"));
    const monitorStore = path.join(root, "monitors.json");
    await fs.writeFile(
      monitorStore,
      JSON.stringify(
        {
          version: 1,
          monitors: [
            {
              monitorId: "telegram-monitor-1",
              agentId: "main",
              name: "Telegram-as-me wait",
              originSessionKey: "agent:main:telegram:direct:user-1",
              monitorSessionKey: "agent:main:monitor:telegram-monitor-1",
              sourceType: "telegram-user",
              sourceTarget: {
                accountId: "personal",
                afterId: 100,
                chat: "@jarvis_tester_1_bot",
                threadAnchor: "7001",
              },
              cadence: { kind: "every", everyMs: 300_000 },
              trigger: {
                kind: "local_listener",
                match: {
                  sourceType: "telegram-user",
                  sourceTarget: {
                    accountId: "personal",
                    chat: "@jarvis_tester_1_bot",
                    threadAnchor: "7001",
                  },
                  eventTypes: ["message.created"],
                },
              },
              actionPolicy: "notify_draft",
              goal: {
                id: "goal-telegram-reply",
                objective: "Wait until the Telegram contact replies.",
              },
              status: "active",
              cronJobId: "cron-telegram-monitor-1",
              createdAtMs: 1_000_000,
              updatedAtMs: 1_000_000,
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    backendMocks.runTelegramUserRead.mockResolvedValueOnce({
      messages: [
        {
          chat_id: 10,
          chat_title: "Jarvis Lab",
          chat_username: "jarvis_tester_1_bot",
          date: "2026-07-06T00:00:00.000Z",
          direct_messages_topic: { topic_id: 7001 },
          direct_messages_topic_id: 7001,
          media_kind: null,
          message_id: 101,
          out: false,
          reply_to_msg_id: null,
          reply_to_top_id: null,
          sender_id: 456,
          text: "fresh reply",
          thread_anchor: 7001,
        },
      ],
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ matched: 1, wakes: [{ monitorId: "telegram-monitor-1" }] }), {
        status: 200,
      }),
    );

    let body: { monitorId?: string } = {};
    let fetchUrl: unknown;
    try {
      await telegramUserMonitorPollCommand(
        {
          hookUrl: "http://127.0.0.1:18789/hooks/telegram-user-monitor-event/",
          json: true,
          monitorStore,
        },
        runtime,
      );
      const requestBody = fetchMock.mock.calls[0]?.[1]?.body;
      if (typeof requestBody !== "string") {
        throw new Error("expected monitor-poll hook body to be JSON text");
      }
      body = JSON.parse(requestBody) as {
        monitorId?: string;
      };
      fetchUrl = fetchMock.mock.calls[0]?.[0];
    } finally {
      fetchMock.mockRestore();
    }

    expect(body.monitorId).toBe("telegram-monitor-1");
    expect(fetchUrl).toBe("http://127.0.0.1:18789/hooks/telegram-user-monitor-event");
  });

  it.each([
    {
      expectedToken: "dedicated-hooks-token",
      gatewayToken: "legacy-gateway-token",
      hooksToken: "dedicated-hooks-token",
      source: "OPENCLAW_HOOKS_TOKEN before the gateway compatibility fallback",
    },
    {
      expectedToken: "legacy-gateway-token",
      gatewayToken: "legacy-gateway-token",
      hooksToken: "",
      source: "OPENCLAW_GATEWAY_TOKEN as a compatibility fallback",
    },
  ])("uses $source for monitor-poll hook auth without exposing it", async (tokenCase) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-monitor-poll-"));
    const monitorStore = path.join(root, "monitors.json");
    await fs.writeFile(
      monitorStore,
      JSON.stringify(
        {
          version: 1,
          monitors: [
            {
              monitorId: "telegram-monitor-token",
              agentId: "main",
              name: "Telegram-as-me wait",
              originSessionKey: "agent:main:telegram:direct:user-1",
              monitorSessionKey: "agent:main:monitor:telegram-monitor-token",
              sourceType: "telegram-user",
              sourceTarget: {
                afterId: 100,
                chat: "@jarvis_tester_1_bot",
              },
              cadence: { kind: "every", everyMs: 300_000 },
              trigger: {
                kind: "local_listener",
                match: {
                  sourceType: "telegram-user",
                  sourceTarget: { chat: "@jarvis_tester_1_bot" },
                  eventTypes: ["message.created"],
                },
              },
              actionPolicy: "notify_draft",
              goal: {
                id: "goal-telegram-reply",
                objective: "Wait until the Telegram contact replies.",
              },
              status: "active",
              cronJobId: "cron-telegram-monitor-token",
              createdAtMs: 1_000_000,
              updatedAtMs: 1_000_000,
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    backendMocks.runTelegramUserRead.mockResolvedValueOnce({
      messages: [
        {
          chat_id: 10,
          chat_title: "Jarvis Lab",
          chat_username: "jarvis_tester_1_bot",
          date: "2026-07-06T00:00:00.000Z",
          direct_messages_topic: null,
          direct_messages_topic_id: null,
          media_kind: null,
          message_id: 101,
          out: false,
          reply_to_msg_id: null,
          reply_to_top_id: null,
          sender_id: 456,
          text: "fresh reply",
          thread_anchor: null,
        },
      ],
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ matched: 1, wakes: [{ monitorId: "telegram-monitor-token" }] }),
        {
          status: 200,
        },
      ),
    );
    vi.stubEnv("OPENCLAW_HOOKS_TOKEN", tokenCase.hooksToken);
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", tokenCase.gatewayToken);

    let headers: unknown;
    try {
      await telegramUserMonitorPollCommand(
        {
          hookUrl: "http://127.0.0.1:18789/hooks/telegram-user-monitor-event",
          json: true,
          monitorStore,
        },
        runtime,
      );
      headers = fetchMock.mock.calls[0]?.[1]?.headers;
    } finally {
      fetchMock.mockRestore();
      vi.unstubAllEnvs();
    }

    expect(headers).toMatchObject({
      Authorization: `Bearer ${tokenCase.expectedToken}`,
    });
    expect(
      JSON.stringify([
        ...vi.mocked(runtime.log).mock.calls,
        ...vi.mocked(runtime.error).mock.calls,
        ...vi.mocked(runtime.exit).mock.calls,
      ]),
    ).not.toContain(tokenCase.expectedToken);
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
      owner_path_preserved: true,
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
    expect(runtime.log).toHaveBeenCalledWith("owner_path_preserved=true");
  });
});
