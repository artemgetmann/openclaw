import { beforeEach, describe, expect, it } from "vitest";
import {
  __testing,
  claimTelegramRunStop,
  parseTelegramRunStopCallbackData,
  registerTelegramRunStop,
} from "./run-stop-control.js";

describe("Telegram active run Stop control", () => {
  beforeEach(() => {
    __testing.resetTelegramRunStopsForTests();
  });

  it("renders one explicit danger action and accepts one exact claim", () => {
    const registration = registerTelegramRunStop({
      accountId: "default",
      chatId: 123,
      requesterId: 9,
      threadId: 77,
    });
    expect(registration.buttons).toEqual([
      [
        {
          text: "⏹ Stop",
          callback_data: "ors:1",
          style: "danger",
        },
      ],
    ]);

    expect(
      claimTelegramRunStop({
        data: "ors:1",
        accountId: "default",
        chatId: 123,
        requesterId: 9,
        threadId: 77,
      }),
    ).toEqual({ status: "claimed" });
    expect(
      claimTelegramRunStop({
        data: "ors:1",
        accountId: "default",
        chatId: 123,
        requesterId: 9,
        threadId: 77,
      }),
    ).toEqual({ status: "stale" });
  });

  it("fails closed for another user, chat, account, or topic", () => {
    registerTelegramRunStop({
      accountId: "default",
      chatId: 123,
      requesterId: 9,
      threadId: 77,
    });

    expect(
      claimTelegramRunStop({
        data: "ors:1",
        accountId: "default",
        chatId: 123,
        requesterId: 10,
        threadId: 77,
      }),
    ).toEqual({ status: "mismatch" });
    expect(
      claimTelegramRunStop({
        data: "ors:1",
        accountId: "default",
        chatId: 123,
        requesterId: 9,
        threadId: 77,
      }),
    ).toEqual({ status: "claimed" });
  });

  it("releases controls idempotently and rejects malformed callback data", () => {
    const registration = registerTelegramRunStop({
      accountId: "default",
      chatId: 123,
      requesterId: 9,
    });
    registration.release();
    registration.release();

    expect(parseTelegramRunStopCallbackData("ors:1")).toBe("1");
    expect(parseTelegramRunStopCallbackData("ors:")).toBeUndefined();
    expect(parseTelegramRunStopCallbackData(`ors:${"a".repeat(21)}`)).toBeUndefined();
    expect(
      claimTelegramRunStop({
        data: "ors:1",
        accountId: "default",
        chatId: 123,
        requesterId: 9,
      }),
    ).toEqual({ status: "stale" });
  });
});
