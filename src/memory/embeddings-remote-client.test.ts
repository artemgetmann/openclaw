import { afterEach, describe, expect, it } from "vitest";
import { resolveRemoteEmbeddingBearerClient } from "./embeddings-remote-client.js";

describe("resolveRemoteEmbeddingBearerClient", () => {
  const previousNonModel = process.env.OPENAI_NON_MODEL_API_KEY;
  const previousGeneric = process.env.OPENAI_API_KEY;

  afterEach(() => {
    if (previousNonModel === undefined) {
      delete process.env.OPENAI_NON_MODEL_API_KEY;
    } else {
      process.env.OPENAI_NON_MODEL_API_KEY = previousNonModel;
    }
    if (previousGeneric === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousGeneric;
    }
  });

  it("prefers OPENAI_NON_MODEL_API_KEY for openai embeddings", async () => {
    process.env.OPENAI_NON_MODEL_API_KEY = "sk-non-model"; // pragma: allowlist secret
    process.env.OPENAI_API_KEY = "sk-generic"; // pragma: allowlist secret

    const client = await resolveRemoteEmbeddingBearerClient({
      provider: "openai",
      defaultBaseUrl: "https://api.openai.com/v1",
      options: {
        model: "text-embedding-3-small",
        config: {},
      },
    });

    expect(client.headers.Authorization).toBe("Bearer sk-non-model");
    expect(client.authSource).toBe("env: OPENAI_NON_MODEL_API_KEY");
  });
});
