import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const loadModelCatalog = vi.hoisted(() => vi.fn());

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog,
}));

const { listConsumerModelOptions } = await import("./consumer-models.js");

describe("consumer model shortlist", () => {
  it("exposes only GPT-5.6 Sol for ChatGPT OAuth", async () => {
    loadModelCatalog.mockResolvedValue([
      { provider: "openai-codex", id: "gpt-5.6-sol" },
      { provider: "openai-codex", id: "gpt-5.5" },
      { provider: "openai-codex", id: "gpt-5.4" },
      { provider: "openai-codex", id: "gpt-5.3-codex-spark" },
    ]);
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "openai-codex/gpt-5.6-sol" },
          models: {
            "openai-codex/gpt-5.6-sol": {},
            "openai-codex/gpt-5.5": {},
          },
        },
      },
    };

    await expect(listConsumerModelOptions({ config })).resolves.toMatchObject({
      currentModel: "openai-codex/gpt-5.6-sol",
      options: [{ id: "openai-codex/gpt-5.6-sol", title: "GPT-5.6 Sol" }],
    });
  });

  it("exposes only GPT-5.6 Sol for direct OpenAI API keys", async () => {
    loadModelCatalog.mockResolvedValue([
      { provider: "openai", id: "gpt-5.6-sol" },
      { provider: "openai", id: "gpt-5.5" },
      { provider: "openai", id: "gpt-5.4" },
      { provider: "openai", id: "gpt-5-mini" },
    ]);
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-sol" },
          models: {
            "openai/gpt-5.6-sol": {},
            "openai/gpt-5.4": {},
          },
        },
      },
    };

    await expect(listConsumerModelOptions({ config })).resolves.toMatchObject({
      currentModel: "openai/gpt-5.6-sol",
      options: [{ id: "openai/gpt-5.6-sol", title: "GPT-5.6 Sol" }],
    });
  });
});
