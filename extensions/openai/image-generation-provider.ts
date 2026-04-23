import { resolveApiKeyForProvider } from "../../src/agents/model-auth.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { resolveOpenAiModelEnvApiKey } from "../../src/openai/auth-split.js";
import type { ImageGenerationProviderPlugin } from "../../src/plugins/types.js";
import { OPENAI_DEFAULT_IMAGE_MODEL } from "./default-models.js";
import { OPENAI_API_BASE_URL } from "./shared.js";

const DEFAULT_OUTPUT_MIME = "image/png";
const DEFAULT_SIZE = "1024x1024";
const CONSUMER_OPENAI_ENV_KEY = "OPENCLAW_CONSUMER_OPENAI_API_KEY";
const OPENAI_SUPPORTED_SIZES = [
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "2048x2048",
  "2048x1152",
  "3840x2160",
  "2160x3840",
] as const;
const OPENAI_MAX_INPUT_IMAGES = 5;

type OpenAIImageApiResponse = {
  data?: Array<{
    b64_json?: string;
    revised_prompt?: string;
  }>;
  error?: {
    message?: string;
  };
};

function resolveConfiguredOpenAIBaseUrl(cfg: OpenClawConfig | undefined): string {
  const configured = cfg?.models?.providers?.openai?.baseUrl?.trim();
  if (!configured) {
    return OPENAI_API_BASE_URL;
  }
  return configured.endsWith("/v1") ? configured : `${configured.replace(/\/+$/, "")}/v1`;
}

function resolveConsumerOpenAIImageApiKey(): string | undefined {
  const value = process.env[CONSUMER_OPENAI_ENV_KEY]?.trim();
  return value ? value : undefined;
}

async function resolveOpenAIImageGenerationApiKey(params: {
  cfg: OpenClawConfig | undefined;
  agentDir: string | undefined;
}): Promise<string | undefined> {
  const consumerApiKey = resolveConsumerOpenAIImageApiKey();

  // Avoid auth-store/plugin discovery on the packaged consumer happy path. If a
  // normal OpenAI model key is present, preserve existing provider auth
  // semantics; otherwise the consumer utility key is the intended image auth.
  if (consumerApiKey && !params.cfg?.models?.providers?.openai?.apiKey) {
    const modelEnvApiKey = resolveOpenAiModelEnvApiKey().apiKey?.trim();
    return modelEnvApiKey || consumerApiKey;
  }

  try {
    const auth = await resolveApiKeyForProvider({
      provider: "openai",
      cfg: params.cfg,
      agentDir: params.agentDir,
    });
    const apiKey = auth.apiKey?.trim();
    if (apiKey) {
      return apiKey;
    }
  } catch (error) {
    if (!consumerApiKey) {
      throw error;
    }
  }

  // Early consumer bundles intentionally reuse the speech utility key for
  // native image generation. Keep this fallback scoped to the image provider so
  // normal OpenAI model auth does not start accepting consumer-only secrets.
  return consumerApiKey;
}

function toOpenAIDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

async function parseOpenAIError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as OpenAIImageApiResponse;
    return payload.error?.message?.trim() || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

export function buildOpenAIImageGenerationProvider(): ImageGenerationProviderPlugin {
  return {
    id: "openai",
    label: "OpenAI",
    defaultModel: OPENAI_DEFAULT_IMAGE_MODEL,
    models: [OPENAI_DEFAULT_IMAGE_MODEL],
    isConfigured: ({ cfg }) =>
      Boolean(cfg?.models?.providers?.openai?.apiKey) ||
      Boolean(resolveOpenAiModelEnvApiKey().apiKey) ||
      Boolean(resolveConsumerOpenAIImageApiKey()),
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
        maxInputImages: OPENAI_MAX_INPUT_IMAGES,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      geometry: {
        sizes: [...OPENAI_SUPPORTED_SIZES],
      },
    },
    async generateImage(req) {
      const inputImages = req.inputImages ?? [];
      const isEdit = inputImages.length > 0;
      const apiKey = await resolveOpenAIImageGenerationApiKey({
        cfg: req.cfg,
        agentDir: req.agentDir,
      });
      if (!apiKey) {
        throw new Error("OpenAI API key missing");
      }

      const response = await fetch(
        `${resolveConfiguredOpenAIBaseUrl(req.cfg)}/${isEdit ? "images/edits" : "images/generations"}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(
            isEdit
              ? {
                  model: req.model || OPENAI_DEFAULT_IMAGE_MODEL,
                  prompt: req.prompt,
                  n: req.count ?? 1,
                  size: req.size ?? DEFAULT_SIZE,
                  images: inputImages.map((image) => ({
                    image_url: toOpenAIDataUrl(
                      image.buffer,
                      image.mimeType?.trim() || DEFAULT_OUTPUT_MIME,
                    ),
                  })),
                }
              : {
                  model: req.model || OPENAI_DEFAULT_IMAGE_MODEL,
                  prompt: req.prompt,
                  n: req.count ?? 1,
                  size: req.size ?? DEFAULT_SIZE,
                },
          ),
        },
      );

      if (!response.ok) {
        throw new Error(
          `${isEdit ? "OpenAI image edit failed" : "OpenAI image generation failed"}: ${await parseOpenAIError(response)}`,
        );
      }

      const data = (await response.json()) as OpenAIImageApiResponse;
      const images = (data.data ?? [])
        .map((entry, index) => {
          if (!entry.b64_json) {
            return null;
          }
          return {
            buffer: Buffer.from(entry.b64_json, "base64"),
            mimeType: DEFAULT_OUTPUT_MIME,
            fileName: `image-${index + 1}.png`,
            ...(entry.revised_prompt ? { revisedPrompt: entry.revised_prompt } : {}),
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

      return {
        images,
        model: req.model || OPENAI_DEFAULT_IMAGE_MODEL,
      };
    },
  };
}
