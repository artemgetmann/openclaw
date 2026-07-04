import type { OpenClawConfig } from "../config/types.js";
import type {
  ImageGenerationProvider,
  ImageGenerationRequest,
  ImageGenerationResult,
} from "../image-generation/types.js";
import {
  createJarvisManagedUtilityClient,
  unwrapManagedProviderPayload,
} from "./managed-utilities.js";

const DEFAULT_MODEL = "gpt-image-2";
const DEFAULT_MIME_TYPE = "image/png";
const MAX_INPUT_IMAGES = 5;
const OPENAI_IMAGE_GENERATION_TIMEOUT_MS = 120_000;
const SUPPORTED_SIZES = [
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "2048x2048",
  "2048x1152",
  "3840x2160",
  "2160x3840",
] as const;

function readGeneratedImages(payload: Record<string, unknown>): ImageGenerationResult["images"] {
  const rawImages = payload.images;
  if (!Array.isArray(rawImages)) {
    throw new Error("OpenAI managed image response is missing images");
  }
  return rawImages.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("OpenAI managed image response contains an invalid image entry");
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.data !== "string" || !record.data.trim()) {
      throw new Error("OpenAI managed image response contains an image without data");
    }
    return {
      buffer: Buffer.from(record.data, "base64"),
      mimeType:
        typeof record.mimeType === "string" && record.mimeType.trim()
          ? record.mimeType.trim()
          : DEFAULT_MIME_TYPE,
      fileName: `image-${index + 1}.png`,
      ...(typeof record.revisedPrompt === "string" && record.revisedPrompt.trim()
        ? { revisedPrompt: record.revisedPrompt.trim() }
        : {}),
    };
  });
}

function buildManagedInputImages(req: ImageGenerationRequest): Array<Record<string, string>> {
  return (req.inputImages ?? []).map((image, index) => ({
    data: image.buffer.toString("base64"),
    mimeType: image.mimeType?.trim() || DEFAULT_MIME_TYPE,
    fileName: image.fileName?.trim() || `image-${index + 1}.png`,
  }));
}

export function isJarvisManagedOpenAIImageGenerationConfigured(config?: OpenClawConfig): boolean {
  return Boolean(createJarvisManagedUtilityClient(config));
}

export function buildJarvisManagedOpenAIImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: "openai",
    label: "OpenAI (Jarvis managed)",
    defaultModel: DEFAULT_MODEL,
    models: [DEFAULT_MODEL],
    isConfigured: ({ cfg }) => isJarvisManagedOpenAIImageGenerationConfigured(cfg),
    capabilities: {
      generate: {
        maxCount: 4,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      edit: {
        enabled: true,
        maxCount: 4,
        maxInputImages: MAX_INPUT_IMAGES,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      geometry: {
        sizes: [...SUPPORTED_SIZES],
      },
    },
    async generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
      const prompt = req.prompt.trim();
      if (!prompt) {
        throw new Error("OpenAI managed image generation requires a prompt");
      }

      const managedClient = createJarvisManagedUtilityClient(req.cfg);
      if (!managedClient) {
        throw new Error(
          "OpenAI image generation needs Jarvis managed services or a direct OpenAI API key.",
        );
      }

      const input: Record<string, unknown> = {
        prompt,
        model: req.model || DEFAULT_MODEL,
      };
      if (typeof req.count === "number") {
        input.count = req.count;
      }
      if (req.size?.trim()) {
        input.size = req.size.trim();
      }
      const inputImages = buildManagedInputImages(req);
      if (inputImages.length > 0) {
        input.inputImages = inputImages;
      }

      const payload = unwrapManagedProviderPayload(
        await managedClient.callManagedUtility({
          utility: "openai.image.generate",
          input,
          // Image edits can legitimately run much longer than license checks,
          // search, or scrape utilities. Keep this scoped so a slow image job
          // does not force every managed backend call to wait two minutes.
          timeoutMs: OPENAI_IMAGE_GENERATION_TIMEOUT_MS,
        }),
        "openai",
      );
      const model =
        typeof payload.model === "string" && payload.model.trim()
          ? payload.model.trim()
          : req.model || DEFAULT_MODEL;

      return {
        model,
        images: readGeneratedImages(payload),
        metadata: { transport: "jarvis-managed" },
      };
    },
  };
}
