import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

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
  };
}

describe("gateway tool resolution", () => {
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
    expect(result.tools.map((tool) => tool.name)).not.toContain("exec");
  });
});
