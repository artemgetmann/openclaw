import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { applyMergePatch } from "../config/merge-patch.js";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { isRecord } from "../utils.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import {
  CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
  CODEX_BUNDLE_MANIFEST_RELATIVE_PATH,
  CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH,
} from "./bundle-manifest.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import type { PluginBundleFormat } from "./types.js";

export type BundleMcpServerConfig = Record<string, unknown>;

export type BundleMcpConfig = {
  mcpServers: Record<string, BundleMcpServerConfig>;
};

export type BundleMcpDiagnostic = {
  pluginId: string;
  message: string;
};

export type EnabledBundleMcpConfigResult = {
  config: BundleMcpConfig;
  diagnostics: BundleMcpDiagnostic[];
};

const MANIFEST_PATH_BY_FORMAT: Record<PluginBundleFormat, string> = {
  claude: CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
  codex: CODEX_BUNDLE_MANIFEST_RELATIVE_PATH,
  cursor: CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH,
};

const BUNDLE_MCP_CONFIG_LOAD_CONCURRENCY = 6;

function readFileFromOpenFd(fd: number): Promise<string> {
  return new Promise((resolve, reject) => {
    fs.readFile(fd, "utf-8", (error, data) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(data);
    });
  });
}

function normalizePathList(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
}

function mergeUniquePathLists(...groups: string[][]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const entry of group) {
      if (seen.has(entry)) {
        continue;
      }
      seen.add(entry);
      merged.push(entry);
    }
  }
  return merged;
}

function readPluginJsonObject(params: {
  rootDir: string;
  relativePath: string;
  allowMissing?: boolean;
}): { ok: true; raw: Record<string, unknown> } | { ok: false; error: string } {
  const absolutePath = path.join(params.rootDir, params.relativePath);
  const opened = openBoundaryFileSync({
    absolutePath,
    rootPath: params.rootDir,
    boundaryLabel: "plugin root",
    rejectHardlinks: true,
  });
  if (!opened.ok) {
    if (opened.reason === "path" && params.allowMissing) {
      return { ok: true, raw: {} };
    }
    return { ok: false, error: `unable to read ${params.relativePath}: ${opened.reason}` };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(opened.fd, "utf-8")) as unknown;
    if (!isRecord(raw)) {
      return { ok: false, error: `${params.relativePath} must contain a JSON object` };
    }
    return { ok: true, raw };
  } catch (error) {
    return { ok: false, error: `failed to parse ${params.relativePath}: ${String(error)}` };
  } finally {
    fs.closeSync(opened.fd);
  }
}

async function readPluginJsonObjectAsync(params: {
  rootDir: string;
  relativePath: string;
  allowMissing?: boolean;
}): Promise<{ ok: true; raw: Record<string, unknown> } | { ok: false; error: string }> {
  const absolutePath = path.join(params.rootDir, params.relativePath);
  const opened = openBoundaryFileSync({
    absolutePath,
    rootPath: params.rootDir,
    boundaryLabel: "plugin root",
    rejectHardlinks: true,
  });
  if (!opened.ok) {
    if (opened.reason === "path" && params.allowMissing) {
      return { ok: true, raw: {} };
    }
    return { ok: false, error: `unable to read ${params.relativePath}: ${opened.reason}` };
  }
  try {
    // Keep the boundary-verified descriptor, but read through libuv so multiple
    // independent bundle files can make progress together instead of blocking
    // the agent request one plugin at a time.
    const raw = JSON.parse(await readFileFromOpenFd(opened.fd)) as unknown;
    if (!isRecord(raw)) {
      return { ok: false, error: `${params.relativePath} must contain a JSON object` };
    }
    return { ok: true, raw };
  } catch (error) {
    return { ok: false, error: `failed to parse ${params.relativePath}: ${String(error)}` };
  } finally {
    fs.closeSync(opened.fd);
  }
}

function resolveBundleMcpConfigPaths(params: {
  raw: Record<string, unknown>;
  rootDir: string;
  bundleFormat: PluginBundleFormat;
}): string[] {
  const declared = normalizePathList(params.raw.mcpServers);
  const defaults = fs.existsSync(path.join(params.rootDir, ".mcp.json")) ? [".mcp.json"] : [];
  if (params.bundleFormat === "claude") {
    return mergeUniquePathLists(defaults, declared);
  }
  return mergeUniquePathLists(defaults, declared);
}

