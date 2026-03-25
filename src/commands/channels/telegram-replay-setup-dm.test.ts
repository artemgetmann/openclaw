import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfig = vi.fn();
const resolveTelegramAccount = vi.fn();
const readTelegramUpdateOffset = vi.fn();
const writeTelegramUpdateOffset = vi.fn();
const handleUpdate = vi.fn();
const initBot = vi.fn(async () => undefined);
const stopBot = vi.fn(async () => undefined);
const createTelegramBot = vi.fn(() => ({
  init: initBot,
  handleUpdate,
  stop: stopBot,
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => loadConfig(),
}));

vi.mock("../../../extensions/telegram/src/accounts.js", () => ({
  resolveTelegramAccount: (params: unknown) => resolveTelegramAccount(params),
}));

vi.mock("../../../extensions/telegram/src/update-offset-store.js", () => ({
  readTelegramUpdateOffset: (params: unknown) => readTelegramUpdateOffset(params),
  writeTelegramUpdateOffset: (params: unknown) => writeTelegramUpdateOffset(params),
}));

vi.mock("../../../extensions/telegram/src/bot.js", () => ({
  createTelegramBot: (params: unknown) => createTelegramBot(params),
}));

const { channelsTelegramReplaySetupDmCommand } = await import("./telegram-replay-setup-dm.js");

describe("channelsTelegramReplaySetupDmCommand", () => {
  beforeEach(() => {
    loadConfig.mockReset().mockReturnValue({ channels: { telegram: {} } });
    resolveTelegramAccount.mockReset().mockReturnValue({
      accountId: "default",
      token: "123456:telegram-token",
      config: {},
    });
    readTelegramUpdateOffset.mockReset().mockResolvedValue(40);
    writeTelegramUpdateOffset.mockReset().mockResolvedValue(undefined);
    initBot.mockReset().mockResolvedValue(undefined);
    handleUpdate.mockReset().mockImplementation(async () => undefined);
    stopBot.mockReset().mockResolvedValue(undefined);
    createTelegramBot.mockClear();
  });

  it("replays a captured DM through the Telegram bot pipeline and logs JSON", async () => {
    const logs: string[] = [];
    const runtime = {
      log: (line: unknown) => logs.push(String(line)),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await channelsTelegramReplaySetupDmCommand(
      {
        json: true,
        payloadJson: JSON.stringify({
          updateId: 41,
          messageId: 99,
          chatId: 123456789,
          senderId: 123456789,
          senderUsername: "consumer_user",
          senderFirstName: "Consumer",
          text: "hello there",
          date: 1_711_234_567,
        }),
      },
      runtime as never,
    );

    expect(createTelegramBot).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "123456:telegram-token",
        accountId: "default",
        updateOffset: expect.objectContaining({
          lastUpdateId: 40,
        }),
      }),
    );
    expect(handleUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        update_id: 41,
        message: expect.objectContaining({
          message_id: 99,
          text: "hello there",
          chat: expect.objectContaining({
            id: 123456789,
            type: "private",
          }),
        }),
      }),
    );
    expect(initBot).toHaveBeenCalledTimes(1);
    expect(stopBot).toHaveBeenCalledTimes(1);
    expect(logs[0]).toContain('"replyStarted":true');
  });

  it("rejects payloads without text or caption", async () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await expect(
      channelsTelegramReplaySetupDmCommand(
        {
          payloadJson: JSON.stringify({
            updateId: 41,
            messageId: 99,
            chatId: 123456789,
            senderId: 123456789,
            date: 1_711_234_567,
          }),
          json: true,
        },
        runtime as never,
      ),
    ).rejects.toThrow("needs text or caption");

    expect(createTelegramBot).not.toHaveBeenCalled();
  });
});
