import { describe, expect, it } from "vitest";
import { createCapturedPluginRegistration } from "../../src/test-utils/plugin-registration.js";
import openAIPlugin from "./index.js";
import { buildOpenAICodexProviderPlugin } from "./openai-codex-provider.js";

describe("openai plugin image generation registration", () => {
  it("registers the OpenAI image-generation provider", () => {
    const captured = createCapturedPluginRegistration();

    openAIPlugin.register(captured.api);

    expect(captured.imageGenerationProviders.map((provider) => provider.id)).toContain("openai");
  });
});

describe("openai codex provider", () => {
  it("defaults missing codex api metadata to openai-codex-responses", () => {
    const provider = buildOpenAICodexProviderPlugin();

    const model = provider.normalizeResolvedModel?.({
      provider: "openai-codex",
      model: {
        id: "gpt-5.4",
        name: "gpt-5.4",
        provider: "openai-codex",
        baseUrl: "https://chatgpt.com/backend-api",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_050_000,
        maxTokens: 128_000,
      },
    } as never);

    expect(model).toMatchObject({
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
    });
  });

  it("normalizes stale /backend-api/v1 codex metadata to the canonical base URL", () => {
    const provider = buildOpenAICodexProviderPlugin();

    const model = provider.normalizeResolvedModel?.({
      provider: "openai-codex",
      model: {
        id: "gpt-5.4",
        name: "gpt-5.4",
        provider: "openai-codex",
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_050_000,
        maxTokens: 128_000,
      },
    } as never);

    expect(model).toMatchObject({
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
    });
  });
});
