import { describe, expect, it } from "vitest";
import {
  augmentModelCatalogWithProviderPlugins,
  buildProviderMissingAuthMessageWithPlugin,
  resolveProviderBuiltInModelSuppression,
} from "../provider-runtime.js";

describe("provider catalog contract", () => {
  it("keeps codex-only missing-auth hints wired through the provider runtime", () => {
    expect(
      buildProviderMissingAuthMessageWithPlugin({
        provider: "openai",
        env: process.env,
        context: {
          env: process.env,
          provider: "openai",
          listProfileIds: (providerId) => (providerId === "openai-codex" ? ["p1"] : []),
        },
      }),
    ).toContain("openai-codex/gpt-5.5");
  });

  it("keeps built-in model suppression wired through the provider runtime", () => {
    expect(
      resolveProviderBuiltInModelSuppression({
        env: process.env,
        context: {
          env: process.env,
          provider: "azure-openai-responses",
          modelId: "gpt-5.3-codex-spark",
        },
      }),
    ).toMatchObject({
      suppress: true,
      errorMessage: expect.stringContaining("openai-codex/gpt-5.3-codex-spark"),
    });
  });

  it.each(["gpt-5.3-codex", "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5.1-codex-max"])(
    "keeps stale codex model suppression wired through the provider runtime for %s",
    (modelId) => {
      expect(
        resolveProviderBuiltInModelSuppression({
          env: process.env,
          context: {
            env: process.env,
            provider: "openai-codex",
            modelId,
          },
        }),
      ).toMatchObject({
        suppress: true,
        errorMessage: expect.stringContaining(`openai-codex/${modelId}`),
      });
    },
  );

  it("keeps openai-codex spark visible while stale 5.1 codex models are suppressed", () => {
    expect(
      resolveProviderBuiltInModelSuppression({
        env: process.env,
        context: {
          env: process.env,
          provider: "openai-codex",
          modelId: "gpt-5.3-codex-spark",
        },
      }),
    ).toBeUndefined();
  });

  it("keeps bundled model augmentation wired through the provider runtime", async () => {
    await expect(
      augmentModelCatalogWithProviderPlugins({
        env: process.env,
        context: {
          env: process.env,
          entries: [
            { provider: "openai", id: "gpt-5.2", name: "GPT-5.2" },
            { provider: "openai", id: "gpt-5.2-pro", name: "GPT-5.2 Pro" },
            { provider: "openai-codex", id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
            { provider: "openai-codex", id: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
          ],
        },
      }),
    ).resolves.toEqual([
      { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
      { provider: "openai", id: "gpt-5.4", name: "GPT-5.4" },
      { provider: "openai", id: "gpt-5.4-pro", name: "GPT-5.4 Pro" },
      { provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5" },
      { provider: "openai-codex", id: "gpt-5.4", name: "GPT-5.4" },
      { provider: "openai-codex", id: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
      {
        provider: "openai-codex",
        id: "gpt-5.3-codex-spark",
        name: "GPT-5.3 Codex Spark",
      },
    ]);
  });
});
