import type { FallbackAttempt } from "../agents/model-fallback.types.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseImageGenerationModelRef } from "./model-ref.js";
import { resolveImageGenerationOverrides } from "./normalization.js";
import { getImageGenerationProvider, listImageGenerationProviders } from "./provider-registry.js";
import type { GenerateImageParams, GenerateImageRuntimeResult } from "./runtime-types.js";

const log = createSubsystemLogger("image-generation");

export type { GenerateImageParams, GenerateImageRuntimeResult } from "./runtime-types.js";

function resolveConfiguredModelRefs(cfg: OpenClawConfig): string[] {
  const refs = [
    resolveAgentModelPrimaryValue(cfg.agents?.defaults?.imageGenerationModel),
    ...resolveAgentModelFallbackValues(cfg.agents?.defaults?.imageGenerationModel),
  ];
  return Array.from(new Set(refs.map((value) => value?.trim() ?? "").filter(Boolean)));
}

function buildNoImageGenerationModelConfiguredMessage(cfg: OpenClawConfig): string {
  const providers = listImageGenerationProviders(cfg)
    .filter((provider) => provider.isConfigured?.({ cfg }) ?? true)
    .map((provider) => {
      const model = provider.defaultModel ?? provider.models?.[0];
      return model ? `${provider.id}/${model}` : provider.id;
    });
  if (providers.length > 0) {
    return [
      "No image-generation model configured.",
      "Set agents.defaults.imageGenerationModel.primary or use model=provider/model.",
      `Configured providers detected: ${providers.join(", ")}.`,
    ].join(" ");
  }
  return "No image-generation model configured. Set agents.defaults.imageGenerationModel.primary.";
}

function resolveCandidates(params: {
  cfg: OpenClawConfig;
  modelOverride?: string;
}): Array<{ provider: string; model: string }> {
  const refs = params.modelOverride
    ? [params.modelOverride]
    : resolveConfiguredModelRefs(params.cfg);
  return refs
    .map((ref) => parseImageGenerationModelRef(ref))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}

export function listRuntimeImageGenerationProviders(params?: { config?: OpenClawConfig }) {
  return listImageGenerationProviders(params?.config);
}

export async function generateImage(
  params: GenerateImageParams,
): Promise<GenerateImageRuntimeResult> {
  const candidates = resolveCandidates(params);
  if (candidates.length === 0) {
    throw new Error(buildNoImageGenerationModelConfiguredMessage(params.cfg));
  }

  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  for (const candidate of candidates) {
    const provider = getImageGenerationProvider(candidate.provider, params.cfg);
    if (!provider) {
      const error = `No image-generation provider registered for ${candidate.provider}`;
      attempts.push({ provider: candidate.provider, model: candidate.model, error });
      lastError = new Error(error);
      continue;
    }

    try {
      // Normalize geometry hints per-provider so the tool can expose a stable user surface
      // while providers keep their own stricter native constraints.
      const sanitized = resolveImageGenerationOverrides({
        provider,
        size: params.size,
        aspectRatio: params.aspectRatio,
        resolution: params.resolution,
        inputImages: params.inputImages,
      });
      const result = await provider.generateImage({
        provider: candidate.provider,
        model: candidate.model,
        prompt: params.prompt,
        cfg: params.cfg,
        agentDir: params.agentDir,
        count: params.count,
        size: sanitized.size,
        aspectRatio: sanitized.aspectRatio,
        resolution: sanitized.resolution,
        inputImages: params.inputImages,
      });
      if (!Array.isArray(result.images) || result.images.length === 0) {
        throw new Error("Image generation provider returned no images.");
      }
      return {
        images: result.images,
        provider: candidate.provider,
        model: result.model ?? candidate.model,
        attempts,
        normalization: sanitized.normalization,
        metadata: result.metadata,
        ignoredOverrides: sanitized.ignoredOverrides,
      };
    } catch (error) {
      lastError = error;
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error: formatErrorMessage(error),
      });
      log.warn(
        `image-generation candidate failed: ${candidate.provider}/${candidate.model}: ${formatErrorMessage(error)}`,
      );
    }
  }

  const message = attempts.length
    ? `Image generation failed after ${attempts.length} attempt${attempts.length === 1 ? "" : "s"}: ${attempts.map((attempt) => `${attempt.provider}/${attempt.model}: ${attempt.error}`).join("; ")}`
    : "Image generation failed.";
  if (lastError instanceof Error) {
    throw new Error(message, { cause: lastError });
  }
  throw new Error(message);
}
