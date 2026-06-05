import type { OpenClawConfig } from "../config/config.js";

type ConfigModelEntry = { id?: string; contextWindow?: number };
type ProviderConfigEntry = { models?: ConfigModelEntry[] };
type ModelsConfig = { providers?: Record<string, ProviderConfigEntry | undefined> };
type AgentModelEntry = { params?: Record<string, unknown> };

const ANTHROPIC_1M_MODEL_PREFIXES = ["claude-opus-4", "claude-sonnet-4"] as const;
export const ANTHROPIC_CONTEXT_1M_TOKENS = 1_048_576;
export const OPENAI_CODEX_GPT_5_5_EFFECTIVE_CONTEXT_TOKENS = 258_400;

function normalizeContextProviderId(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "z.ai" || normalized === "z-ai") {
    return "zai";
  }
  if (normalized === "opencode-zen") {
    return "opencode";
  }
  if (normalized === "opencode-go-auth") {
    return "opencode-go";
  }
  if (normalized === "qwen") {
    return "qwen-portal";
  }
  if (normalized === "kimi-code") {
    return "kimi-coding";
  }
  if (normalized === "bedrock" || normalized === "aws-bedrock") {
    return "amazon-bedrock";
  }
  if (normalized === "bytedance" || normalized === "doubao") {
    return "volcengine";
  }
  return normalized;
}

function resolveConfiguredModelParams(
  cfg: OpenClawConfig | undefined,
  provider: string,
  model: string,
): Record<string, unknown> | undefined {
  const models = cfg?.agents?.defaults?.models;
  if (!models) {
    return undefined;
  }
  const key = `${provider}/${model}`.trim().toLowerCase();
  for (const [rawKey, entry] of Object.entries(models)) {
    if (rawKey.trim().toLowerCase() === key) {
      const params = (entry as AgentModelEntry | undefined)?.params;
      return params && typeof params === "object" ? params : undefined;
    }
  }
  return undefined;
}

export function resolveProviderModelRef(params: {
  provider?: string;
  model?: string;
}): { provider: string; model: string } | undefined {
  const modelRaw = params.model?.trim();
  if (!modelRaw) {
    return undefined;
  }
  const providerRaw = params.provider?.trim();
  if (providerRaw) {
    // Preserve the exact provider key for config lookup; callers normalize only
    // where alias expansion is intentionally part of the matching behavior.
    return { provider: providerRaw.toLowerCase(), model: modelRaw };
  }
  const slash = modelRaw.indexOf("/");
  if (slash <= 0) {
    return undefined;
  }
  const provider = normalizeContextProviderId(modelRaw.slice(0, slash));
  const model = modelRaw.slice(slash + 1).trim();
  if (!provider || !model) {
    return undefined;
  }
  return { provider, model };
}

// Resolve explicit provider metadata directly from config. This intentionally
// does not touch model-discovery cache state, so startup-sensitive status paths
// can report known effective windows without loading the heavy model runtime.
function resolveConfiguredProviderContextWindow(
  cfg: OpenClawConfig | undefined,
  provider: string,
  model: string,
): number | undefined {
  const providers = (cfg?.models as ModelsConfig | undefined)?.providers;
  if (!providers) {
    return undefined;
  }

  function findContextWindow(matchProviderId: (id: string) => boolean): number | undefined {
    for (const [providerId, providerConfig] of Object.entries(providers!)) {
      if (!matchProviderId(providerId) || !Array.isArray(providerConfig?.models)) {
        continue;
      }
      for (const m of providerConfig.models) {
        if (
          typeof m?.id === "string" &&
          m.id === model &&
          typeof m?.contextWindow === "number" &&
          m.contextWindow > 0
        ) {
          return m.contextWindow;
        }
      }
    }
    return undefined;
  }

  const exactResult = findContextWindow((id) => id.trim().toLowerCase() === provider.toLowerCase());
  if (exactResult !== undefined) {
    return exactResult;
  }

  const normalizedProvider = normalizeContextProviderId(provider);
  return findContextWindow((id) => normalizeContextProviderId(id) === normalizedProvider);
}

function isAnthropic1MModel(provider: string, model: string): boolean {
  if (provider !== "anthropic") {
    return false;
  }
  const normalized = model.trim().toLowerCase();
  const modelId = normalized.includes("/")
    ? (normalized.split("/").at(-1) ?? normalized)
    : normalized;
  return ANTHROPIC_1M_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix));
}

function isClaudeCode1MModel(provider: string, model: string): boolean {
  const normalizedProvider = normalizeContextProviderId(provider);
  if (normalizedProvider !== "claude-cli" && normalizedProvider !== "claude-bridge") {
    return false;
  }
  const normalizedModel = model.trim().toLowerCase();
  return normalizedModel.endsWith("[1m]");
}

function resolveEffectiveContextTokensForModel(
  provider: string,
  model: string,
): number | undefined {
  const normalizedProvider = normalizeContextProviderId(provider);
  const normalizedModel = model.trim().toLowerCase();

  // ChatGPT-backed Codex reports a larger catalog/native window than the prompt
  // budget the Codex CLI actually exposes. Jarvis preflight needs the effective
  // usable window so it compacts before sending an oversized prompt.
  if (normalizedProvider === "openai-codex" && normalizedModel === "gpt-5.5") {
    return OPENAI_CODEX_GPT_5_5_EFFECTIVE_CONTEXT_TOKENS;
  }

  return undefined;
}

export function resolveDeterministicContextTokensForModel(params: {
  cfg?: OpenClawConfig;
  provider?: string;
  model?: string;
  contextTokensOverride?: number;
  fallbackContextTokens?: number;
}): number | undefined {
  if (typeof params.contextTokensOverride === "number" && params.contextTokensOverride > 0) {
    return params.contextTokensOverride;
  }

  const ref = resolveProviderModelRef({
    provider: params.provider,
    model: params.model,
  });
  if (ref) {
    const modelParams = resolveConfiguredModelParams(params.cfg, ref.provider, ref.model);
    if (modelParams?.context1m === true && isAnthropic1MModel(ref.provider, ref.model)) {
      return ANTHROPIC_CONTEXT_1M_TOKENS;
    }
    if (isClaudeCode1MModel(ref.provider, ref.model)) {
      return ANTHROPIC_CONTEXT_1M_TOKENS;
    }
    const effectiveContextTokens = resolveEffectiveContextTokensForModel(ref.provider, ref.model);
    if (effectiveContextTokens !== undefined) {
      return effectiveContextTokens;
    }
    if (params.provider) {
      const configuredWindow = resolveConfiguredProviderContextWindow(
        params.cfg,
        ref.provider,
        ref.model,
      );
      if (configuredWindow !== undefined) {
        return configuredWindow;
      }
    }
  }

  return params.fallbackContextTokens;
}
