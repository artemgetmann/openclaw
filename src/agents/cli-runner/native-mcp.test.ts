import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  __testing,
  createNativeOpenClawMcpServerConfig,
  OPENCLAW_NATIVE_MCP_AGENT_ID_ENV,
  OPENCLAW_NATIVE_MCP_CONFIG_ENV,
  OPENCLAW_NATIVE_MCP_SESSION_KEY_ENV,
  OPENCLAW_NATIVE_MCP_WORKSPACE_ENV,
} from "./native-mcp.js";

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("createNativeOpenClawMcpServerConfig", () => {
  it("writes the injected runtime payload and points the stdio server at the repo-root launcher", async () => {
    const tempDir = await createTempDir("openclaw-native-mcp-helper-");
    const workspaceDir = path.join(tempDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    const config: OpenClawConfig = {
      tools: {
        exec: {
          host: "gateway",
          security: "full",
          ask: "off",
        },
      },
    };

    const serverConfig = (await createNativeOpenClawMcpServerConfig({
      tempDir,
      workspaceDir,
      config,
      sessionKey: "session:bridge",
      agentId: "bridge-agent",
    })) as {
      command?: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
    };

    expect(serverConfig.command).toBe(process.execPath);
    expect(serverConfig.cwd).toBe(__testing.resolveNativeOpenClawRepoRoot());
    expect(serverConfig.args?.at(-1)).toMatch(/native-mcp-server\.(?:ts|js)$/);
    expect(serverConfig.env).toEqual(
      expect.objectContaining({
        [OPENCLAW_NATIVE_MCP_WORKSPACE_ENV]: workspaceDir,
        [OPENCLAW_NATIVE_MCP_SESSION_KEY_ENV]: "session:bridge",
        [OPENCLAW_NATIVE_MCP_AGENT_ID_ENV]: "bridge-agent",
        [OPENCLAW_NATIVE_MCP_CONFIG_ENV]: expect.stringMatching(
          /openclaw-native-mcp\.config\.json$/,
        ),
      }),
    );

    const writtenConfigPath = serverConfig.env?.[OPENCLAW_NATIVE_MCP_CONFIG_ENV];
    expect(writtenConfigPath).toBeTruthy();
    await expect(fs.readFile(writtenConfigPath as string, "utf-8")).resolves.toContain(
      '"host": "gateway"',
    );
  });
});
