import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../../config/model-input.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  generateImage,
  listRuntimeImageGenerationProviders,
} from "../../image-generation/runtime.js";
import type {
  ImageGenerationProvider,
  ImageGenerationResolution,
  ImageGenerationSourceImage,
} from "../../image-generation/types.js";
import { getImageMetadata } from "../../media/image-ops.js";
import { saveMediaBuffer } from "../../media/store.js";
import { loadWebMedia } from "../../plugin-sdk/web-media.js";
import { PROVIDER_ENV_VARS } from "../../secrets/provider-env-vars.js";
import { resolveUserPath } from "../../utils.js";
import { ToolInputError, readNumberParam, readStringParam } from "./common.js";
import { decodeDataUrl } from "./image-tool.helpers.js";
import { resolveMediaToolLocalRoots } from "./media-tool-shared.js";
import { hasAuthForProvider } from "./model-config.helpers.js";
import {
  createSandboxBridgeReadFile,
  resolveSandboxedBridgeMediaPath,
  type AnyAgentTool,
  type SandboxFsBridge,
  type ToolFsPolicy,
} from "./tool-runtime.helpers.js";

const DEFAULT_COUNT = 1;
const MAX_COUNT = 4;
const MAX_INPUT_IMAGES = 5;
const DEFAULT_RESOLUTION: ImageGenerationResolution = "1K";
const DEFAULT_OPENAI_IMAGE_MODEL = "openai/gpt-image-2";
const SUPPORTED_ASPECT_RATIOS = new Set([
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
]);

const ImageGenerateToolSchema = Type.Object({
  action: Type.Optional(
    Type.String({
      description:
        'Optional action: "generate" (default) or "list" to inspect available providers/models.',
    }),
  ),
  prompt: Type.Optional(Type.String({ description: "Image generation prompt." })),
  image: Type.Optional(
    Type.String({
      description: "Optional reference image path or URL for edit mode.",
    }),
  ),
  images: Type.Optional(
    Type.Array(Type.String(), {
      description: `Optional reference images for edit mode (up to ${MAX_INPUT_IMAGES}).`,
    }),
  ),
  model: Type.Optional(
    Type.String({ description: "Optional provider/model override, e.g. openai/gpt-image-2." }),
  ),
  filename: Type.Optional(Type.String({ description: "Optional output filename hint." })),
  size: Type.Optional(Type.String({ description: "Optional size hint like 1024x1024." })),
  aspectRatio: Type.Optional(Type.String({ description: "Optional aspect ratio hint like 16:9." })),
  resolution: Type.Optional(
    Type.String({ description: "Optional resolution hint: 1K, 2K, or 4K." }),
  ),
  count: Type.Optional(
    Type.Number({
      description: `Optional number of images to request (1-${MAX_COUNT}).`,
      minimum: 1,
      maximum: MAX_COUNT,
    }),
  ),
});

type ImageGenerateSandboxConfig = {
  root: string;
  bridge: SandboxFsBridge;
};

type ToolModelConfig = {
  primary?: string;
  fallbacks?: string[];
};

function applyImageGenerationModelConfigDefaults(
  cfg: OpenClawConfig | undefined,
  imageGenerationModelConfig: ToolModelConfig,
): OpenClawConfig | undefined {
  if (!cfg) {
    return undefined;
  }
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        imageGenerationModel: imageGenerationModelConfig,
      },
    },
  };
}

export function resolveImageGenerationModelConfigForTool(params: {
  cfg?: OpenClawConfig;
  agentDir?: string;
}): ToolModelConfig | null {
  const primary = resolveAgentModelPrimaryValue(params.cfg?.agents?.defaults?.imageGenerationModel);
  const fallbacks = resolveAgentModelFallbackValues(
    params.cfg?.agents?.defaults?.imageGenerationModel,
  );
  if (primary || fallbacks.length > 0) {
    return {
      ...(primary ? { primary } : {}),
      ...(fallbacks.length > 0 ? { fallbacks } : {}),
    };
  }

  if (params.agentDir && hasAuthForProvider({ provider: "openai", agentDir: params.agentDir })) {
    return { primary: DEFAULT_OPENAI_IMAGE_MODEL };
  }

  return null;
}

function resolveAction(args: Record<string, unknown>): "generate" | "list" {
  const raw = readStringParam(args, "action");
  if (!raw) {
    return "generate";
  }
  if (raw === "generate" || raw === "list") {
    return raw;
  }
  throw new ToolInputError('action must be either "generate" or "list"');
}

