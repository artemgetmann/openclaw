import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  withBundledPluginAllowlistCompat,
  withBundledPluginEnablementCompat,
} from "./bundled-compat.js";
import { loadOpenClawPlugins, type PluginLoadOptions } from "./loader.js";
import { createPluginLoaderLogger } from "./logger.js";
import type { WebSearchProviderPlugin } from "./types.js";

const log = createSubsystemLogger("plugins");
const webSearchProviderSnapshotCache = new Map<string, WebSearchProviderPlugin[]>();
const PLUGIN_WEB_SEARCH_ENV_CACHE_KEYS = [
  "HOME",
  "OPENCLAW_HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "VITEST",
] as const;

function pickWebSearchProviderCacheEnv(
  env: PluginLoadOptions["env"],
): Record<string, string | undefined> {
  const source = env ?? process.env;
  return Object.fromEntries(
    PLUGIN_WEB_SEARCH_ENV_CACHE_KEYS.map((key) => [key, source[key]]),
  ) as Record<string, string | undefined>;
}

function buildWebSearchProviderSnapshotCacheKey(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
}): string {
  return JSON.stringify({
    config: params.config ?? {},
    workspaceDir: params.workspaceDir ?? "",
    env: pickWebSearchProviderCacheEnv(params.env),
    bundledAllowlistCompat: params.bundledAllowlistCompat === true,
  });
}

export function clearPluginWebSearchProviderSnapshotCache(): void {
  webSearchProviderSnapshotCache.clear();
}

const BUNDLED_WEB_SEARCH_ALLOWLIST_COMPAT_PLUGIN_IDS = [
  "brave",
  "firecrawl",
  "google",
  "moonshot",
  "perplexity",
  "xai",
] as const;

export function resolvePluginWebSearchProviders(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
}): WebSearchProviderPlugin[] {
  const cacheKey = buildWebSearchProviderSnapshotCacheKey(params);
  const cached = webSearchProviderSnapshotCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const allowlistCompat = params.bundledAllowlistCompat
    ? withBundledPluginAllowlistCompat({
        config: params.config,
        pluginIds: BUNDLED_WEB_SEARCH_ALLOWLIST_COMPAT_PLUGIN_IDS,
      })
    : params.config;
  const config = withBundledPluginEnablementCompat({
    config: allowlistCompat,
    pluginIds: BUNDLED_WEB_SEARCH_ALLOWLIST_COMPAT_PLUGIN_IDS,
  });
  const registry = loadOpenClawPlugins({
    config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    logger: createPluginLoaderLogger(log),
    activate: false,
    cache: false,
    onlyPluginIds: [...BUNDLED_WEB_SEARCH_ALLOWLIST_COMPAT_PLUGIN_IDS],
  });

  const providers = registry.webSearchProviders
    .map((entry) => ({
      ...entry.provider,
      pluginId: entry.pluginId,
    }))
    .toSorted((a, b) => {
      const aOrder = a.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
      const bOrder = b.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) {
        return aOrder - bOrder;
      }
      return a.id.localeCompare(b.id);
    });
  webSearchProviderSnapshotCache.set(cacheKey, providers);
  return providers;
}
