import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../protocol/index.js";

const { seedMonitorSessionMock } = vi.hoisted(() => ({
  seedMonitorSessionMock: vi.fn(async () => undefined),
}));

vi.mock("../../monitor/session.js", () => ({
  seedMonitorSession: seedMonitorSessionMock,
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    loadConfig: vi.fn(() => ({
      session: {
        store: path.join(os.tmpdir(), `monitor-handler-session-${Date.now()}.json`),
        mainKey: "main",
      },
    })),
  };
});

import { monitorHandlers } from "./monitor.js";

type RespondCall = [boolean, unknown?, { code: string; message: string }?];

function createInvokeContext() {
  const respond = vi.fn();
  let cronAddCount = 0;
  const cronAdd = vi.fn(async (job: Record<string, unknown>) => ({
    id: `cron-job-${++cronAddCount}`,
    ...job,
    delivery: job.delivery,
  }));
  const cronUpdate = vi.fn(async () => undefined);
  const cronStorePath = path.join(os.tmpdir(), `monitor-handler-cron-${Date.now()}`, "cron.json");
  return {
    respond,
    cronAdd,
    cronUpdate,
    cronStorePath,
  };
}

async function invokeMonitorCreate(
  invokeContext: ReturnType<typeof createInvokeContext>,
  params: Record<string, unknown>,
  requestId: string,
) {
  await monitorHandlers["monitor.create"]({
    params,
    respond: invokeContext.respond as never,
    context: {
      cronStorePath: invokeContext.cronStorePath,
      cron: {
        add: invokeContext.cronAdd,
        update: invokeContext.cronUpdate,
      },
    } as never,
    client: null,
    req: { type: "req", id: requestId, method: "monitor.create" },
    isWebchatConnect: () => false,
  });
}

