import type { OpenClawPluginApi } from "openclaw/plugin-sdk/telegram";
import { describe, expect, it, vi } from "vitest";
import { registerTelegramSubagentWorkingPresence } from "./subagent-working-presence.js";

describe("Telegram subagent working presence", () => {
  it("routes a topic start and cleans up every terminal outcome", async () => {
    const handlers = new Map<string, (event: any) => unknown>();
    const presence = { start: vi.fn(async () => undefined), stop: vi.fn(), stopAll: vi.fn() };
    const api = {
      runtime: { channel: { telegram: { workingPresence: presence } } },
      on: vi.fn((name: string, handler: (event: any) => unknown) => handlers.set(name, handler)),
    } as unknown as OpenClawPluginApi;
    registerTelegramSubagentWorkingPresence(api);

    await handlers.get("subagent_spawned")?.({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:child-1",
      mode: "run",
      requester: { channel: "telegram", to: "-1001", accountId: "jarvis", threadId: "42" },
    });
    expect(presence.start).toHaveBeenCalledWith({
      ownerId: "subagent:run-1",
      to: "-1001",
      accountId: "jarvis",
      messageThreadId: 42,
    });

    await handlers.get("subagent_ended")?.({
      runId: "run-1",
      targetSessionKey: "agent:main:subagent:child-1",
      outcome: "ok",
    });

    for (const outcome of ["reset", "deleted"] as const) {
      const runId = `run-${outcome}`;
      const childSessionKey = `agent:main:subagent:child-${outcome}`;
      await handlers.get("subagent_spawned")?.({
        runId,
        childSessionKey,
        mode: "run",
        requester: { channel: "telegram", to: "-1001" },
      });
      // Match the production reset/delete event shape: target session only,
      // without the runId that ordinary completion events carry.
      await handlers.get("subagent_ended")?.({ targetSessionKey: childSessionKey, outcome });
    }
    expect(presence.stop).toHaveBeenNthCalledWith(1, "subagent:run-1");
    expect(presence.stop).toHaveBeenNthCalledWith(2, "subagent:run-reset");
    expect(presence.stop).toHaveBeenNthCalledWith(3, "subagent:run-deleted");
  });

  it("ignores non-Telegram routes and clears leases on gateway stop", async () => {
    const handlers = new Map<string, (event: any) => unknown>();
    const presence = { start: vi.fn(), stop: vi.fn(), stopAll: vi.fn() };
    const api = {
      runtime: { channel: { telegram: { workingPresence: presence } } },
      on: vi.fn((name: string, handler: (event: any) => unknown) => handlers.set(name, handler)),
    } as unknown as OpenClawPluginApi;
    registerTelegramSubagentWorkingPresence(api);

    await handlers.get("subagent_spawned")?.({
      runId: "run-1",
      mode: "run",
      requester: { channel: "discord", to: "room" },
    });
    expect(presence.start).not.toHaveBeenCalled();
    await handlers.get("subagent_spawned")?.({
      runId: "persistent",
      mode: "session",
      requester: { channel: "telegram", to: "-1001" },
    });
    expect(presence.start).not.toHaveBeenCalled();
    await handlers.get("gateway_stop")?.({});
    expect(presence.stopAll).toHaveBeenCalledTimes(1);
  });

  it("releases the original lease when steering replaces the terminal run id", async () => {
    const handlers = new Map<string, (event: any) => unknown>();
    const presence = { start: vi.fn(async () => undefined), stop: vi.fn(), stopAll: vi.fn() };
    const api = {
      runtime: { channel: { telegram: { workingPresence: presence } } },
      on: vi.fn((name: string, handler: (event: any) => unknown) => handlers.set(name, handler)),
    } as unknown as OpenClawPluginApi;
    registerTelegramSubagentWorkingPresence(api);

    const childSessionKey = "agent:main:subagent:steered-child";
    await handlers.get("subagent_spawned")?.({
      runId: "run-before-steer",
      childSessionKey,
      mode: "run",
      requester: { channel: "telegram", to: "-1001" },
    });
    await handlers.get("subagent_ended")?.({
      runId: "run-after-steer",
      targetSessionKey: childSessionKey,
      outcome: "ok",
    });

    expect(presence.stop).toHaveBeenCalledWith("subagent:run-before-steer");
    expect(presence.stop).toHaveBeenCalledWith("subagent:run-after-steer");
  });

  it("does not block worker acceptance on an unresolved Telegram request", () => {
    const handlers = new Map<string, (event: any) => unknown>();
    const presence = {
      start: vi.fn(() => new Promise<void>(() => undefined)),
      stop: vi.fn(),
      stopAll: vi.fn(),
    };
    const api = {
      logger: { warn: vi.fn() },
      runtime: { channel: { telegram: { workingPresence: presence } } },
      on: vi.fn((name: string, handler: (event: any) => unknown) => handlers.set(name, handler)),
    } as unknown as OpenClawPluginApi;
    registerTelegramSubagentWorkingPresence(api);

    const result = handlers.get("subagent_spawned")?.({
      runId: "run-pending",
      mode: "run",
      requester: { channel: "telegram", to: "-1001" },
    });

    expect(result).toBeUndefined();
    expect(presence.start).toHaveBeenCalledTimes(1);
  });
});
