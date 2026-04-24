import { describe, expect, it, vi } from "vitest";

const resolvePluginImageGenerationProviders = vi.hoisted(() => vi.fn());

vi.mock("../plugins/image-generation-providers.js", () => ({
  resolvePluginImageGenerationProviders,
}));

describe("image-generation provider registry", () => {
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

    const { getImageGenerationProvider, listImageGenerationProviders } =
      await import("./provider-registry.js");

    expect(listImageGenerationProviders().map((provider) => provider.id)).toEqual(["OpenAI"]);
    expect(getImageGenerationProvider("openai")).toBeTruthy();
    expect(getImageGenerationProvider("openai-images")).toBeTruthy();
  });
});
