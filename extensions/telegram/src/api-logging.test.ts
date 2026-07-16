import { describe, expect, it, vi } from "vitest";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { TelegramTransportError } from "./fetch.js";

function buildTokenBearingNetworkError(token: string, code: string): Error {
  return Object.assign(
    new TypeError(`fetch failed for https://api.telegram.org/bot${token}/getUpdates`),
    {
      cause: Object.assign(new Error(`connect ${code}`), { code }),
    },
  );
}

describe("withTelegramApiErrorLogging transport diagnostics", () => {
  it("logs ordered attempt phases and codes without exposing the bot token", async () => {
    const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd";
    const err = new TelegramTransportError([
      {
        phase: "primary",
        elapsedMs: 120,
        error: buildTokenBearingNetworkError(token, "ENETUNREACH"),
      },
      {
        phase: "ipv4-fallback",
        elapsedMs: 300,
        error: buildTokenBearingNetworkError(token, "ETIMEDOUT"),
      },
    ]);
    const logger = vi.fn();

    await expect(
      withTelegramApiErrorLogging({
        operation: "getUpdates",
        logger,
        fn: async () => {
          throw err;
        },
      }),
    ).rejects.toBe(err);

    const logged = String(logger.mock.calls[0]?.[0]);
    expect(logged).toContain("primary(elapsedMs=120, codes=ENETUNREACH");
    expect(logged).toContain("ipv4-fallback(elapsedMs=300, codes=ETIMEDOUT");
    expect(logged).not.toContain(token);
  });
});
