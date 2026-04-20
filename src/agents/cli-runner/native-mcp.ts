import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawConfig } from "../../config/config.js";
import type { BundleMcpServerConfig } from "../../plugins/bundle-mcp.js";

export const OPENCLAW_NATIVE_MCP_SERVER_KEY = "openclawNativeTools";
export const OPENCLAW_NATIVE_MCP_CONFIG_ENV = "OPENCLAW_CONFIG_PATH";
export const OPENCLAW_NATIVE_MCP_WORKSPACE_ENV = "OPENCLAW_NATIVE_MCP_WORKSPACE_DIR";
export const OPENCLAW_NATIVE_MCP_SESSION_KEY_ENV = "OPENCLAW_NATIVE_MCP_SESSION_KEY";
export const OPENCLAW_NATIVE_MCP_AGENT_ID_ENV = "OPENCLAW_NATIVE_MCP_AGENT_ID";
export const OPENCLAW_NATIVE_MCP_BROWSER_BASE_URL_ENV = "OPENCLAW_NATIVE_MCP_BROWSER_BASE_URL";

function resolveNativeOpenClawRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

function resolveNativeOpenClawMcpEntryPath(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const builtPath = path.join(moduleDir, "native-mcp-server.js");
  if (fs.existsSync(builtPath)) {
    return builtPath;
  }
  return path.join(moduleDir, "native-mcp-server.ts");
}

export async function createNativeOpenClawMcpServerConfig(params: {
  tempDir: string;
  workspaceDir: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
}): Promise<BundleMcpServerConfig> {
  const entryPath = resolveNativeOpenClawMcpEntryPath();
  const env: Record<string, string> = {
    [OPENCLAW_NATIVE_MCP_WORKSPACE_ENV]: params.workspaceDir,
  };

  if (params.sessionKey?.trim()) {
    env[OPENCLAW_NATIVE_MCP_SESSION_KEY_ENV] = params.sessionKey.trim();
  }
  if (params.agentId?.trim()) {
    env[OPENCLAW_NATIVE_MCP_AGENT_ID_ENV] = params.agentId.trim();
  }
  const browserBaseUrl = process.env[OPENCLAW_NATIVE_MCP_BROWSER_BASE_URL_ENV]?.trim();
  if (browserBaseUrl) {
    env[OPENCLAW_NATIVE_MCP_BROWSER_BASE_URL_ENV] = browserBaseUrl;
  }
  if (params.config) {
    const configPath = path.join(params.tempDir, "openclaw-native-mcp.config.json");
    await fsPromises.writeFile(configPath, `${JSON.stringify(params.config, null, 2)}\n`, "utf-8");
    env[OPENCLAW_NATIVE_MCP_CONFIG_ENV] = configPath;
  }

  return {
    command: process.execPath,
    args: path.extname(entryPath) === ".ts" ? ["--import", "tsx", entryPath] : [entryPath],
    // Source-tree runs need repo-root cwd so `node --import tsx ...` resolves
    // the installed loader from this checkout rather than the target workspace.
    cwd: resolveNativeOpenClawRepoRoot(),
    env,
  };
}

export const __testing = {
  resolveNativeOpenClawRepoRoot,
  resolveNativeOpenClawMcpEntryPath,
} as const;
