import { beforeEach, describe, expect, it, vi } from "vitest";
import { MONITOR_RECEIPT_DETAILS_KEY } from "../../monitor/receipt.js";

const { callGatewayToolMock, resolveAnnounceTargetMock } = vi.hoisted(() => ({
  callGatewayToolMock: vi.fn(async (_method: string, _opts: unknown, params: unknown) => params),
  resolveAnnounceTargetMock: vi.fn(
    async (): Promise<{
      channel: string;
      to: string;
      accountId: string;
      threadId?: string;
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

  it("preserves the enumerable create receipt marker through serialization without changing content", async () => {
    const disclosure = {
      purpose: "Watch support replies",
      source: { type: "gmail", target: { threadId: "thread-1" } },
      checkCadence: { kind: "every", everyMs: 300_000 },
      noChangeCadence: { noticeAfterChecks: 3, reminderIntervalMs: 43_200_000 },
      expiryAt: null,
      stopCondition: null,
      autonomy: { level: "observe_only" },
      actionPolicy: "notify_draft",
    };
    callGatewayToolMock.mockResolvedValueOnce({ monitorId: "monitor-1", disclosure });
    const tool = createMonitorTool({ agentSessionKey: "agent:main:telegram:direct:19098680" });

    const result = await tool.execute?.("call-receipt-marker", {
      action: "create",
      instructions: disclosure.purpose,
      sourceType: "gmail",
      sourceTarget: disclosure.source.target,
      cadence: disclosure.checkCadence,
    });

    expect(result).toBeDefined();
    if (!result) {
      throw new Error("monitor.create did not return a tool result");
    }
    const serializedResult = JSON.parse(JSON.stringify(result));
    expect(serializedResult.content).toEqual(result.content);
    expect(serializedResult.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({ monitorId: "monitor-1", disclosure }, null, 2),
      },
    ]);
    expect(serializedResult.details[MONITOR_RECEIPT_DETAILS_KEY]).toBe(true);
    expect(serializedResult.details.disclosure).toEqual(disclosure);
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

  it("canonicalizes a session-resolved Telegram topic before gateway validation", async () => {
    resolveAnnounceTargetMock.mockResolvedValueOnce({
      channel: "telegram",
      to: "group:-1003783709877",
      accountId: "default",
      threadId: "21581",
    });
    const originSessionKey = "agent:main:telegram:group:-1003783709877:topic:21581";
    const tool = createMonitorTool({ agentSessionKey: originSessionKey });

    await tool.execute?.("call-topic", {
      action: "create",
      instructions: "Quote the matching reply and draft the next response for approval.",
      sourceType: "whatsapp",
      sourceTarget: { target: "+971552857036" },
      cadence: { kind: "every", everyMs: 300_000 },
    });

    expect(callGatewayToolMock).toHaveBeenCalledWith(
      "monitor.create",
      expect.any(Object),
      expect.objectContaining({
        originSessionKey,
        originDelivery: {
          mode: "announce",
          channel: "telegram",
          to: "-1003783709877:topic:21581",
          accountId: "default",
        },
      }),
    );
    const gatewayParams = callGatewayToolMock.mock.calls.at(-1)?.[2] as
      | { originDelivery?: Record<string, unknown> }
      | undefined;
    expect(gatewayParams?.originDelivery).not.toHaveProperty("threadId");
  });

  it("describes natural-language monitor routing safety", () => {
    const tool = createMonitorTool({ agentSessionKey: "agent:main:telegram:direct:19098680" });

    expect(tool.description).toContain("monitor-router skill");
    expect(tool.description).toContain("use list/get to inspect candidate monitors before acting");
    expect(tool.description).toContain(
      "if multiple active monitors could match, ask a short clarification",
    );
    expect(tool.description).toContain("include the actual draft text");
    expect(tool.description).toContain("use actionPolicy=auto_send");
    expect(tool.description).toContain("green-zone replies go to that watched surface");
    expect(tool.description).toContain("approval questions must go back to the origin chat");
    expect(tool.description).toContain("only reporting status");
    expect(tool.description).toContain(
      "record a short semantic description of relevant image/media contents when first seen",
    );
    expect(tool.description).toContain("store raw evidence only as stable ids/refs");
    expect(tool.description).toContain("never image paths, data URIs, or bytes");
    expect(tool.description).toContain("do not rely on re-reading media on every wake");
    expect(tool.description).toContain("if there is an active goal");
    expect(tool.description).toContain("exact check cadence");
    expect(tool.description).toContain("successful unchanged checks 1-2 are silent");
    expect(tool.description).toContain("actionPolicy controls delivery only");
    expect(tool.description).toContain("Do not repeat the cadence, expiry, stop condition");
    expect(tool.description).toContain("Never call a consumer monitor a cron job");
  });

  it("describes the canonical Telegram-as-me event binding contract", () => {
    const tool = createMonitorTool({ agentSessionKey: "agent:main:telegram:direct:19098680" });

    expect(tool.description).toContain("sourceType=telegram-user");
    expect(tool.description).toContain("sourceTarget.chat");
    expect(tool.description).toContain("exact Telegram chat");
    expect(tool.description).toContain("omit watchDelivery");
    expect(tool.description).toContain("local listener");
    expect(tool.description).toContain("instead of supplying a schedule-only trigger");
  });

  it("describes the canonical WhatsApp-as-me delivery contract", () => {
    const tool = createMonitorTool({ agentSessionKey: "agent:main:telegram:direct:19098680" });

    expect(tool.description).toContain("sourceType=whatsapp");
    expect(tool.description).toContain("sourceTarget.target");
    expect(tool.description).toContain("wacli");
    expect(tool.description).toContain("omit watchDelivery");
  });

  it("passes explicit goal snapshots through monitor.create", async () => {
    const tool = createMonitorTool({ agentSessionKey: "agent:main:telegram:direct:19098680" });

    await tool.execute?.("call-goal", {
      action: "create",
      instructions: "Watch the dinner thread until time and place are agreed.",
      sourceType: "whatsapp",
      sourceTarget: { target: "+15551234567" },
      cadence: { kind: "every", everyMs: 300_000 },
      goal: {
        id: "goal-1",
        objective: "Organize dinner between 7 and 8.",
        autonomy: {
          level: "act_within_scope",
          allowedActions: ["confirm a time between 7 and 8"],
          approvalRequired: ["accept another time"],
        },
      },
    });

    expect(callGatewayToolMock).toHaveBeenCalledWith(
      "monitor.create",
      expect.any(Object),
      expect.objectContaining({
        goal: {
          id: "goal-1",
          objective: "Organize dinner between 7 and 8.",
          autonomy: {
            level: "act_within_scope",
            allowedActions: ["confirm a time between 7 and 8"],
            approvalRequired: ["accept another time"],
          },
        },
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

  it("passes notification events for gateway-owned quiet-tick state", async () => {
    const tool = createMonitorTool({ agentSessionKey: "agent:main:telegram:direct:19098680" });

    await tool.execute?.("call-notification", {
      action: "update",
      monitorId: "monitor-1",
      patch: { notificationEvent: "unchanged", notificationState: { forged: true } },
    });

    expect(callGatewayToolMock).toHaveBeenCalledWith("monitor.update", expect.any(Object), {
      monitorId: "monitor-1",
      patch: { notificationEvent: "unchanged" },
    });
  });

  it("drops model-only monitor update patch keys before gateway validation", async () => {
    const tool = createMonitorTool({ agentSessionKey: "agent:main:telegram:direct:19098680" });

    await tool.execute?.("call-stop-reason", {
      action: "update",
      monitorId: "monitor-1",
      patch: {
        lastCheckpoint: { checkpointId: "ckpt-1" },
        stopReason: "end_turn",
      },
    });

    expect(callGatewayToolMock).toHaveBeenCalledWith("monitor.update", expect.any(Object), {
      monitorId: "monitor-1",
      patch: {
        lastCheckpoint: { checkpointId: "ckpt-1" },
      },
    });
  });
});
