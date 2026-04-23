import { describe, expect, it } from "vitest";
import { createCapturedPluginRegistration } from "../../src/test-utils/plugin-registration.js";
import openAIPlugin from "./index.js";

describe("openai plugin image generation registration", () => {
  it("registers the OpenAI image-generation provider", () => {
    const captured = createCapturedPluginRegistration();

    openAIPlugin.register(captured.api);

    expect(captured.imageGenerationProviders.map((provider) => provider.id)).toContain("openai");
  });
});
