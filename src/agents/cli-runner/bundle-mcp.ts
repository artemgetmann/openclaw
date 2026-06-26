import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { applyMergePatch } from "../../config/merge-patch.js";
import type { CliBackendConfig } from "../../config/types.js";
import {
  loadEnabledBundleMcpConfigAsync,
  type BundleMcpConfig,
  type BundleMcpServerConfig,
} from "../../plugins/bundle-mcp.js";
import { isRecord } from "../../utils.js";
import {
  createNativeOpenClawMcpServerConfig,
  OPENCLAW_NATIVE_MCP_SERVER_KEY,
} from "./native-mcp.js";

type PreparedCliBundleMcpConfig = {
  backend: CliBackendConfig;
  cleanup?: () => Promise<void>;
  mcpConfigHash?: string;
  mcpResumeHash?: string;
  env?: Record<string, string>;
};

function supportsBundleMcpOverlay(backendId: string): boolean {
  return backendId === "claude-cli" || backendId === "claude-bridge";
}

function supportsNativeOpenClawMcpServer(backendId: string): boolean {
  return backendId === "claude-cli" || backendId === "claude-bridge";
}

function resolveNativeOpenClawMcpServerKey(backendId: string): string {
  if (backendId === "claude-cli") {
    return "openclaw";
  }
  return OPENCLAW_NATIVE_MCP_SERVER_KEY;
}

function extractServerMap(raw: unknown): Record<string, BundleMcpServerConfig> {
  if (!isRecord(raw)) {
    return {};
  }
  const nested = isRecord(raw.mcpServers)
    ? raw.mcpServers
    : isRecord(raw.servers)
      ? raw.servers
      : raw;
  if (!isRecord(nested)) {
    return {};
  }
  const result: Record<string, BundleMcpServerConfig> = {};
  for (const [serverName, serverRaw] of Object.entries(nested)) {
    if (!isRecord(serverRaw)) {
      continue;
    }
    result[serverName] = { ...serverRaw };
  }
  return result;
}

async function readExternalMcpConfig(configPath: string): Promise<BundleMcpConfig> {
  try {
    const raw = JSON.parse(await fs.readFile(configPath, "utf-8")) as unknown;
    return { mcpServers: extractServerMap(raw) };
  } catch {
    return { mcpServers: {} };
  }
}

function findMcpConfigPath(args?: string[]): string | undefined {
  if (!args?.length) {
    return undefined;
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--mcp-config") {
      const next = args[i + 1];
      return typeof next === "string" && next.trim() ? next.trim() : undefined;
    }
    if (arg.startsWith("--mcp-config=")) {
      const inline = arg.slice("--mcp-config=".length).trim();
      return inline || undefined;
    }
  }
  return undefined;
}

function injectMcpConfigArgs(args: string[] | undefined, mcpConfigPath: string): string[] {
  const next: string[] = [];
  for (let i = 0; i < (args?.length ?? 0); i += 1) {
    const arg = args?.[i] ?? "";
    if (arg === "--strict-mcp-config") {
      continue;
    }
    if (arg === "--mcp-config") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--mcp-config=")) {
      continue;
    }
    next.push(arg);
  }
  next.push("--strict-mcp-config", "--mcp-config", mcpConfigPath);
  return next;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, sortJsonValue(value[key])]),
  );
}

function normalizeOpenClawLoopbackUrl(value: string): string {
  const match =
    /^(http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])):\d+(\/mcp)$/.exec(value.trim()) ?? undefined;
  if (!match) {
    return value;
  }
  return `${match[1]}:<openclaw-loopback>${match[2]}`;
}

function canonicalizeBundleMcpConfigForResume(config: BundleMcpConfig): BundleMcpConfig {
  return {
    mcpServers: Object.fromEntries(
      Object.entries(config.mcpServers).map(([name, server]) => {
        if (name !== "openclaw" || typeof server.url !== "string") {
          return [name, sortJsonValue(server)];
        }
        return [
          name,
          sortJsonValue({
            ...server,
            url: normalizeOpenClawLoopbackUrl(server.url),
          }),
        ];
      }),
    ) as BundleMcpConfig["mcpServers"],
  };
}

