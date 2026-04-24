import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";

describe("openai image generation provider auth", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses the standard OpenAI model API key", async () => {
    vi.stubEnv("OPENAI_MODEL_API_KEY", "sk-image-model"); // pragma: allowlist secret
    vi.stubEnv("OPENAI_API_KEY", "");

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ b64_json: Buffer.from("image-bytes").toString("base64") }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildOpenAIImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Draw a tiny robot",
      cfg: {},
    });

    expect(result.images).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer sk-image-model",
    });
  });
});