describe("monitor gateway handlers", () => {
  beforeEach(() => {
    seedMonitorSessionMock.mockClear();
  });

  it("creates a durable monitor record and schedules monitorWake on the monitor session", async () => {
    const { respond, cronAdd, cronUpdate, cronStorePath } = createInvokeContext();

    await monitorHandlers["monitor.create"]({
      params: {
        instructions: "Monitor Empower replies and draft the next response.",
        agentId: "main",
        originSessionKey: "agent:main:telegram:direct:user-1",
        originDelivery: { mode: "announce", channel: "telegram", to: "user-1" },
        sourceType: "gmail",
        sourceTarget: { account: "me@example.com", threadId: "thread-1" },
        cadence: { kind: "every", everyMs: 300_000 },
        goal: { id: "goal-1", objective: "Get the refund confirmed." },
      },
      respond: respond as never,
      context: {
        cronStorePath,
        cron: {
          add: cronAdd,
          update: cronUpdate,
        },
      } as never,
      client: null,
      req: { type: "req", id: "req-1", method: "monitor.create" },
      isWebchatConnect: () => false,
    });

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    const monitor = call?.[1] as
      | {
          monitorId: string;
          monitorSessionKey: string;
          originSessionKey: string;
          actionPolicy: string;
          sourceType: string;
          cronJobId: string;
          goal?: { id: string; objective: string };
        }
      | undefined;
    expect(monitor).toMatchObject({
      monitorSessionKey: expect.stringMatching(/^agent:main:monitor:/),
      originSessionKey: "agent:main:telegram:direct:user-1",
      actionPolicy: "notify_draft",
      sourceType: "gmail",
      cronJobId: "cron-job-1",
      goal: { id: "goal-1", objective: "Get the refund confirmed." },
    });
    expect(cronAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionTarget: `session:${monitor?.monitorSessionKey}`,
        payload: {
          kind: "monitorWake",
          monitorId: monitor?.monitorId,
        },
        delivery: expect.objectContaining({
          mode: "announce",
          channel: "telegram",
          to: "user-1",
        }),
      }),
    );
    expect(seedMonitorSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: monitor?.monitorSessionKey,
        originSessionKey: "agent:main:telegram:direct:user-1",
        instructions: "Monitor Empower replies and draft the next response.",
        goal: { id: "goal-1", objective: "Get the refund confirmed." },
      }),
    );
    expect(cronUpdate).not.toHaveBeenCalled();
  });

  it("returns the existing active monitor for duplicate normalized create requests", async () => {
    const invokeContext = createInvokeContext();
    const baseParams = {
      instructions: "Watch the customer thread and draft a response.",
      agentId: "main",
      name: "Customer reply",
      originSessionKey: "agent:main:telegram:direct:user-1",
      sourceType: "gmail",
      cadence: { kind: "every", everyMs: 300_000 },
      actionPolicy: "notify_draft",
    };

    await invokeMonitorCreate(
      invokeContext,
      {
        ...baseParams,
        sourceTarget: { threadId: "thread-1", account: "me@example.com" },
      },
      "req-dedupe-1",
    );
    await invokeMonitorCreate(
      invokeContext,
      {
        ...baseParams,
        sourceTarget: { account: "me@example.com", threadId: "thread-1" },
      },
      "req-dedupe-2",
    );

    const firstMonitor = invokeContext.respond.mock.calls[0]?.[1] as
      | { monitorId: string; cronJobId: string }
      | undefined;
    const secondMonitor = invokeContext.respond.mock.calls[1]?.[1] as
      | { monitorId: string; cronJobId: string }
      | undefined;
    expect(firstMonitor?.monitorId).toBeTruthy();
    expect(secondMonitor).toEqual(firstMonitor);
    expect(invokeContext.cronAdd).toHaveBeenCalledTimes(1);
    expect(seedMonitorSessionMock).toHaveBeenCalledTimes(1);
  });

  it("creates a new monitor when the action policy differs", async () => {
    const invokeContext = createInvokeContext();
    const baseParams = {
      instructions: "Watch the customer thread.",
      agentId: "main",
      name: "Customer reply",
      originSessionKey: "agent:main:telegram:direct:user-1",
      sourceType: "gmail",
      sourceTarget: { account: "me@example.com", threadId: "thread-1" },
      cadence: { kind: "every", everyMs: 300_000 },
    };

    await invokeMonitorCreate(
      invokeContext,
      { ...baseParams, actionPolicy: "notify_draft" },
      "req-policy-1",
    );
    await invokeMonitorCreate(
      invokeContext,
      { ...baseParams, actionPolicy: "notify_only" },
      "req-policy-2",
    );

    const firstMonitor = invokeContext.respond.mock.calls[0]?.[1] as
      | { monitorId: string }
      | undefined;
    const secondMonitor = invokeContext.respond.mock.calls[1]?.[1] as
      | { monitorId: string }
      | undefined;
    expect(secondMonitor?.monitorId).not.toBe(firstMonitor?.monitorId);
    expect(invokeContext.cronAdd).toHaveBeenCalledTimes(2);
    expect(seedMonitorSessionMock).toHaveBeenCalledTimes(2);
  });

  it("creates a new monitor when the purpose label differs", async () => {
    const invokeContext = createInvokeContext();
    const baseParams = {
      instructions: "Watch the customer thread.",
      agentId: "main",
      originSessionKey: "agent:main:telegram:direct:user-1",
      sourceType: "gmail",
      sourceTarget: { account: "me@example.com", threadId: "thread-1" },
      cadence: { kind: "every", everyMs: 300_000 },
      actionPolicy: "notify_draft",
    };

    await invokeMonitorCreate(
      invokeContext,
      { ...baseParams, name: "Customer reply" },
      "req-purpose-1",
    );
    await invokeMonitorCreate(
      invokeContext,
      { ...baseParams, name: "Escalation watch" },
      "req-purpose-2",
    );

    const firstMonitor = invokeContext.respond.mock.calls[0]?.[1] as
      | { monitorId: string }
      | undefined;
    const secondMonitor = invokeContext.respond.mock.calls[1]?.[1] as
      | { monitorId: string }
      | undefined;
    expect(secondMonitor?.monitorId).not.toBe(firstMonitor?.monitorId);
    expect(invokeContext.cronAdd).toHaveBeenCalledTimes(2);
    expect(seedMonitorSessionMock).toHaveBeenCalledTimes(2);
  });

  it("does not manufacture channel delivery for CLI-origin monitors", async () => {
    const { respond, cronAdd, cronUpdate, cronStorePath } = createInvokeContext();

    await monitorHandlers["monitor.create"]({
      params: {
        instructions: "Monitor Empower replies and draft the next response.",
        agentId: "main",
        originSessionKey: "agent:main:main",
        sourceType: "gmail",
        sourceTarget: { account: "me@example.com", threadId: "thread-cli" },
        cadence: { kind: "every", everyMs: 300_000 },
      },
      respond: respond as never,
      context: {
        cronStorePath,
        cron: {
          add: cronAdd,
          update: cronUpdate,
        },
      } as never,
      client: null,
      req: { type: "req", id: "req-cli", method: "monitor.create" },
      isWebchatConnect: () => false,
    });

    expect(cronAdd).toHaveBeenCalledWith(
      expect.not.objectContaining({
        delivery: expect.anything(),
      }),
    );
    const call = respond.mock.calls[0] as RespondCall | undefined;
    const monitor = call?.[1] as { originDelivery?: unknown } | undefined;
    expect(monitor?.originDelivery).toBeUndefined();
  });

  it("preserves telegram topic routing when creating monitor delivery", async () => {
    const { respond, cronAdd, cronUpdate, cronStorePath } = createInvokeContext();

    await monitorHandlers["monitor.create"]({
      params: {
        instructions: "Watch this Telegram topic for replies.",
        agentId: "main",
        originSessionKey: "agent:main:telegram:group:-1001234567890:topic:99",
        originDelivery: {
          mode: "announce",
          channel: "telegram",
          to: "-1001234567890:topic:99",
          accountId: "default",
        },
        sourceType: "gmail",
        sourceTarget: { account: "me@example.com", threadId: "thread-topic" },
        cadence: { kind: "every", everyMs: 300_000 },
      },
      respond: respond as never,
      context: {
        cronStorePath,
        cron: {
          add: cronAdd,
          update: cronUpdate,
        },
      } as never,
      client: null,
      req: { type: "req", id: "req-topic", method: "monitor.create" },
      isWebchatConnect: () => false,
    });

    expect(cronAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery: expect.objectContaining({
          mode: "announce",
          channel: "telegram",
          to: "-1001234567890:topic:99",
          accountId: "default",
        }),
      }),
    );
  });

  it("derives telegram topic routing from the origin session key when the stored delivery is bare", async () => {
    const { respond, cronAdd, cronUpdate, cronStorePath } = createInvokeContext();

    await monitorHandlers["monitor.create"]({
      params: {
        instructions: "Watch this Telegram topic for replies.",
        agentId: "main",
        originSessionKey: "agent:main:telegram:group:-1001234567890:topic:99",
        originDelivery: {
          mode: "announce",
          channel: "telegram",
          to: "telegram:-1001234567890",
          accountId: "default",
        },
        sourceType: "gmail",
        sourceTarget: { account: "me@example.com", threadId: "thread-topic" },
        cadence: { kind: "every", everyMs: 300_000 },
      },
      respond: respond as never,
      context: {
        cronStorePath,
        cron: {
          add: cronAdd,
          update: cronUpdate,
        },
      } as never,
      client: null,
      req: { type: "req", id: "req-topic-bare", method: "monitor.create" },
      isWebchatConnect: () => false,
    });

    expect(cronAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery: expect.objectContaining({
          mode: "announce",
          channel: "telegram",
          to: "telegram:-1001234567890:topic:99",
          accountId: "default",
        }),
      }),
    );
  });

  it("resolves watched-surface delivery for auto_send channel monitors", async () => {
    const { respond, cronAdd, cronUpdate, cronStorePath } = createInvokeContext();

    await monitorHandlers["monitor.create"]({
      params: {
        instructions: "Watch this WhatsApp thread and reply directly when needed.",
        agentId: "main",
        originSessionKey: "agent:main:main",
        sourceType: "whatsapp",
        sourceTarget: { target: "74333133234289@lid", accountId: "default" },
        cadence: { kind: "every", everyMs: 300_000 },
        actionPolicy: "auto_send",
      },
      respond: respond as never,
      context: {
        cronStorePath,
        cron: {
          add: cronAdd,
          update: cronUpdate,
        },
      } as never,
      client: null,
      req: { type: "req", id: "req-auto-send", method: "monitor.create" },
      isWebchatConnect: () => false,
    });

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    const monitor = call?.[1] as { watchDelivery?: unknown } | undefined;
    expect(monitor?.watchDelivery).toEqual({
      mode: "announce",
      channel: "whatsapp",
      to: "74333133234289@lid",
      accountId: "default",
    });
  });

  it("rejects invalid monitor.create params", async () => {
    const { respond, cronAdd, cronUpdate, cronStorePath } = createInvokeContext();

    await monitorHandlers["monitor.create"]({
      params: {
        agentId: "main",
      },
      respond: respond as never,
      context: {
        cronStorePath,
        cron: {
          add: cronAdd,
          update: cronUpdate,
        },
      } as never,
      client: null,
      req: { type: "req", id: "req-2", method: "monitor.create" },
      isWebchatConnect: () => false,
    });

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("invalid monitor.create params");
  });

  it("does not disable cron when the agent marks a monitor completed", async () => {
    const { respond, cronAdd, cronUpdate, cronStorePath } = createInvokeContext();
    const storeDir = path.dirname(cronStorePath);
    await fs.mkdir(storeDir, { recursive: true });
    await fs.writeFile(
      path.join(storeDir, "monitors.json"),
      JSON.stringify({
        version: 1,
        monitors: [
          {
            monitorId: "monitor-1",
            agentId: "main",
            originSessionKey: "agent:main:main",
            monitorSessionKey: "agent:main:monitor:monitor-1",
            sourceType: "gmail",
            sourceTarget: { account: "me@example.com", threadId: "thread-1" },
            cadence: { kind: "every", everyMs: 300_000 },
            actionPolicy: "notify_draft",
            status: "active",
            cronJobId: "cron-job-1",
            createdAtMs: 1,
            updatedAtMs: 1,
          },
        ],
      }),
      "utf-8",
    );

    await monitorHandlers["monitor.update"]({
      params: {
        monitorId: "monitor-1",
        patch: {
          status: "completed",
        },
      },
      respond: respond as never,
      context: {
        cronStorePath,
        cron: {
          add: cronAdd,
          update: cronUpdate,
        },
      } as never,
      client: null,
      req: { type: "req", id: "req-update", method: "monitor.update" },
      isWebchatConnect: () => false,
    });

    expect(cronUpdate).not.toHaveBeenCalled();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect((call?.[1] as { status?: string } | undefined)?.status).toBe("completed");
  });
});