export async function prepareCliBundleMcpConfig(params: {
  backendId: string;
  backend: CliBackendConfig;
  workspaceDir: string;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
  additionalConfig?: BundleMcpConfig;
  env?: Record<string, string>;
  warn?: (message: string) => void;
}): Promise<PreparedCliBundleMcpConfig> {
  if (!supportsBundleMcpOverlay(params.backendId)) {
    return { backend: params.backend, env: params.env };
  }

  const existingMcpConfigPath =
    findMcpConfigPath(params.backend.resumeArgs) ?? findMcpConfigPath(params.backend.args);
  let mergedConfig: BundleMcpConfig = { mcpServers: {} };

  if (existingMcpConfigPath) {
    const resolvedExistingPath = path.isAbsolute(existingMcpConfigPath)
      ? existingMcpConfigPath
      : path.resolve(params.workspaceDir, existingMcpConfigPath);
    mergedConfig = applyMergePatch(
      mergedConfig,
      await readExternalMcpConfig(resolvedExistingPath),
    ) as BundleMcpConfig;
  }

  const bundleConfig = await loadEnabledBundleMcpConfigAsync({
    workspaceDir: params.workspaceDir,
    cfg: params.config,
  });
  for (const diagnostic of bundleConfig.diagnostics) {
    params.warn?.(`bundle MCP skipped for ${diagnostic.pluginId}: ${diagnostic.message}`);
  }
  mergedConfig = applyMergePatch(mergedConfig, bundleConfig.config) as BundleMcpConfig;
  if (params.additionalConfig) {
    mergedConfig = applyMergePatch(mergedConfig, params.additionalConfig) as BundleMcpConfig;
  }

  const usesLoopbackOpenClawServer =
    params.backendId === "claude-cli" && Boolean(params.additionalConfig?.mcpServers?.openclaw);
  const needsNativeServer =
    supportsNativeOpenClawMcpServer(params.backendId) && !usesLoopbackOpenClawServer;
  if (!needsNativeServer && Object.keys(mergedConfig.mcpServers).length === 0) {
    return { backend: params.backend, env: params.env };
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-mcp-"));
  if (needsNativeServer) {
    const serverKey = resolveNativeOpenClawMcpServerKey(params.backendId);
    mergedConfig = applyMergePatch(mergedConfig, {
      mcpServers: {
        [serverKey]: await createNativeOpenClawMcpServerConfig({
          tempDir,
          workspaceDir: params.workspaceDir,
          config: params.config,
          sessionKey: params.sessionKey,
          agentId: params.agentId,
        }),
      },
    }) as BundleMcpConfig;
  }
  const mcpConfigPath = path.join(tempDir, "mcp.json");
  const serializedConfig = `${JSON.stringify(mergedConfig, null, 2)}\n`;
  const mcpConfigHash = crypto.createHash("sha256").update(serializedConfig).digest("hex");
  const serializedResumeConfig = `${JSON.stringify(
    canonicalizeBundleMcpConfigForResume(mergedConfig),
    null,
    2,
  )}\n`;
  const mcpResumeHash = crypto.createHash("sha256").update(serializedResumeConfig).digest("hex");
  await fs.writeFile(mcpConfigPath, serializedConfig, "utf-8");

  return {
    backend: {
      ...params.backend,
      args: injectMcpConfigArgs(params.backend.args, mcpConfigPath),
      resumeArgs: injectMcpConfigArgs(
        params.backend.resumeArgs ?? params.backend.args ?? [],
        mcpConfigPath,
      ),
    },
    mcpConfigHash,
    mcpResumeHash,
    env: params.env,
    cleanup: async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}
