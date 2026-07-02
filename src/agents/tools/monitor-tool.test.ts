import { beforeEach, describe, expect, it, vi } from "vitest";

const { callGatewayToolMock, resolveAnnounceTargetMock } = vi.hoisted(() => ({
  callGatewayToolMock: vi.fn(async (_method: string, _opts: unknown, params: unknown) => params),
  resolveAnnounceTargetMock: vi.fn(
    async (): Promise<{
      channel: string;
      to: string;
      accountId: string;
    } | null> => ({
      channel: "telegram",
      to: "19098680",
      accountId: "default",
    }),
  ),
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
          mode: "announce",
          channel: "telegram",
          to: "19098680",
        }),
        actionPolicy: "notify_draft",
        sourceType: "gmail",
      }),
    );
  });

  it("adds announce mode to explicit bare origin delivery", async () => {
    const tool = createMonitorTool({ agentSessionKey: "agent:main:telegram:direct:19098680" });

    await tool.execute?.("call-explicit-bare", {
      action: "create",
      instructions: "Monitor replies and report back.",
      originDelivery: { channel: "telegram", to: "19098680", accountId: "default" },
      sourceType: "synthetic",
      sourceTarget: { source: "proof" },
      cadence: { kind: "every", everyMs: 300_000 },
    });

    expect(callGatewayToolMock).toHaveBeenCalledWith(
      "monitor.create",
      expect.any(Object),
      expect.objectContaining({
        originDelivery: {
          mode: "announce",
          channel: "telegram",
          to: "19098680",
          accountId: "default",
        },
      }),
    );
  });

  it("describes natural-language monitor routing safety", () => {
    const tool = createMonitorTool({ agentSessionKey: "agent:main:telegram:direct:19098680" });

    expect(tool.description).toContain("monitor-router skill");
    expect(tool.description).toContain("use list/get to inspect candidate monitors before acting");
    expect(tool.description).toContain(
      "if multiple active monitors could match, ask a short clarification",
    );
    expect(tool.description).toContain("include the actual draft text");
    expect(tool.description).toContain("only reporting status");
    expect(tool.description).toContain("keep raw evidence behind ids, paths, or refs");
    expect(tool.description).toContain("if there is an active goal");
  });

  it("passes explicit goal snapshots through monitor.create", async () => {
    const tool = createMonitorTool({ agentSessionKey: "agent:main:telegram:direct:19098680" });

    await tool.execute?.("call-goal", {
      action: "create",
      instructions: "Watch the dinner thread until time and place are agreed.",
      sourceType: "whatsapp",
      sourceTarget: { target: "+15551234567" },
      cadence: { kind: "every", everyMs: 300_000 },
      goal: { id: "goal-1", objective: "Organize dinner between 7 and 8." },
    });

    expect(callGatewayToolMock).toHaveBeenCalledWith(
      "monitor.create",
      expect.any(Object),
      expect.objectContaining({
        goal: { id: "goal-1", objective: "Organize dinner between 7 and 8." },
      }),
    );
  });

  it("omits originDelivery when the origin session has no announce target", async () => {
    resolveAnnounceTargetMock.mockResolvedValueOnce(null);
    const tool = createMonitorTool({ agentSessionKey: "agent:main:main" });

    await tool.execute?.("call-cli", {
      action: "create",
      instructions: "Monitor this thread and draft replies.",
      sourceType: "gmail",
      sourceTarget: { account: "me@example.com", threadId: "thread-2" },
      cadence: { kind: "every", everyMs: 300_000 },
    });

    expect(callGatewayToolMock).toHaveBeenCalledWith(
      "monitor.create",
      expect.any(Object),
      expect.not.objectContaining({
        originDelivery: expect.anything(),
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
