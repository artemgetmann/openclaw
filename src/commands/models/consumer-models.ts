import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { loadModelCatalog } from "../../agents/model-catalog.js";
import { modelKey, parseModelRef } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import { resolveModelsReadiness, type ModelsReadinessResult } from "./readiness.js";
import { applyDefaultModelPrimaryUpdate, loadValidConfigOrThrow, updateConfig } from "./shared.js";

type ConsumerModelFamily = "openai-codex" | "openai" | "anthropic";

type ConsumerModelDefinition = {
  id: string;
  title: string;
  detail: string;
  family: ConsumerModelFamily;
};

export type ConsumerModelOption = {
  id: string;
  title: string;
  detail: string;
};

export type ConsumerModelListResult = {
  currentModel?: string;
  options: ConsumerModelOption[];
};

export type ApplyConsumerModelParams = {
  model: string;
  config?: OpenClawConfig;
  resolveReadiness?: () => Promise<ModelsReadinessResult>;
  loadConfigFn?: () => Promise<OpenClawConfig>;
  updateConfigFn?: (
    mutator: (cfg: OpenClawConfig) => OpenClawConfig,
    options?: { expectedConfigPath?: string },
  ) => Promise<OpenClawConfig>;
};

export type ApplyConsumerModelResult = {
  defaultModel: string;
  readiness: ModelsReadinessResult;
};

const CONSUMER_MODEL_SHORTLIST: readonly ConsumerModelDefinition[] = [
  {
    id: "openai-codex/gpt-5.4",
    title: "GPT-5.4",
    detail: "Default ChatGPT / Codex path for early testers.",
    family: "openai-codex",
  },
  {
    id: "openai-codex/gpt-5.3-codex",
    title: "GPT-5.3-Codex",
    detail: "Codex-focused model for coding-heavy work.",
    family: "openai-codex",
  },
  {
    id: "openai-codex/gpt-5.3-codex-spark",
    title: "GPT-5.3-Codex-Spark",
    detail: "Faster Codex variant when the OAuth catalog exposes Spark.",
    family: "openai-codex",
  },
  {
    id: "openai-codex/gpt-5.1-codex",
    title: "GPT-5.1-Codex",
    detail: "Older Codex option kept for runtimes that still expose the 5.1 track.",
    family: "openai-codex",
  },
  {
    id: "openai-codex/gpt-5.1-codex-mini",
    title: "GPT-5.1-Codex-Mini",
    detail: "Smaller Codex option, shown only when the runtime catalog actually exposes it.",
    family: "openai-codex",
  },
  {
    id: "openai/gpt-5.4",
    title: "GPT-5.4",
    detail: "Direct OpenAI API path when you are using an API key.",
    family: "openai",
  },
  {
    id: "openai/gpt-5.4-pro",
    title: "GPT-5.4 Pro",
    detail: "Higher-capability OpenAI API option when you want the strongest direct model.",
    family: "openai",
  },
  {
    id: "openai/gpt-5-mini",
    title: "GPT-5 Mini",
    detail: "Smaller OpenAI API option when you want lower latency and cost.",
    family: "openai",
  },
  {
    id: "anthropic/claude-sonnet-4-6",
    title: "Claude Sonnet 4.6",
    detail: "Balanced Claude default for day-to-day use.",
    family: "anthropic",
  },
  {
    id: "anthropic/claude-opus-4-6",
    title: "Claude Opus 4.6",
    detail: "Higher-end Claude model when you want the strongest option.",
    family: "anthropic",
  },
  {
    id: "anthropic/claude-haiku-4-5",
    title: "Claude Haiku 4.5",
    detail: "Fast Claude option when you want lighter cost and latency.",
    family: "anthropic",
  },
] as const;

function resolveCurrentModel(cfg: OpenClawConfig): string | undefined {
  const raw = resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)?.trim();
  return raw ? raw : undefined;
}

function resolveConsumerModelFamily(modelRef?: string): ConsumerModelFamily | undefined {
  const parsed = modelRef ? parseModelRef(modelRef, DEFAULT_PROVIDER) : null;
  switch (parsed?.provider) {
    case "openai-codex":
      return "openai-codex";
    case "openai":
      return "openai";
    case "anthropic":
      return "anthropic";
    default:
      return undefined;
  }
}

async function resolveConsumerModelOptions(params: {
  config: OpenClawConfig;
}): Promise<ConsumerModelListResult> {
  const currentModel = resolveCurrentModel(params.config);
  const family = resolveConsumerModelFamily(currentModel);
  if (!family) {
    return { currentModel, options: [] };
  }

  const catalog = await loadModelCatalog({
    config: params.config,
    useCache: false,
  });
  // The picker is intentionally narrower than the full catalog, but it must not
  // inherit the current config allowlist. Otherwise a fresh auth flow looks
  // broken because only the already-selected model survives.
  const availableKeys = new Set(catalog.map((entry) => modelKey(entry.provider, entry.id)));

  // Keep the consumer picker deliberately tiny and provider-scoped. The app
  // should only expose models that match the currently working credential path.
  const options = CONSUMER_MODEL_SHORTLIST.filter(
    (entry) => entry.family == family && availableKeys.has(entry.id),
  ).map((entry) => ({
    id: entry.id,
    title: entry.title,
    detail: entry.detail,
  }));

  return {
    currentModel,
    options,
  };
}

export async function listConsumerModelOptions(
  params: {
    config?: OpenClawConfig;
    loadConfigFn?: () => Promise<OpenClawConfig>;
  } = {},
): Promise<ConsumerModelListResult> {
  const cfg = params.config ?? (await (params.loadConfigFn ?? loadValidConfigOrThrow)());
  return resolveConsumerModelOptions({ config: cfg });
}

export async function applyConsumerModel(
  params: ApplyConsumerModelParams,
): Promise<ApplyConsumerModelResult> {
  const nextModel = params.model.trim();
  if (!nextModel) {
    throw new Error("Choose a model before continuing.");
  }

  const loadConfigFn = params.loadConfigFn ?? loadValidConfigOrThrow;
  const cfg = params.config ?? (await loadConfigFn());
  const options = await resolveConsumerModelOptions({ config: cfg });
  if (!options.options.some((entry) => entry.id === nextModel)) {
    throw new Error(`Model "${nextModel}" is not available for the current consumer auth path.`);
  }

  const updateConfigFn = params.updateConfigFn ?? updateConfig;
  const updated = await updateConfigFn((current) =>
    applyDefaultModelPrimaryUpdate({
      cfg: current,
      modelRaw: nextModel,
      field: "model",
    }),
  );
  const defaultModel = resolveCurrentModel(updated) ?? nextModel;

  return {
    defaultModel,
    readiness: await (params.resolveReadiness ?? resolveModelsReadiness)(),
  };
}
