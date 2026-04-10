import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import { SsrFBlockedError } from "../infra/net/ssrf.js";

const {
  enqueueSystemEventMock,
  requestHeartbeatNowMock,
  loadConfigMock,
  fetchWithSsrFGuardMock,
  runCronIsolatedAgentTurnMock,
} = vi.hoisted(() => ({
  enqueueSystemEventMock: vi.fn(),
  requestHeartbeatNowMock: vi.fn(),
  loadConfigMock: vi.fn(),
  fetchWithSsrFGuardMock: vi.fn(),
  runCronIsolatedAgentTurnMock: vi.fn(async () => ({ status: "ok" as const, summary: "ok" })),
}));

function enqueueSystemEvent(...args: unknown[]) {
  return enqueueSystemEventMock(...args);
}

function requestHeartbeatNow(...args: unknown[]) {
  return requestHeartbeatNowMock(...args);
}

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent,
}));

vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow,
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: () => loadConfigMock(),
  };
});

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: runCronIsolatedAgentTurnMock,
}));

import { buildGatewayCronService } from "./server-cron.js";

function createCronConfig(name: string): OpenClawConfig {
  const tmpDir = path.join(os.tmpdir(), `${name}-${Date.now()}`);
  return {
    session: {
      mainKey: "main",
    },
    cron: {
      store: path.join(tmpDir, "cron.json"),
    },
  } as OpenClawConfig;
}

describe("buildGatewayCronService", () => {
  beforeEach(() => {
    enqueueSystemEventMock.mockClear();
    requestHeartbeatNowMock.mockClear();
    loadConfigMock.mockClear();
    fetchWithSsrFGuardMock.mockClear();
    runCronIsolatedAgentTurnMock.mockClear();
  });

  it("routes main-target jobs to the scoped session for enqueue + wake", async () => {
    const cfg = createCronConfig("server-cron");
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "canonicalize-session-key",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        sessionKey: "discord:channel:ops",
        payload: { kind: "systemEvent", text: "hello" },
      });

      await state.cron.run(job.id, "force");

      expect(enqueueSystemEventMock).toHaveBeenCalledWith(
        "hello",
        expect.objectContaining({
          sessionKey: "agent:main:discord:channel:ops",
        }),
      );
      expect(requestHeartbeatNowMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:discord:channel:ops",
        }),
      );
    } finally {
      state.cron.stop();
    }
  });

  it("blocks private webhook URLs via SSRF-guarded fetch", async () => {
    const cfg = createCronConfig("server-cron-ssrf");
    loadConfigMock.mockReturnValue(cfg);
    fetchWithSsrFGuardMock.mockRejectedValue(
      new SsrFBlockedError("Blocked: resolves to private/internal/special-use IP address"),
    );

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "ssrf-webhook-blocked",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
        delivery: {
          mode: "webhook",
          to: "http://127.0.0.1:8080/cron-finished",
        },
      });

      await state.cron.run(job.id, "force");

      expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
        url: "http://127.0.0.1:8080/cron-finished",
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: expect.stringContaining('"action":"finished"'),
          signal: expect.any(AbortSignal),
        },
      });
    } finally {
      state.cron.stop();
    }
  });

  it("passes custom session targets through to isolated cron runs", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-custom-session-${Date.now()}`);
    const cfg = {
      session: {
        mainKey: "main",
      },
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "custom-session",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "session:project-alpha-monitor",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "hello" },
      });

      await state.cron.run(job.id, "force");

      expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          job: expect.objectContaining({ id: job.id }),
          sessionKey: "project-alpha-monitor",
        }),
      );
    } finally {
      state.cron.stop();
    }
  });

  it("routes monitor wakes through the durable monitor session with manual reset semantics", async () => {
    const cfg = createCronConfig("server-cron-monitor");
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    const monitorStorePath = path.join(path.dirname(cfg.cron!.store!), "monitors.json");
    await fs.mkdir(path.dirname(monitorStorePath), { recursive: true });
    await fs.writeFile(
      monitorStorePath,
      JSON.stringify({
        version: 1,
        monitors: [
          {
            monitorId: "monitor-1",
            agentId: "main",
            originSessionKey: "agent:main:telegram:direct:user-1",
            originDelivery: { mode: "announce", channel: "telegram", to: "user-1" },
            monitorSessionKey: "agent:main:monitor:monitor-1",
            sourceType: "whatsapp",
            sourceTarget: { target: "+123" },
            cadence: { kind: "every", everyMs: 60_000 },
            actionPolicy: "notify_draft",
            status: "active",
            cronJobId: "cron-monitor-1",
            createdAtMs: 1,
            updatedAtMs: 1,
          },
        ],
      }),
      "utf-8",
    );

    try {
      const job = await state.cron.add({
        name: "monitor wake",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "session:agent:main:monitor:monitor-1",
        wakeMode: "next-heartbeat",
        payload: { kind: "monitorWake", monitorId: "monitor-1" },
      });

      await state.cron.run(job.id, "force");

      expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "main",
          sessionKey: "agent:main:monitor:monitor-1",
          sessionDefaultResetMode: "manual",
          job: expect.objectContaining({
            sessionTarget: "session:agent:main:monitor:monitor-1",
            delivery: expect.objectContaining({
              mode: "announce",
              channel: "telegram",
              to: "user-1",
            }),
          }),
          message: expect.stringContaining("sourceType: whatsapp"),
        }),
      );
    } finally {
      state.cron.stop();
    }
  });

  it("does not require channel delivery for CLI-origin monitor wakes", async () => {
    const cfg = createCronConfig("server-cron-monitor-cli");
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    const monitorStorePath = path.join(path.dirname(cfg.cron!.store!), "monitors.json");
    await fs.mkdir(path.dirname(monitorStorePath), { recursive: true });
    await fs.writeFile(
      monitorStorePath,
      JSON.stringify({
        version: 1,
        monitors: [
          {
            monitorId: "monitor-cli",
            agentId: "main",
            originSessionKey: "agent:main:main",
            monitorSessionKey: "agent:main:monitor:monitor-cli",
            sourceType: "gmail",
            sourceTarget: { account: "me@example.com", threadId: "thread-cli" },
            cadence: { kind: "every", everyMs: 60_000 },
            actionPolicy: "notify_draft",
            status: "active",
            cronJobId: "cron-monitor-cli",
            createdAtMs: 1,
            updatedAtMs: 1,
          },
        ],
      }),
      "utf-8",
    );

    try {
      const job = await state.cron.add({
        name: "monitor wake cli",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "session:agent:main:monitor:monitor-cli",
        wakeMode: "next-heartbeat",
        payload: { kind: "monitorWake", monitorId: "monitor-cli" },
      });

      await state.cron.run(job.id, "force");

      expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:monitor:monitor-cli",
          job: expect.not.objectContaining({
            delivery: expect.anything(),
          }),
        }),
      );
    } finally {
      state.cron.stop();
    }
  });
});