function extractMcpServerMap(raw: unknown): Record<string, BundleMcpServerConfig> {
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

function isExplicitRelativePath(value: string): boolean {
  return value === "." || value === ".." || value.startsWith("./") || value.startsWith("../");
}

function absolutizeBundleMcpServer(params: {
  baseDir: string;
  server: BundleMcpServerConfig;
}): BundleMcpServerConfig {
  const next: BundleMcpServerConfig = { ...params.server };

  const command = next.command;
  if (typeof command === "string" && isExplicitRelativePath(command)) {
    next.command = path.resolve(params.baseDir, command);
  }

  const cwd = next.cwd;
  if (typeof cwd === "string" && !path.isAbsolute(cwd)) {
    next.cwd = path.resolve(params.baseDir, cwd);
  }

  const workingDirectory = next.workingDirectory;
  if (typeof workingDirectory === "string" && !path.isAbsolute(workingDirectory)) {
    next.workingDirectory = path.resolve(params.baseDir, workingDirectory);
  }

  if (Array.isArray(next.args)) {
    next.args = next.args.map((entry) => {
      if (typeof entry !== "string" || !isExplicitRelativePath(entry)) {
        return entry;
      }
      return path.resolve(params.baseDir, entry);
    });
  }

  return next;
}

function loadBundleFileBackedMcpConfig(params: {
  rootDir: string;
  relativePath: string;
}): BundleMcpConfig {
  const absolutePath = path.resolve(params.rootDir, params.relativePath);
  const opened = openBoundaryFileSync({
    absolutePath,
    rootPath: params.rootDir,
    boundaryLabel: "plugin root",
    rejectHardlinks: true,
  });
  if (!opened.ok) {
    return { mcpServers: {} };
  }
  try {
    const stat = fs.fstatSync(opened.fd);
    if (!stat.isFile()) {
      return { mcpServers: {} };
    }
    const raw = JSON.parse(fs.readFileSync(opened.fd, "utf-8")) as unknown;
    const servers = extractMcpServerMap(raw);
    const baseDir = path.dirname(absolutePath);
    return {
      mcpServers: Object.fromEntries(
        Object.entries(servers).map(([serverName, server]) => [
          serverName,
          absolutizeBundleMcpServer({ baseDir, server }),
        ]),
      ),
    };
  } finally {
    fs.closeSync(opened.fd);
  }
}

async function loadBundleFileBackedMcpConfigAsync(params: {
  rootDir: string;
  relativePath: string;
}): Promise<BundleMcpConfig> {
  const absolutePath = path.resolve(params.rootDir, params.relativePath);
  const opened = openBoundaryFileSync({
    absolutePath,
    rootPath: params.rootDir,
    boundaryLabel: "plugin root",
    rejectHardlinks: true,
  });
  if (!opened.ok) {
    return { mcpServers: {} };
  }
  try {
    const stat = fs.fstatSync(opened.fd);
    if (!stat.isFile()) {
      return { mcpServers: {} };
    }
    // The descriptor was opened with the same boundary checks as the sync path.
    // Reading asynchronously is the only behavioral change: independent MCP
    // config files no longer serialize their I/O latency.
    const raw = JSON.parse(await readFileFromOpenFd(opened.fd)) as unknown;
    const servers = extractMcpServerMap(raw);
    const baseDir = path.dirname(absolutePath);
    return {
      mcpServers: Object.fromEntries(
        Object.entries(servers).map(([serverName, server]) => [
          serverName,
          absolutizeBundleMcpServer({ baseDir, server }),
        ]),
      ),
    };
  } finally {
    fs.closeSync(opened.fd);
  }
}

function loadBundleInlineMcpConfig(params: {
  raw: Record<string, unknown>;
  baseDir: string;
}): BundleMcpConfig {
  if (!isRecord(params.raw.mcpServers)) {
    return { mcpServers: {} };
  }
  const servers = extractMcpServerMap(params.raw.mcpServers);
  return {
    mcpServers: Object.fromEntries(
      Object.entries(servers).map(([serverName, server]) => [
        serverName,
        absolutizeBundleMcpServer({ baseDir: params.baseDir, server }),
      ]),
    ),
  };
}

function loadBundleMcpConfig(params: {
  pluginId: string;
  rootDir: string;
  bundleFormat: PluginBundleFormat;
}): { config: BundleMcpConfig; diagnostics: string[] } {
  const manifestRelativePath = MANIFEST_PATH_BY_FORMAT[params.bundleFormat];
  const manifestLoaded = readPluginJsonObject({
    rootDir: params.rootDir,
    relativePath: manifestRelativePath,
    allowMissing: params.bundleFormat === "claude",
  });
  if (!manifestLoaded.ok) {
    return { config: { mcpServers: {} }, diagnostics: [manifestLoaded.error] };
  }

  let merged: BundleMcpConfig = { mcpServers: {} };
  const filePaths = resolveBundleMcpConfigPaths({
    raw: manifestLoaded.raw,
    rootDir: params.rootDir,
    bundleFormat: params.bundleFormat,
  });
  for (const relativePath of filePaths) {
    merged = applyMergePatch(
      merged,
      loadBundleFileBackedMcpConfig({
        rootDir: params.rootDir,
        relativePath,
      }),
    ) as BundleMcpConfig;
  }

  merged = applyMergePatch(
    merged,
    loadBundleInlineMcpConfig({
      raw: manifestLoaded.raw,
      baseDir: path.dirname(path.join(params.rootDir, manifestRelativePath)),
    }),
  ) as BundleMcpConfig;

  return { config: merged, diagnostics: [] };
}

async function loadBundleMcpConfigAsync(params: {
  pluginId: string;
  rootDir: string;
  bundleFormat: PluginBundleFormat;
}): Promise<{ config: BundleMcpConfig; diagnostics: string[] }> {
  const manifestRelativePath = MANIFEST_PATH_BY_FORMAT[params.bundleFormat];
  const manifestLoaded = await readPluginJsonObjectAsync({
    rootDir: params.rootDir,
    relativePath: manifestRelativePath,
    allowMissing: params.bundleFormat === "claude",
  });
  if (!manifestLoaded.ok) {
    return { config: { mcpServers: {} }, diagnostics: [manifestLoaded.error] };
  }

  let merged: BundleMcpConfig = { mcpServers: {} };
  const filePaths = resolveBundleMcpConfigPaths({
    raw: manifestLoaded.raw,
    rootDir: params.rootDir,
    bundleFormat: params.bundleFormat,
  });
  for (const relativePath of filePaths) {
    merged = applyMergePatch(
      merged,
      await loadBundleFileBackedMcpConfigAsync({
        rootDir: params.rootDir,
        relativePath,
      }),
    ) as BundleMcpConfig;
  }

  merged = applyMergePatch(
    merged,
    loadBundleInlineMcpConfig({
      raw: manifestLoaded.raw,
      baseDir: path.dirname(path.join(params.rootDir, manifestRelativePath)),
    }),
  ) as BundleMcpConfig;

  return { config: merged, diagnostics: [] };
}

export function loadEnabledBundleMcpConfig(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
}): EnabledBundleMcpConfigResult {
  const registry = loadPluginManifestRegistry({
    workspaceDir: params.workspaceDir,
    config: params.cfg,
  });
  const normalizedPlugins = normalizePluginsConfig(params.cfg?.plugins);
  const diagnostics: BundleMcpDiagnostic[] = [];
  let merged: BundleMcpConfig = { mcpServers: {} };

  for (const record of registry.plugins) {
    if (record.format !== "bundle" || !record.bundleFormat) {
      continue;
    }
    const enableState = resolveEffectiveEnableState({
      id: record.id,
      origin: record.origin,
      config: normalizedPlugins,
      rootConfig: params.cfg,
    });
    if (!enableState.enabled) {
      continue;
    }

    const loaded = loadBundleMcpConfig({
      pluginId: record.id,
      rootDir: record.rootDir,
      bundleFormat: record.bundleFormat,
    });
    merged = applyMergePatch(merged, loaded.config) as BundleMcpConfig;
    for (const message of loaded.diagnostics) {
      diagnostics.push({ pluginId: record.id, message });
    }
  }

  return { config: merged, diagnostics };
}