function resolveRequestedCount(args: Record<string, unknown>): number {
  const count = readNumberParam(args, "count", { integer: true });
  if (count === undefined) {
    return DEFAULT_COUNT;
  }
  if (count < 1 || count > MAX_COUNT) {
    throw new ToolInputError(`count must be between 1 and ${MAX_COUNT}`);
  }
  return count;
}

function normalizeResolution(raw: string | undefined): ImageGenerationResolution | undefined {
  const normalized = raw?.trim().toUpperCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "1K" || normalized === "2K" || normalized === "4K") {
    return normalized;
  }
  throw new ToolInputError("resolution must be one of 1K, 2K, or 4K");
}

function normalizeAspectRatio(raw: string | undefined): string | undefined {
  const normalized = raw?.trim();
  if (!normalized) {
    return undefined;
  }
  if (SUPPORTED_ASPECT_RATIOS.has(normalized)) {
    return normalized;
  }
  throw new ToolInputError(
    "aspectRatio must be one of 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, or 21:9",
  );
}

function normalizeReferenceImages(args: Record<string, unknown>): string[] {
  const singular = readStringParam(args, "image");
  const pluralRaw = args.images;
  const plural = Array.isArray(pluralRaw)
    ? pluralRaw.map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean)
    : [];
  const combined = [...(singular ? [singular] : []), ...plural];
  if (combined.length > MAX_INPUT_IMAGES) {
    throw new ToolInputError(`reference images support at most ${MAX_INPUT_IMAGES} inputs`);
  }
  return combined;
}

function getConfiguredMediaMaxBytes(cfg?: OpenClawConfig): number | undefined {
  const configured = cfg?.agents?.defaults?.mediaMaxMb;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured * 1024 * 1024);
  }
  return undefined;
}

function resolveLoadedImageMimeType(media: { contentType?: string; mimeType?: string }): string {
  return media.contentType?.trim() || media.mimeType?.trim() || "image/png";
}

function getImageGenerationProviderAuthEnvVars(providerId: string): string[] {
  return [...(PROVIDER_ENV_VARS[providerId] ?? [])];
}

function isProviderConfigured(
  provider: ImageGenerationProvider,
  cfg?: OpenClawConfig,
  agentDir?: string,
): boolean {
  if (provider.isConfigured) {
    return provider.isConfigured({ cfg, agentDir });
  }
  return Boolean(agentDir && hasAuthForProvider({ provider: provider.id, agentDir }));
}

function formatIgnoredOverride(entry: { key: string; value: string }): string {
  return `${entry.key}=${entry.value}`;
}

function validateImageGenerationCapabilities(params: {
  provider: ImageGenerationProvider | undefined;
  count: number;
  inputImageCount: number;
}) {
  const provider = params.provider;
  if (!provider) {
    return;
  }
  const isEdit = params.inputImageCount > 0;
  const modeCaps = isEdit ? provider.capabilities.edit : provider.capabilities.generate;
  const maxCount = modeCaps.maxCount ?? MAX_COUNT;
  if (params.count > maxCount) {
    throw new ToolInputError(
      `${provider.id} ${isEdit ? "edit" : "generate"} supports at most ${maxCount} output image${maxCount === 1 ? "" : "s"}.`,
    );
  }
  if (isEdit && !provider.capabilities.edit.enabled) {
    throw new ToolInputError(`${provider.id} does not support reference-image edits.`);
  }
  const maxInputImages = provider.capabilities.edit.maxInputImages ?? MAX_INPUT_IMAGES;
  if (params.inputImageCount > maxInputImages) {
    throw new ToolInputError(
      `${provider.id} edit supports at most ${maxInputImages} reference image${maxInputImages === 1 ? "" : "s"}.`,
    );
  }
}

