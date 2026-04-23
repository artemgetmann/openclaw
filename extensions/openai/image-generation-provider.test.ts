import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";

describe("openai image generation provider auth", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses the bundled consumer OpenAI key when model auth env vars are absent", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-openai-image-auth-"));
    try {
      vi.stubEnv("OPENAI_MODEL_API_KEY", "");
      vi.stubEnv("OPENAI_API_KEY", "");
      vi.stubEnv("OPENCLAW_CONSUMER_OPENAI_API_KEY", "sk-consumer-image"); // pragma: allowlist secret

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
        agentDir,
      });

      expect(result.images).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
        Authorization: "Bearer sk-consumer-image",
      });
    } finally {
      await fs.rm(agentDir, { force: true, recursive: true });
    }
  });
});
