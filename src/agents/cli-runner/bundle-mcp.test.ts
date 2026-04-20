import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { clearPluginManifestRegistryCache } from "../../plugins/manifest-registry.js";
import { captureEnv } from "../../test-utils/env.js";
import { prepareCliBundleMcpConfig } from "./bundle-mcp.js";
import { __testing as nativeMcpTesting } from "./native-mcp.js";

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  clearPluginManifestRegistryCache();
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("prepareCliBundleMcpConfig", () => {
  it.each(["claude-cli", "claude-bridge"])(
    "injects a merged --mcp-config overlay for %s",
    async (backendId) => {
      const env = captureEnv(["HOME"]);
      try {
        const homeDir = await createTempDir("openclaw-cli-bundle-mcp-home-");
        const workspaceDir = await createTempDir("openclaw-cli-bundle-mcp-workspace-");
        process.env.HOME = homeDir;

        const pluginRoot = path.join(homeDir, ".openclaw", "extensions", "bundle-probe");
        const serverPath = path.join(pluginRoot, "servers", "probe.mjs");
        await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
        await fs.mkdir(path.dirname(serverPath), { recursive: true });
        await fs.writeFile(serverPath, "export {};\n", "utf-8");
        await fs.writeFile(
          path.join(pluginRoot, ".claude-plugin", "plugin.json"),
          `${JSON.stringify({ name: "bundle-probe" }, null, 2)}\n`,
          "utf-8",
        );
        await fs.writeFile(
          path.join(pluginRoot, ".mcp.json"),
          `${JSON.stringify(
            {
              mcpServers: {
                bundleProbe: {
                  command: "node",
                  args: ["./servers/probe.mjs"],
                },
              },
            },
            null,
            2,
          )}\n`,
          "utf-8",
        );

        const config: OpenClawConfig = {
          plugins: {
            entries: {
              "bundle-probe": { enabled: true },
            },
          },
        };

        const prepared = await prepareCliBundleMcpConfig({
          backendId,
          backend: {
            command: "node",
            args: ["./fake-claude.mjs"],
          },
          workspaceDir,
          config,
        });

        const configFlagIndex = prepared.backend.args?.indexOf("--mcp-config") ?? -1;
        expect(configFlagIndex).toBeGreaterThanOrEqual(0);
        expect(prepared.backend.args).toContain("--strict-mcp-config");
        const generatedConfigPath = prepared.backend.args?.[configFlagIndex + 1];
        expect(typeof generatedConfigPath).toBe("string");
        const raw = JSON.parse(await fs.readFile(generatedConfigPath as string, "utf-8")) as {
          mcpServers?: Record<string, { args?: string[]; env?: Record<string, string> }>;
        };
        expect(raw.mcpServers?.bundleProbe?.args).toEqual([await fs.realpath(serverPath)]);
        if (backendId === "claude-bridge") {
          expect(raw.mcpServers?.openclawNativeTools?.args).toEqual([
            "--import",
            "tsx",
            expect.stringMatching(/native-mcp-server\.ts$/),
          ]);
          expect(raw.mcpServers?.openclawNativeTools?.cwd).toBe(
            nativeMcpTesting.resolveNativeOpenClawRepoRoot(),
          );
          expect(raw.mcpServers?.openclawNativeTools?.env).toEqual(
            expect.objectContaining({
              OPENCLAW_CONFIG_PATH: expect.stringMatching(/openclaw-native-mcp\.config\.json$/),
              OPENCLAW_NATIVE_MCP_WORKSPACE_DIR: workspaceDir,
            }),
          );
        } else {
          expect(raw.mcpServers?.openclawNativeTools).toBeUndefined();
        }

        await prepared.cleanup?.();
      } finally {
        env.restore();
      }
    },
  );

  it("injects the native OpenClaw MCP server for claude-bridge even without bundle overlays", async () => {
    const workspaceDir = await createTempDir("openclaw-cli-native-mcp-workspace-");

    const prepared = await prepareCliBundleMcpConfig({
      backendId: "claude-bridge",
      backend: {
        command: "node",
        args: ["./fake-claude.mjs"],
      },
      workspaceDir,
    });

    const configFlagIndex = prepared.backend.args?.indexOf("--mcp-config") ?? -1;
    expect(configFlagIndex).toBeGreaterThanOrEqual(0);
    const generatedConfigPath = prepared.backend.args?.[configFlagIndex + 1];
    const raw = JSON.parse(await fs.readFile(generatedConfigPath as string, "utf-8")) as {
      mcpServers?: Record<string, { command?: string; env?: Record<string, string> }>;
    };

    expect(raw.mcpServers?.openclawNativeTools?.command).toBe(process.execPath);
    expect(raw.mcpServers?.openclawNativeTools?.env).toEqual(
      expect.objectContaining({
        OPENCLAW_NATIVE_MCP_WORKSPACE_DIR: workspaceDir,
      }),
    );

    await prepared.cleanup?.();
  });
});
