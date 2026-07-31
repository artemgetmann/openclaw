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
    const callbackData = registration.buttons[0]?.[0]?.callback_data;
    expect(registration.buttons).toEqual([
      [
        {
          text: "⏹ Stop",
          callback_data: expect.stringMatching(/^ors:[a-f0-9]{24}$/),
          style: "danger",
        },
      ],
    ]);

    const claim = claimTelegramRunStop({
      data: callbackData ?? "",
      accountId: "default",
      chatId: 123,
      requesterId: 9,
      threadId: 77,
    });
    expect(claim?.status).toBe("claimed");
    expect(
      claimTelegramRunStop({
        data: callbackData ?? "",
        accountId: "default",
        chatId: 123,
        requesterId: 9,
        threadId: 77,
      }),
    ).toEqual({ status: "stale" });
  });

  it("fails closed for another user, chat, account, or topic", () => {
    const registration = registerTelegramRunStop({
      accountId: "default",
      chatId: 123,
      requesterId: 9,
      threadId: 77,
    });
    const callbackData = registration.buttons[0]?.[0]?.callback_data ?? "";

    expect(
      claimTelegramRunStop({
        data: callbackData,
        accountId: "default",
        chatId: 123,
        requesterId: 10,
        threadId: 77,
      }),
    ).toEqual({ status: "mismatch" });
    expect(
      claimTelegramRunStop({
        data: callbackData,
        accountId: "default",
        chatId: 123,
        requesterId: 9,
        threadId: 77,
      })?.status,
    ).toBe("claimed");
  });

  it("restores a failed claim for retry without reusing tokens after reset", () => {
    const registration = registerTelegramRunStop({
      accountId: "default",
      chatId: 123,
      requesterId: 9,
    });
    const callbackData = registration.buttons[0]?.[0]?.callback_data ?? "";
    const claim = claimTelegramRunStop({
      data: callbackData,
      accountId: "default",
      chatId: 123,
      requesterId: 9,
    });
    expect(claim?.status).toBe("claimed");
    if (claim?.status !== "claimed") {
      throw new Error("expected claimed Stop control");
    }
    claim.restore();
    expect(
      claimTelegramRunStop({
        data: callbackData,
        accountId: "default",
        chatId: 123,
        requesterId: 9,
      })?.status,
    ).toBe("claimed");

    __testing.resetTelegramRunStopsForTests();
    const nextRegistration = registerTelegramRunStop({
      accountId: "default",
      chatId: 123,
      requesterId: 9,
    });
    expect(nextRegistration.buttons[0]?.[0]?.callback_data).not.toBe(callbackData);
  });

  it("does not restore a claim after its controller releases the registration", () => {
    const registration = registerTelegramRunStop({
      accountId: "default",
      chatId: 123,
      requesterId: 9,
    });
    const callbackData = registration.buttons[0]?.[0]?.callback_data ?? "";
    const claim = claimTelegramRunStop({
      data: callbackData,
      accountId: "default",
      chatId: 123,
      requesterId: 9,
    });
    expect(claim?.status).toBe("claimed");
    if (claim?.status !== "claimed") {
      throw new Error("expected claimed Stop control");
    }

    // The token is absent while claimed. Releasing during that window must
    // still permanently retire the authorization before a failed abort can
    // attempt to restore it.
    registration.release();
    claim.restore();

    expect(
      claimTelegramRunStop({
        data: callbackData,
        accountId: "default",
        chatId: 123,
        requesterId: 9,
      }),
    ).toEqual({ status: "stale" });
  });

  it("keeps released run A stale while same-route run B remains claimable", () => {
    const route = {
      accountId: "default",
      chatId: 123,
      requesterId: 9,
      threadId: 77,
    };
    const runA = registerTelegramRunStop(route);
    const runAToken = runA.buttons[0]?.[0]?.callback_data ?? "";
    const runAClaim = claimTelegramRunStop({
      data: runAToken,
      ...route,
    });
    expect(runAClaim?.status).toBe("claimed");
    if (runAClaim?.status !== "claimed") {
      throw new Error("expected run A Stop control to be claimed");
    }

    // Closing run A while its claim is in flight permanently tombstones that
    // authorization. A failed-abort restore must not compete with the distinct
    // token allocated for the next run on the exact same route.
    runA.release();
    runAClaim.restore();
    const runB = registerTelegramRunStop(route);
    const runBToken = runB.buttons[0]?.[0]?.callback_data ?? "";

    expect(runBToken).not.toBe(runAToken);
    expect(
      claimTelegramRunStop({
        data: runAToken,
        ...route,
      }),
    ).toEqual({ status: "stale" });
    expect(
      claimTelegramRunStop({
        data: runBToken,
        ...route,
      })?.status,
    ).toBe("claimed");
  });

  it("releases controls idempotently and rejects malformed callback data", () => {
    const registration = registerTelegramRunStop({
      accountId: "default",
      chatId: 123,
      requesterId: 9,
    });
    const callbackData = registration.buttons[0]?.[0]?.callback_data ?? "";
    registration.release();
    registration.release();

    expect(parseTelegramRunStopCallbackData(callbackData)).toBe(callbackData.slice(4));
    expect(parseTelegramRunStopCallbackData("ors:")).toBeUndefined();
    expect(parseTelegramRunStopCallbackData(`ors:${"a".repeat(23)}`)).toBeUndefined();
    expect(
      claimTelegramRunStop({
        data: callbackData,
        accountId: "default",
        chatId: 123,
        requesterId: 9,
      }),
    ).toEqual({ status: "stale" });
  });
});