export async function loadEnabledBundleMcpConfigAsync(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
}): Promise<EnabledBundleMcpConfigResult> {
  const registry = loadPluginManifestRegistry({
    workspaceDir: params.workspaceDir,
    config: params.cfg,
  });
  const normalizedPlugins = normalizePluginsConfig(params.cfg?.plugins);

  const enabledBundleRecords = registry.plugins.filter((record) => {
    if (record.format !== "bundle" || !record.bundleFormat) {
      return false;
    }
    const enableState = resolveEffectiveEnableState({
      id: record.id,
      origin: record.origin,
      config: normalizedPlugins,
      rootConfig: params.cfg,
    });
    return enableState.enabled;
  });

  const tasks = enabledBundleRecords.map((record) => async () => ({
    pluginId: record.id,
    loaded: await loadBundleMcpConfigAsync({
      pluginId: record.id,
      rootDir: record.rootDir,
      bundleFormat: record.bundleFormat as PluginBundleFormat,
    }),
  }));

  const { results, firstError, hasError } = await runTasksWithConcurrency({
    tasks,
    limit: BUNDLE_MCP_CONFIG_LOAD_CONCURRENCY,
    errorMode: "stop",
  });
  if (hasError) {
    throw firstError;
  }

  const diagnostics: BundleMcpDiagnostic[] = [];
  let merged: BundleMcpConfig = { mcpServers: {} };
  for (const result of results) {
    if (!result) {
      continue;
    }
    // Merge in registry order so parallel loading cannot change override
    // precedence when two bundles declare the same MCP server key.
    merged = applyMergePatch(merged, result.loaded.config) as BundleMcpConfig;
    for (const message of result.loaded.diagnostics) {
      diagnostics.push({ pluginId: result.pluginId, message });
    }
  }

  return { config: merged, diagnostics };
}
