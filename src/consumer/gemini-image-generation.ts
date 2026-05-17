import type { OpenClawConfig } from "../config/types.js";
import {
  createJarvisManagedUtilityClient,
  unwrapManagedProviderPayload,
} from "./managed-utilities.js";

const SUPPORTED_RESOLUTIONS = new Set(["1K", "2K", "4K"]);
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

export type GeminiImageGenerationParams = {
  cfg?: OpenClawConfig;
  prompt: string;
  resolution?: string;
  aspectRatio?: string;
};

export type GeminiGeneratedImage = {
  mimeType: string;
  data: string;
};

export type GeminiImageGenerationResult = {
  provider: "gemini";
  transport: "jarvis-managed";
  model: string;
  text?: string;
  images: GeminiGeneratedImage[];
  payload: Record<string, unknown>;
};

function normalizeOptionalChoice(
  value: string | undefined,
  choices: Set<string>,
  label: string,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!choices.has(trimmed)) {
    throw new Error(`${label} must be one of: ${Array.from(choices).join(", ")}`);
  }
  return trimmed;
}

function readGeneratedImages(payload: Record<string, unknown>): GeminiGeneratedImage[] {
  const rawImages = payload.images;
  if (!Array.isArray(rawImages)) {
    throw new Error("Gemini managed image response is missing images");
  }
  return rawImages.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Gemini managed image response contains an invalid image entry");
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.data !== "string" || !record.data.trim()) {
      throw new Error("Gemini managed image response contains an image without data");
    }
    return {
      mimeType:
        typeof record.mimeType === "string" && record.mimeType.trim()
          ? record.mimeType.trim()
          : "image/png",
      data: record.data,
    };
  });
}

export function isJarvisManagedGeminiImageGenerationConfigured(config?: OpenClawConfig): boolean {
  return Boolean(createJarvisManagedUtilityClient(config));
}

export async function runGeminiImageGeneration(
  params: GeminiImageGenerationParams,
): Promise<GeminiImageGenerationResult> {
  const prompt = params.prompt.trim();
  if (!prompt) {
    throw new Error("Gemini image generation requires a prompt");
  }

  const managedClient = createJarvisManagedUtilityClient(params.cfg);
  if (!managedClient) {
    throw new Error(
      "Gemini image generation needs Jarvis managed services. Configure jarvis.managedServices.mode=managed or use the direct Nano Banana BYOK path.",
    );
  }

  const resolution = normalizeOptionalChoice(
    params.resolution,
    SUPPORTED_RESOLUTIONS,
    "resolution",
  );
  const aspectRatio = normalizeOptionalChoice(
    params.aspectRatio,
    SUPPORTED_ASPECT_RATIOS,
    "aspectRatio",
  );
  const input: Record<string, string> = { prompt };
  if (resolution) {
    input.resolution = resolution;
  }
  if (aspectRatio) {
    input.aspectRatio = aspectRatio;
  }

  const payload = unwrapManagedProviderPayload(
    await managedClient.callManagedUtility({
      utility: "gemini.image.generate",
      input,
    }),
    "gemini",
  );
  const model =
    typeof payload.model === "string" && payload.model.trim()
      ? payload.model.trim()
      : "gemini-3-pro-image-preview";
  const text = typeof payload.text === "string" && payload.text.trim() ? payload.text : undefined;
  return {
    provider: "gemini",
    transport: "jarvis-managed",
    model,
    text,
    images: readGeneratedImages(payload),
    payload,
  };
}
