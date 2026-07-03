import { describe, expect, it, vi } from "vitest";

const resolvePluginImageGenerationProviders = vi.hoisted(() => vi.fn());
const isJarvisManagedOpenAIImageGenerationConfigured = vi.hoisted(() => vi.fn());
const buildJarvisManagedOpenAIImageGenerationProvider = vi.hoisted(() => vi.fn());

vi.mock("../plugins/image-generation-providers.js", () => ({
  resolvePluginImageGenerationProviders,
}));

vi.mock("../consumer/openai-image-generation.js", () => ({
  isJarvisManagedOpenAIImageGenerationConfigured,
  buildJarvisManagedOpenAIImageGenerationProvider,
}));

describe("image-generation provider registry", () => {
  it("uses the managed Jarvis OpenAI provider when managed services are configured", async () => {
    resolvePluginImageGenerationProviders.mockReturnValue([
      {
        id: "openai",
        label: "Direct OpenAI",
        capabilities: {
          generate: {},
          edit: { enabled: true },
        },
        generateImage: vi.fn(),
      },
    ]);
    isJarvisManagedOpenAIImageGenerationConfigured.mockReturnValue(true);
    buildJarvisManagedOpenAIImageGenerationProvider.mockReturnValue({
      id: "openai",
      label: "OpenAI (Jarvis managed)",
      capabilities: {
        generate: {},
        edit: { enabled: false },
      },
      generateImage: vi.fn(),
    });

    const { getImageGenerationProvider, listImageGenerationProviders } =
      await import("./provider-registry.js");

    expect(listImageGenerationProviders({}).map((provider) => provider.label)).toEqual([
      "OpenAI (Jarvis managed)",
    ]);
    expect(getImageGenerationProvider("openai", {})?.label).toBe("OpenAI (Jarvis managed)");
  });

  it("registers canonical ids and aliases", async () => {
    resolvePluginImageGenerationProviders.mockReturnValue([
      {
        id: "OpenAI",
        aliases: ["openai-images"],
        capabilities: {
          generate: {},
          edit: { enabled: true },
        },
        generateImage: vi.fn(),
      },
    ]);
    isJarvisManagedOpenAIImageGenerationConfigured.mockReturnValue(false);

    const { getImageGenerationProvider, listImageGenerationProviders } =
      await import("./provider-registry.js");

    expect(listImageGenerationProviders().map((provider) => provider.id)).toEqual(["OpenAI"]);
    expect(getImageGenerationProvider("openai")).toBeTruthy();
    expect(getImageGenerationProvider("openai-images")).toBeTruthy();
  });
});
