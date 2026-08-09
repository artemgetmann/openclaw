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
      mode: "run",
      requester: { channel: "telegram", to: "-1001", accountId: "jarvis", threadId: "42" },
    });
    expect(presence.start).toHaveBeenCalledWith({
      ownerId: "subagent:run-1",
      to: "-1001",
      accountId: "jarvis",
      messageThreadId: 42,
    });

    for (const outcome of ["ok", "error", "timeout", "killed", "reset", "deleted"]) {
      await handlers.get("subagent_ended")?.({ runId: `run-${outcome}`, outcome });
    }
    expect(presence.stop).toHaveBeenCalledTimes(6);
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
});
