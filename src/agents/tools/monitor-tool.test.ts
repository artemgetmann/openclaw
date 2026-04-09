import { beforeEach, describe, expect, it, vi } from "vitest";

const { callGatewayToolMock, resolveAnnounceTargetMock } = vi.hoisted(() => ({
  callGatewayToolMock: vi.fn(async (_method: string, _opts: unknown, params: unknown) => params),
  resolveAnnounceTargetMock: vi.fn(async () => ({
    channel: "telegram",
    to: "19098680",
    accountId: "default",
  })),
}));

vi.mock("./gateway.js", async () => {
  const actual = await vi.importActual<typeof import("./gateway.js")>("./gateway.js");
  return {
    ...actual,
    callGatewayTool: callGatewayToolMock,
  };
});

vi.mock("./sessions-announce-target.js", () => ({
  resolveAnnounceTarget: resolveAnnounceTargetMock,
}));

import { createMonitorTool } from "./monitor-tool.js";

describe("monitor tool", () => {
  beforeEach(() => {
    callGatewayToolMock.mockClear();
    resolveAnnounceTargetMock.mockClear();
  });

  it("defaults monitor creation to origin-chat announce routing and notify_draft", async () => {
    const tool = createMonitorTool({ agentSessionKey: "agent:main:telegram:direct:19098680" });

    await tool.execute?.("call-1", {
      action: "create",
      instructions: "Monitor Empower replies and draft the next response.",
      sourceType: "gmail",
      sourceTarget: { account: "me@example.com", threadId: "thread-1" },
      cadence: { kind: "every", everyMs: 300_000 },
    });

    expect(callGatewayToolMock).toHaveBeenCalledWith(
      "monitor.create",
      expect.any(Object),
      expect.objectContaining({
        originSessionKey: "agent:main:telegram:direct:19098680",
        originDelivery: expect.objectContaining({
          channel: "telegram",
          to: "19098680",
        }),
        actionPolicy: "notify_draft",
        sourceType: "gmail",
      }),
    );
  });

  it("maps status/checkpoint updates into monitor.update", async () => {
    const tool = createMonitorTool({ agentSessionKey: "agent:main:telegram:direct:19098680" });

    await tool.execute?.("call-2", {
      action: "update",
      monitorId: "monitor-1",
      status: "completed",
      checkpoint: { lastSeenMessageId: "msg-9" },
    });

    expect(callGatewayToolMock).toHaveBeenCalledWith("monitor.update", expect.any(Object), {
      monitorId: "monitor-1",
      patch: {
        status: "completed",
        lastCheckpoint: { lastSeenMessageId: "msg-9" },
      },
    });
  });
});
