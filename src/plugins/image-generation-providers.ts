import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  withBundledPluginAllowlistCompat,
  withBundledPluginEnablementCompat,
} from "./bundled-compat.js";
import { loadOpenClawPlugins, type PluginLoadOptions } from "./loader.js";
import { createPluginLoaderLogger } from "./logger.js";
import type { ImageGenerationProviderPlugin } from "./types.js";

const log = createSubsystemLogger("plugins");

const BUNDLED_IMAGE_GENERATION_PLUGIN_IDS = ["openai"] as const;

export function resolvePluginImageGenerationProviders(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
}): ImageGenerationProviderPlugin[] {
  const allowlistCompat = params.bundledAllowlistCompat
    ? withBundledPluginAllowlistCompat({
        config: params.config,
        pluginIds: BUNDLED_IMAGE_GENERATION_PLUGIN_IDS,
      })
    : params.config;
  const config = withBundledPluginEnablementCompat({
    config: allowlistCompat,
    pluginIds: BUNDLED_IMAGE_GENERATION_PLUGIN_IDS,
  });
  const registry = loadOpenClawPlugins({
    config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    logger: createPluginLoaderLogger(log),
    activate: false,
    cache: false,
    onlyPluginIds: [...BUNDLED_IMAGE_GENERATION_PLUGIN_IDS],
  });

  return (registry.imageGenerationProviders ?? []).map((entry) => ({
    ...entry.provider,
    pluginId: entry.pluginId,
  }));
}