async function loadReferenceImages(params: {
  imageInputs: string[];
  maxBytes?: number;
  workspaceDir?: string;
  sandboxConfig: { root: string; bridge: SandboxFsBridge; workspaceOnly: boolean } | null;
}): Promise<Array<{ sourceImage: ImageGenerationSourceImage; resolvedImage: string }>> {
  const loaded: Array<{ sourceImage: ImageGenerationSourceImage; resolvedImage: string }> = [];

  for (const imageRawInput of params.imageInputs) {
    const trimmed = imageRawInput.trim();
    const imageRaw = trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed;
    if (!imageRaw) {
      throw new ToolInputError("image required (empty string in array)");
    }
    const looksLikeWindowsDrivePath = /^[a-zA-Z]:[\\/]/.test(imageRaw);
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(imageRaw);
    const isFileUrl = /^file:/i.test(imageRaw);
    const isHttpUrl = /^https?:\/\//i.test(imageRaw);
    const isDataUrl = /^data:/i.test(imageRaw);
    if (hasScheme && !looksLikeWindowsDrivePath && !isFileUrl && !isHttpUrl && !isDataUrl) {
      throw new ToolInputError(
        `Unsupported image reference: ${imageRawInput}. Use a file path, a file:// URL, a data: URL, or an http(s) URL.`,
      );
    }
    if (params.sandboxConfig && isHttpUrl) {
      throw new ToolInputError("Sandboxed image_generate does not allow remote URLs.");
    }

    const resolvedImage = (() => {
      if (params.sandboxConfig) {
        return imageRaw;
      }
      if (imageRaw.startsWith("~")) {
        return resolveUserPath(imageRaw);
      }
      return imageRaw;
    })();

    const resolvedPath = isDataUrl
      ? null
      : params.sandboxConfig
        ? (
            await resolveSandboxedBridgeMediaPath({
              sandbox: params.sandboxConfig,
              mediaPath: resolvedImage,
              inboundFallbackDir: "media/inbound",
            })
          ).resolved
        : resolvedImage.startsWith("file://")
          ? resolvedImage.slice("file://".length)
          : resolvedImage;

    const localRoots = resolveMediaToolLocalRoots(params.workspaceDir, {
      workspaceOnly: params.sandboxConfig?.workspaceOnly === true,
    });
    const media = isDataUrl
      ? decodeDataUrl(resolvedImage)
      : await loadWebMedia(resolvedPath ?? resolvedImage, {
          ...(params.maxBytes ? { maxBytes: params.maxBytes } : {}),
          ...(params.sandboxConfig
            ? {
                sandboxValidated: true,
                readFile: createSandboxBridgeReadFile({ sandbox: params.sandboxConfig }),
              }
            : { localRoots }),
        });
    if (media.kind !== "image") {
      throw new ToolInputError(`Unsupported media type: ${media.kind}`);
    }

    loaded.push({
      sourceImage: {
        buffer: media.buffer,
        mimeType: resolveLoadedImageMimeType(media),
      },
      resolvedImage,
    });
  }

  return loaded;
}

async function inferResolutionFromInputImages(
  images: ImageGenerationSourceImage[],
): Promise<ImageGenerationResolution> {
  let maxDimension = 0;
  for (const image of images) {
    const meta = await getImageMetadata(image.buffer);
    const dimension = Math.max(meta?.width ?? 0, meta?.height ?? 0);
    maxDimension = Math.max(maxDimension, dimension);
  }
  if (maxDimension >= 3000) {
    return "4K";
  }
  if (maxDimension >= 1500) {
    return "2K";
  }
  return DEFAULT_RESOLUTION;
}

function buildMediaReferenceDetails(
  entries: Array<{ resolvedImage: string }>,
): Record<string, unknown> {
  if (entries.length === 0) {
    return {};
  }
  return {
    images: entries.map((entry) => entry.resolvedImage),
    image: entries[0]?.resolvedImage,
  };
}

