import { beforeEach, describe, expect, it, vi } from "vitest";
import { stopSpy } from "./bot.create-telegram-bot.test-harness.js";

const resolveTelegramTransport = vi.hoisted(() => vi.fn());
const closeTransport = vi.hoisted(() => vi.fn<() => Promise<void>>());

vi.mock("./fetch.js", () => ({
  resolveTelegramTransport,
}));

const { createTelegramBot, waitForTelegramBotTransportClose } = await import("./bot.js");

describe("createTelegramBot transport lifecycle", () => {
  beforeEach(() => {
    stopSpy.mockReset();
    closeTransport.mockReset();
    closeTransport.mockResolvedValue(undefined);
    resolveTelegramTransport.mockReturnValue({
      fetch: vi.fn(),
      sourceFetch: vi.fn(),
      close: closeTransport,
    });
  });

  it("passes safe context and exposes one awaitable close across repeated stops", async () => {
    let finishClose: (() => void) | undefined;
    closeTransport.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    const bot = createTelegramBot({
      token: "test-token",
      accountId: "main",
      transportGeneration: 7,
    });

    bot.stop();
    bot.stop();

    expect(resolveTelegramTransport).toHaveBeenCalledWith(undefined, {
      network: undefined,
      context: { accountId: "main", generation: 7 },
    });
    expect(closeTransport).toHaveBeenCalledTimes(1);
    expect(stopSpy).toHaveBeenCalledTimes(2);

    let closeCompleted = false;
    const closeCompletion = waitForTelegramBotTransportClose(bot).then(() => {
      closeCompleted = true;
    });
    await Promise.resolve();
    expect(closeCompleted).toBe(false);

    finishClose?.();
    await closeCompletion;
    expect(closeCompleted).toBe(true);
  });
});
