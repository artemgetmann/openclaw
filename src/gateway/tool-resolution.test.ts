import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const { getGlobalPluginRegistryMock, loadOpenClawPluginsMock } = vi.hoisted(() => ({
  getGlobalPluginRegistryMock: vi.fn(),
  loadOpenClawPluginsMock: vi.fn(),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalPluginRegistry: () => getGlobalPluginRegistryMock(),
}));

vi.mock("../plugins/loader.js", () => ({
  loadOpenClawPlugins: (params: unknown) => loadOpenClawPluginsMock(params),
}));

import {
  resolveGatewayGuiPermissionDefaults,
  resolveGatewayScopedTools,
} from "./tool-resolution.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-loopback-tools-"));
  tempDirs.push(dir);
  return dir;
}

function createConfig(workspaceDir: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: workspaceDir,
        memorySearch: {
          provider: "none",
          fallback: "none",
          store: {
            path: path.join(workspaceDir, ".openclaw-smoke-memory.sqlite"),
            vector: { enabled: false },
          },
          sync: {
            onSessionStart: false,
            onSearch: false,
            watch: false,
          },
        },
      },
      list: [
        {
          id: "main",
          default: true,
          workspace: workspaceDir,
          agentDir: path.join(workspaceDir, ".openclaw-smoke-agent-main"),
        },
        {
          id: "claude-cli-continuity",
          workspace: workspaceDir,
          agentDir: path.join(workspaceDir, ".openclaw-smoke-agent-claude-cli-continuity"),
        },
      ],
    },
    plugins: {
      enabled: true,
      load: { paths: [path.join(workspaceDir, "plugin.js")] },
    },
  };
}

describe("gateway tool resolution", () => {
  beforeEach(() => {
    getGlobalPluginRegistryMock.mockReset().mockReturnValue(null);
    loadOpenClawPluginsMock.mockReset().mockImplementation(() => {
      throw new Error("plugin discovery should not run during loopback tool resolution");
    });
  });

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("resolves loopback core tools without plugin discovery for temp workspaces", async () => {
    const workspaceDir = await createTempWorkspace();
    const result = resolveGatewayScopedTools({
      cfg: createConfig(workspaceDir),
      sessionKey: "agent:claude-cli-continuity:test",
      surface: "loopback",
      excludeToolNames: ["read", "write", "edit", "apply_patch", "exec", "process"],
      senderIsOwner: false,
    });

    expect(result.tools.map((tool) => tool.name)).toContain("sessions_list");
    expect(result.tools.map((tool) => tool.name)).toContain("memory_search");
    expect(result.tools.map((tool) => tool.name)).toContain("gui_control");
    expect(result.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("does not expose GUI control outside the loopback Codex/MCP surface", async () => {
    const workspaceDir = await createTempWorkspace();
    loadOpenClawPluginsMock.mockReturnValueOnce({ tools: [], diagnostics: [] });
    const result = resolveGatewayScopedTools({
      cfg: createConfig(workspaceDir),
      sessionKey: "agent:claude-cli-continuity:test",
      surface: "http",
      senderIsOwner: true,
    });

    expect(result.tools.map((tool) => tool.name)).not.toContain("gui_control");
  });

  it("resolves fresh session GUI permissions ahead of full global defaults", async () => {
    const workspaceDir = await createTempWorkspace();
    const storePath = path.join(workspaceDir, "sessions.json");
    const sessionKey = "agent:main:telegram:direct:user-1";
    const cfg: OpenClawConfig = {
      ...createConfig(workspaceDir),
      session: { store: storePath },
      tools: { exec: { security: "full", ask: "off" } },
    };
    await fs.writeFile(
      storePath,
      JSON.stringify({
        [sessionKey]: {
          sessionId: "permission-test",
          updatedAt: Date.now(),
          execSecurity: "allowlist",
          execAsk: "on-miss",
        },
      }),
    );

    expect(resolveGatewayGuiPermissionDefaults({ cfg, sessionKey, agentId: "main" })).toEqual({
      execSecurity: "allowlist",
      execAsk: "on-miss",
    });
  });

  it("resolves loopback plugin tools from an initialized global registry", async () => {
    const workspaceDir = await createTempWorkspace();
    getGlobalPluginRegistryMock.mockReturnValue({
      tools: [
        {
          pluginId: "loopback-demo",
          optional: false,
          source: path.join(workspaceDir, "plugin.js"),
          factory: () => ({
            name: "loopback_demo",
            description: "Preloaded loopback demo tool",
            parameters: { type: "object", properties: {} },
            async execute() {
              return { content: [{ type: "text", text: "ok" }] };
            },
          }),
        },
      ],
      diagnostics: [],
    });

    const result = resolveGatewayScopedTools({
      cfg: createConfig(workspaceDir),
      sessionKey: "agent:claude-cli-continuity:test",
      surface: "loopback",
      senderIsOwner: false,
    });

    expect(result.tools.map((tool) => tool.name)).toContain("loopback_demo");
    expect(result.tools.map((tool) => tool.name)).toContain("memory_search");
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("omits goal tools for loopback monitor sessions without a bound goal", async () => {
    const workspaceDir = await createTempWorkspace();
    const cronStore = path.join(workspaceDir, "cron", "jobs.json");
    const monitorStore = path.join(path.dirname(cronStore), "monitors.json");
    await fs.mkdir(path.dirname(monitorStore), { recursive: true });
    await fs.writeFile(
      monitorStore,
      JSON.stringify({
        version: 1,
        monitors: [
          {
            monitorId: "monitor-no-goal",
            agentId: "main",
            originSessionKey: "agent:main:telegram:direct:user-1",
            monitorSessionKey: "agent:main:monitor:monitor-no-goal",
            sourceType: "whatsapp",
            sourceTarget: { target: "12345@lid" },
            cadence: { kind: "every", everyMs: 300_000 },
            actionPolicy: "notify_draft",
            status: "active",
            cronJobId: "cron-monitor-no-goal",
            createdAtMs: 1,
            updatedAtMs: 1,
          },
        ],
      }),
      "utf-8",
    );

    const result = resolveGatewayScopedTools({
      cfg: {
        ...createConfig(workspaceDir),
        cron: { store: cronStore },
      },
      sessionKey: "agent:main:monitor:monitor-no-goal",
      surface: "loopback",
      senderIsOwner: true,
    });
    const toolNames = result.tools.map((tool) => tool.name);

    expect(toolNames).not.toContain("get_goal");
    expect(toolNames).not.toContain("create_goal");
    expect(toolNames).not.toContain("update_goal");
    expect(toolNames).toContain("monitor");
  });
});