export function createImageGenerateTool(options?: {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  sandbox?: ImageGenerateSandboxConfig;
  fsPolicy?: ToolFsPolicy;
}): AnyAgentTool | null {
  const cfg = options?.config ?? loadConfig();
  const imageGenerationModelConfig = resolveImageGenerationModelConfigForTool({
    cfg,
    agentDir: options?.agentDir,
  });
  if (!imageGenerationModelConfig) {
    return null;
  }
  const effectiveCfg =
    applyImageGenerationModelConfigDefaults(cfg, imageGenerationModelConfig) ?? cfg;
  const sandboxConfig =
    options?.sandbox && options.sandbox.root.trim()
      ? {
          root: options.sandbox.root.trim(),
          bridge: options.sandbox.bridge,
          workspaceOnly: options.fsPolicy?.workspaceOnly === true,
        }
      : null;

  return {
    label: "Image Generation",
    name: "image_generate",
    description:
      'Generate new images or edit reference images with the configured image-generation model (agents.defaults.imageGenerationModel). Use action="list" to inspect registered providers, models, readiness, and auth hints.',
    parameters: ImageGenerateToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = resolveAction(params);
      if (action === "list") {
        const runtimeProviders = listRuntimeImageGenerationProviders({ config: effectiveCfg });
        const providers = runtimeProviders.map((provider) => ({
          id: provider.id,
          ...(provider.label ? { label: provider.label } : {}),
          ...(provider.defaultModel ? { defaultModel: provider.defaultModel } : {}),
          models: provider.models ?? (provider.defaultModel ? [provider.defaultModel] : []),
          configured: isProviderConfigured(provider, effectiveCfg, options?.agentDir),
          authEnvVars: getImageGenerationProviderAuthEnvVars(provider.id),
          capabilities: provider.capabilities,
        }));
        const lines = providers.flatMap((provider) => {
          const caps: string[] = [];
          if (provider.capabilities.edit.enabled) {
            const maxRefs = provider.capabilities.edit.maxInputImages;
            caps.push(
              `editing${typeof maxRefs === "number" ? ` up to ${maxRefs} ref${maxRefs === 1 ? "" : "s"}` : ""}`,
            );
          }
          if ((provider.capabilities.geometry?.sizes?.length ?? 0) > 0) {
            caps.push(`sizes ${provider.capabilities.geometry?.sizes?.join(", ")}`);
          }
          return [
            `${provider.id}${provider.defaultModel ? ` (default ${provider.defaultModel})` : ""}`,
            `  models: ${provider.models.join(", ") || "unknown"}`,
            `  configured: ${provider.configured ? "yes" : "no"}`,
            ...(provider.authEnvVars.length > 0
              ? [`  auth: set ${provider.authEnvVars.join(" / ")} to use ${provider.id}/*`]
              : []),
            ...(caps.length > 0 ? [`  capabilities: ${caps.join("; ")}`] : []),
          ];
        });
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { providers },
        };
      }

      const prompt = readStringParam(params, "prompt", { required: true });
      const imageInputs = normalizeReferenceImages(params);
      const model = readStringParam(params, "model");
      const filename = readStringParam(params, "filename");
      const size = readStringParam(params, "size");
      const aspectRatio = normalizeAspectRatio(readStringParam(params, "aspectRatio"));
      const explicitResolution = normalizeResolution(readStringParam(params, "resolution"));
      const count = resolveRequestedCount(params);
      const configuredMediaMaxBytes = getConfiguredMediaMaxBytes(effectiveCfg);
      const loadedReferenceImages = await loadReferenceImages({
        imageInputs,
        maxBytes: configuredMediaMaxBytes,
        workspaceDir: options?.workspaceDir,
        sandboxConfig,
      });
      const inputImages = loadedReferenceImages.map((entry) => entry.sourceImage);
      const selectedProvider = model
        ? listRuntimeImageGenerationProviders({ config: effectiveCfg }).find(
            (provider) => provider.id === model.split("/", 1)[0],
          )
        : listRuntimeImageGenerationProviders({ config: effectiveCfg }).find((provider) => {
            const primary = imageGenerationModelConfig.primary ?? "";
            return primary.startsWith(`${provider.id}/`);
          });
      const resolution =
        explicitResolution ??
        (size || selectedProvider?.capabilities.generate.supportsResolution === false
          ? undefined
          : inputImages.length > 0
            ? await inferResolutionFromInputImages(inputImages)
            : undefined);
      validateImageGenerationCapabilities({
        provider: selectedProvider,
        count,
        inputImageCount: inputImages.length,
      });

      const result = await generateImage({
        cfg: effectiveCfg,
        prompt,
        agentDir: options?.agentDir,
        modelOverride: model,
        size,
        aspectRatio,
        resolution,
        count,
        inputImages,
      });
      const ignoredOverrides = result.ignoredOverrides ?? [];
      const warning =
        ignoredOverrides.length > 0
          ? `Ignored unsupported overrides for ${result.provider}/${result.model}: ${ignoredOverrides.map(formatIgnoredOverride).join(", ")}.`
          : undefined;

      const savedImages = await Promise.all(
        result.images.map((image) =>
          saveMediaBuffer(
            image.buffer,
            image.mimeType,
            "tool-image-generation",
            configuredMediaMaxBytes,
            filename || image.fileName,
          ),
        ),
      );

      const lines = [
        `Generated ${savedImages.length} image${savedImages.length === 1 ? "" : "s"} with ${result.provider}/${result.model}.`,
        ...(warning ? [`Warning: ${warning}`] : []),
        ...savedImages.map((image) => `MEDIA:${image.path}`),
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          provider: result.provider,
          model: result.model,
          count: savedImages.length,
          media: {
            mediaUrls: savedImages.map((image) => image.path),
          },
          paths: savedImages.map((image) => image.path),
          ...buildMediaReferenceDetails(loadedReferenceImages),
          ...(resolution ? { resolution } : {}),
          ...(size ? { size } : {}),
          ...(aspectRatio ? { aspectRatio } : {}),
          ...(filename ? { filename } : {}),
          attempts: result.attempts,
          ...(result.normalization ? { normalization: result.normalization } : {}),
          ...(result.metadata ? { metadata: result.metadata } : {}),
          ...(warning ? { warning } : {}),
          ...(ignoredOverrides.length > 0 ? { ignoredOverrides } : {}),
        },
      };
    },
  };
}
