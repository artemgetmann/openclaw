import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { OpenClawConfig } from "../../config/config.js";
import type { BundleMcpServerConfig } from "../../plugins/bundle-mcp.js";

export const OPENCLAW_NATIVE_MCP_SERVER_KEY = "openclawNativeTools";
export const OPENCLAW_NATIVE_MCP_CONFIG_ENV = "OPENCLAW_NATIVE_MCP_CONFIG_PATH";
export const OPENCLAW_NATIVE_MCP_WORKSPACE_ENV = "OPENCLAW_NATIVE_MCP_WORKSPACE_DIR";
export const OPENCLAW_NATIVE_MCP_SESSION_KEY_ENV = "OPENCLAW_NATIVE_MCP_SESSION_KEY";
export const OPENCLAW_NATIVE_MCP_AGENT_ID_ENV = "OPENCLAW_NATIVE_MCP_AGENT_ID";
export const OPENCLAW_NATIVE_MCP_BROWSER_BASE_URL_ENV = "OPENCLAW_NATIVE_MCP_BROWSER_BASE_URL";

function resolveNativeOpenClawRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

function resolveTsxLoaderPath(): string {
  return createRequire(import.meta.url).resolve("tsx");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function resolveNativeOpenClawMcpEntryPath(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const builtPath = path.join(moduleDir, "native-mcp-server.js");
  if (fs.existsSync(builtPath)) {
    return builtPath;
  }
  const repoBuiltPath = path.join(
    resolveNativeOpenClawRepoRoot(),
    "dist",
    "agents",
    "cli-runner",
    "native-mcp-server.js",
  );
  if (fs.existsSync(repoBuiltPath)) {
    return repoBuiltPath;
  }
  return path.join(moduleDir, "native-mcp-server.ts");
}

async function writeNativeOpenClawMcpLauncher(params: {
  tempDir: string;
  entryPath: string;
  repoRoot: string;
}): Promise<string> {
  const launcherPath = path.join(params.tempDir, "openclaw-native-mcp-launcher.mjs");
  await fsPromises.writeFile(
    launcherPath,
    [
      `process.chdir(${JSON.stringify(params.repoRoot)});`,
      `await import(${JSON.stringify(pathToFileURL(params.entryPath).href)});`,
      "",
    ].join("\n"),
    "utf-8",
  );
  return launcherPath;
}

export async function createNativeOpenClawMcpServerConfig(params: {
  tempDir: string;
  workspaceDir: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
}): Promise<BundleMcpServerConfig> {
  const entryPath = resolveNativeOpenClawMcpEntryPath();
  const repoRoot = resolveNativeOpenClawRepoRoot();
  const launcherPath =
    path.extname(entryPath) === ".ts"
      ? await writeNativeOpenClawMcpLauncher({
          tempDir: params.tempDir,
          entryPath,
          repoRoot,
        })
      : entryPath;
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
    command: path.extname(entryPath) === ".ts" ? "/bin/sh" : process.execPath,
    args:
      path.extname(entryPath) === ".ts"
        ? [
            "-lc",
            [
              "cd",
              shellQuote(repoRoot),
              "&&",
              "exec",
              shellQuote(process.execPath),
              "--import",
              shellQuote(resolveTsxLoaderPath()),
              shellQuote(launcherPath),
            ].join(" "),
          ]
        : [launcherPath],
    // Claude Code does not reliably honor MCP `cwd`; keep it for clients that
    // do, while the generated launcher also chdirs before loading OpenClaw.
    cwd: repoRoot,
    env,
  };
}

export const __testing = {
  resolveNativeOpenClawRepoRoot,
  resolveNativeOpenClawMcpEntryPath,
  resolveTsxLoaderPath,
} as const;
