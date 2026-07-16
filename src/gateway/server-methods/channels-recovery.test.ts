import { describe, expect, it } from "vitest";
import { applyGatewayOwnedChannelStatus } from "./channels.js";

describe("applyGatewayOwnedChannelStatus", () => {
  it("publishes Telegram recovery from the runtime snapshot", () => {
    const telegramRecovery = {
      phase: "exhausted" as const,
      providerRestartAttempts: 2,
      reason: "gateway restart rejected",
      updatedAt: 123,
    };

    const snapshot = applyGatewayOwnedChannelStatus(
      { accountId: "default", running: false },
      { accountId: "default", telegramRecovery },
    );

    expect(snapshot.telegramRecovery).toEqual(telegramRecovery);
  });

  it("does not invent recovery when runtime state has no incident", () => {
    const snapshot = applyGatewayOwnedChannelStatus(
      { accountId: "default", running: true },
      { accountId: "default", running: true },
    );

    expect(snapshot).not.toHaveProperty("telegramRecovery");
  });
});
