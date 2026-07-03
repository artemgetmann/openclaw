import { describe, expect, it, vi } from "vitest";
import { createImageGenerateTool } from "./image-generate-tool.js";

const listRuntimeImageGenerationProviders = vi.hoisted(() => vi.fn());

vi.mock("../../image-generation/runtime.js", () => ({
  generateImage: vi.fn(),
  listRuntimeImageGenerationProviders,
}));

describe("image_generate tool", () => {
  it("is available through Jarvis managed services without local OpenAI auth", async () => {
    listRuntimeImageGenerationProviders.mockReturnValue([
      {
        id: "openai",
        label: "OpenAI (Jarvis managed)",
        defaultModel: "gpt-image-2",
        models: ["gpt-image-2"],
        isConfigured: () => true,
        capabilities: {
          generate: { maxCount: 4, supportsSize: true },
          edit: { enabled: false },
          geometry: { sizes: ["1024x1024"] },
        },
      },
    ]);

    const tool = createImageGenerateTool({
      config: {
        jarvis: {
          backend: {
            baseUrl: "https://jarvis.example",
            accessToken: "backend-token",
          },
          managedServices: { mode: "managed" },
        },
      },
    });

    expect(tool).not.toBeNull();
    const result = await tool?.execute("tool-1", { action: "list" });
    expect(result).toMatchObject({
      content: [
        {
          type: "text",
          text: expect.stringContaining("auth: Jarvis managed backend"),
        },
      ],
      details: {
        providers: [
          expect.objectContaining({
            id: "openai",
            managed: true,
            authEnvVars: [],
          }),
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain("OPENAI_API_KEY");
  });
});
