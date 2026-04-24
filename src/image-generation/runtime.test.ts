import { describe, expect, it, vi } from "vitest";

const getImageGenerationProvider = vi.hoisted(() => vi.fn());
const listImageGenerationProviders = vi.hoisted(() => vi.fn());

vi.mock("./provider-registry.js", () => ({
  getImageGenerationProvider,
  listImageGenerationProviders,
}));

describe("image-generation runtime", () => {
  it("generates images with the configured provider and records attempts", async () => {
    const generateImageMock = vi.fn().mockResolvedValue({
      images: [
        {
          buffer: Buffer.from("img"),
          mimeType: "image/png",
        },
      ],
      model: "gpt-image-2",
    });
    listImageGenerationProviders.mockReturnValue([
      {
        id: "openai",
        defaultModel: "gpt-image-2",
        capabilities: {
          generate: { supportsSize: true },
          edit: { enabled: true, supportsSize: true },
        },
      },
    ]);
    getImageGenerationProvider.mockReturnValue({
      id: "openai",
      capabilities: {
        generate: { supportsSize: true },
        edit: { enabled: true, supportsSize: true },
      },
      generateImage: generateImageMock,
    });

    const { generateImage } = await import("./runtime.js");
    const result = await generateImage({
      cfg: {
        agents: {
          defaults: {
            imageGenerationModel: { primary: "openai/gpt-image-2" },
          },
        },
      },
      prompt: "Draw a cat",
    });

    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-image-2");
    expect(result.images).toHaveLength(1);
    expect(result.attempts).toEqual([]);
    expect(generateImageMock).toHaveBeenCalledOnce();
  });
});
