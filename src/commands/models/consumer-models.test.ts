import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { applyConsumerModel, listConsumerModelOptions } from "./consumer-models.js";

type CatalogEntry = {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
};

let catalogEntries: CatalogEntry[] = [];

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(async () => catalogEntries),
}));

function buildConfig(model: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          primary: model,
        },
      },
    },
  } as OpenClawConfig;
}

function buildConfigWithSeededModels(model: string, models: string[]): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          primary: model,
        },
        models: Object.fromEntries(models.map((entry) => [entry, {}])),
      },
    },
  } as OpenClawConfig;
}

function readyReadiness(defaultModel: string) {
  return {
    status: "ready" as const,
    mode: "byok" as const,
    defaultModel,
    configPath: "/tmp/openclaw.json",
    stateDir: "/tmp/state",
    agentDir: "/tmp/agent",
    authMode: "byok" as const,
    reasonCodes: [],
    summary: "ready",
    actions: [],
    byokAvailable: true,
  };
}

describe("consumer model picker", () => {
  beforeEach(() => {
    catalogEntries = [];
  });

  it("lists the curated ChatGPT/Codex shortlist for the current Codex family", async () => {
    catalogEntries = [
      { provider: "openai-codex", id: "gpt-5.5" },
      { provider: "openai-codex", id: "gpt-5.4" },
      { provider: "openai-codex", id: "gpt-5.3-codex" },
      { provider: "openai-codex", id: "gpt-5.3-codex-spark" },
      { provider: "openai-codex", id: "gpt-5.1-codex" },
      { provider: "openai-codex", id: "gpt-5.1-codex-mini" },
      { provider: "openai-codex", id: "gpt-5.1-codex-max" },
      { provider: "openai-codex", id: "gpt-5.4-mini" },
      { provider: "openai", id: "gpt-5.4" },
      { provider: "openai", id: "gpt-5.4-pro" },
      { provider: "anthropic", id: "claude-sonnet-4-6" },
    ];

    const result = await listConsumerModelOptions({
      config: buildConfig("openai-codex/gpt-5.5"),
    });

    expect(result.currentModel).toBe("openai-codex/gpt-5.5");
    expect(result.options.map((entry) => entry.id)).toEqual([
      "openai-codex/gpt-5.5",
      "openai-codex/gpt-5.4",
      "openai-codex/gpt-5.3-codex",
      "openai-codex/gpt-5.3-codex-spark",
      "openai-codex/gpt-5.4-mini",
    ]);
  });

  it("lists the curated OpenAI API shortlist for the current OpenAI family", async () => {
    catalogEntries = [
      { provider: "openai-codex", id: "gpt-5.4" },
      { provider: "openai", id: "gpt-5.4" },
      { provider: "openai", id: "gpt-5.4-pro" },
      { provider: "openai", id: "gpt-5-mini" },
      { provider: "anthropic", id: "claude-sonnet-4-6" },
    ];

    const result = await listConsumerModelOptions({
      config: buildConfig("openai/gpt-5.4"),
    });

    expect(result.currentModel).toBe("openai/gpt-5.4");
    expect(result.options.map((entry) => entry.id)).toEqual([
      "openai/gpt-5.4",
      "openai/gpt-5-mini",
    ]);
  });

  it("lists the curated Claude shortlist for the current Anthropic family", async () => {
    catalogEntries = [
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      { provider: "anthropic", id: "claude-opus-4-6" },
      { provider: "anthropic", id: "claude-haiku-4-5" },
      { provider: "openai-codex", id: "gpt-5.4" },
    ];

    const result = await listConsumerModelOptions({
      config: buildConfig("anthropic/claude-sonnet-4-6"),
    });

    expect(result.currentModel).toBe("anthropic/claude-sonnet-4-6");
    expect(result.options.map((entry) => entry.id)).toEqual([
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-opus-4-6",
      "anthropic/claude-haiku-4-5",
    ]);
  });

  it("keeps seeded consumer models visible even when the live catalog is sparse", async () => {
    catalogEntries = [{ provider: "openai-codex", id: "gpt-5.5" }];

    const result = await listConsumerModelOptions({
      config: buildConfigWithSeededModels("openai-codex/gpt-5.5", [
        "openai-codex/gpt-5.5",
        "openai-codex/gpt-5.3-codex",
      ]),
    });

    expect(result.options.map((entry) => entry.id)).toEqual([
      "openai-codex/gpt-5.5",
      "openai-codex/gpt-5.3-codex",
    ]);
  });

  it("hides stale 5.1 mini and max entries even when an older config seeded them", async () => {
    catalogEntries = [
      { provider: "openai-codex", id: "gpt-5.5" },
      { provider: "openai-codex", id: "gpt-5.1-codex-mini" },
      { provider: "openai-codex", id: "gpt-5.1-codex-max" },
    ];

    const result = await listConsumerModelOptions({
      config: buildConfigWithSeededModels("openai-codex/gpt-5.5", [
        "openai-codex/gpt-5.5",
        "openai-codex/gpt-5.1-codex-mini",
        "openai-codex/gpt-5.1-codex-max",
      ]),
    });

    expect(result.options.map((entry) => entry.id)).toEqual(["openai-codex/gpt-5.5"]);
  });

  it("rejects models outside the current consumer auth family", async () => {
    catalogEntries = [
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      { provider: "anthropic", id: "claude-opus-4-6" },
      { provider: "openai-codex", id: "gpt-5.5" },
    ];

    await expect(
      applyConsumerModel({
        model: "openai-codex/gpt-5.5",
        config: buildConfig("anthropic/claude-sonnet-4-6"),
      }),
    ).rejects.toThrow(
      'Model "openai-codex/gpt-5.5" is not available for the current consumer auth path.',
    );
  });

  it("applies a curated model and reruns readiness", async () => {
    catalogEntries = [
      { provider: "openai-codex", id: "gpt-5.5" },
      { provider: "openai-codex", id: "gpt-5.4" },
      { provider: "openai-codex", id: "gpt-5.3-codex" },
      { provider: "openai-codex", id: "gpt-5.1-codex" },
      { provider: "openai", id: "gpt-5.4" },
    ];

    let current = buildConfig("openai-codex/gpt-5.5");
    const result = await applyConsumerModel({
      model: "openai-codex/gpt-5.3-codex",
      config: current,
      updateConfigFn: async (mutator) => {
        current = mutator(current);
        return current;
      },
      resolveReadiness: async () => readyReadiness("openai-codex/gpt-5.3-codex"),
    });

    expect(result.defaultModel).toBe("openai-codex/gpt-5.3-codex");
    expect(result.readiness.defaultModel).toBe("openai-codex/gpt-5.3-codex");
    expect(current.agents?.defaults?.model).toMatchObject({
      primary: "openai-codex/gpt-5.3-codex",
    });
    expect(current.agents?.defaults?.models?.["openai-codex/gpt-5.3-codex"]).toEqual({});
  });
});
