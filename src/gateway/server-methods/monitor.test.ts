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
  const cronAdd = vi.fn(async (job: Record<string, unknown>) => ({
    id: "cron-job-1",
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
        }
      | undefined;
    expect(monitor).toMatchObject({
      monitorSessionKey: expect.stringMatching(/^monitor:/),
      originSessionKey: "agent:main:telegram:direct:user-1",
      actionPolicy: "notify_draft",
      sourceType: "gmail",
      cronJobId: "cron-job-1",
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
      }),
    );
    expect(cronUpdate).not.toHaveBeenCalled();
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
});
