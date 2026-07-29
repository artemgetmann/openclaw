export const JARVIS_CONSUMER_LEGACY_CODEX_MODEL = "openai-codex/gpt-5.4";
export const JARVIS_CONSUMER_PREVIOUS_CODEX_MODEL = "openai-codex/gpt-5.5";
export const JARVIS_CONSUMER_CURRENT_CODEX_MODEL = "openai-codex/gpt-5.6-sol";
export const JARVIS_CONSUMER_CODEX_FALLBACK_MODEL = JARVIS_CONSUMER_PREVIOUS_CODEX_MODEL;
export const JARVIS_CONSUMER_LEGACY_CODEX_MODELS = [
  JARVIS_CONSUMER_LEGACY_CODEX_MODEL,
  JARVIS_CONSUMER_PREVIOUS_CODEX_MODEL,
] as const;
export const JARVIS_CONSUMER_LEGACY_OPENAI_MODELS = ["openai/gpt-5.4", "openai/gpt-5.5"] as const;
export const JARVIS_CONSUMER_CURRENT_OPENAI_MODEL = "openai/gpt-5.6-sol";
export const JARVIS_CONSUMER_CLAUDE_CLI_MODEL = "claude-cli/sonnet";
export const JARVIS_CONSUMER_ANTHROPIC_SONNET_MODEL = "anthropic/claude-sonnet-4-6";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getRecord(value: unknown): UnknownRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function hasOwn(record: UnknownRecord | undefined, key: string): boolean {
  return Boolean(record && Object.prototype.hasOwnProperty.call(record, key));
}

function needsLegacyGptAliasTransfer(
  root: UnknownRecord,
  modelIds: readonly string[],
  targetModelId: string,
): boolean {
  const models = getRecord(getJarvisConsumerAgentsDefaults(root)?.models);
  const targetAlias = readString(getRecord(models?.[targetModelId])?.alias)?.toLowerCase();
  if (targetAlias && targetAlias !== "gpt") {
    return false;
  }
  return modelIds.some((modelId) => {
    const alias = readString(getRecord(models?.[modelId])?.alias);
    return alias?.toLowerCase() === "gpt";
  });
}

export function getJarvisConsumerAgentsDefaults(root: UnknownRecord): UnknownRecord | undefined {
  return getRecord(getRecord(root.agents)?.defaults);
}

export function getJarvisConsumerPrimaryModel(root: UnknownRecord): string | undefined {
  const defaults = getJarvisConsumerAgentsDefaults(root);
  const model = defaults?.model;
  if (typeof model === "string") {
    return model.trim();
  }
  return readString(getRecord(model)?.primary);
}

export function hasJarvisConsumerModel(root: UnknownRecord, key: string): boolean {
  return hasOwn(getRecord(getJarvisConsumerAgentsDefaults(root)?.models), key);
}

export function shouldMigrateJarvisConsumerCodexFallback(root: UnknownRecord): boolean {
  if (!isJarvisConsumerConfig(root)) {
    return false;
  }
  const primary = getJarvisConsumerPrimaryModel(root);
  const willUseCurrentCodex =
    primary === JARVIS_CONSUMER_CURRENT_CODEX_MODEL ||
    JARVIS_CONSUMER_LEGACY_CODEX_MODELS.some((model) => primary === model);
  if (!willUseCurrentCodex) {
    return false;
  }

  const model = getRecord(getJarvisConsumerAgentsDefaults(root)?.model);
  if (!model || !hasOwn(model, "fallbacks")) {
    // Managed defaults created before fallback policy existed should gain the
    // safe previous-generation model automatically.
    return true;
  }
  if (!Array.isArray(model.fallbacks) || model.fallbacks.length === 0) {
    // An explicit empty list is an operator opt-out, not stale product state.
    return false;
  }
  return model.fallbacks.some((fallback) => fallback === JARVIS_CONSUMER_LEGACY_CODEX_MODEL);
}

export function isJarvisConsumerConfig(root: UnknownRecord): boolean {
  const jarvis = getRecord(root.jarvis);
  if (!jarvis) {
    return false;
  }

  const managedServices = getRecord(jarvis.managedServices);
  const mode = readString(managedServices?.mode)?.toLowerCase();
  if (mode === "managed" || mode === "license-only") {
    return true;
  }

  // Consumer installs always have Jarvis backend metadata once activation ran.
  // Requiring a jarvis.* marker keeps this migration out of regular OpenClaw configs.
  return Boolean(getRecord(jarvis.backend));
}

function getAuthConfig(root: UnknownRecord): UnknownRecord | undefined {
  return getRecord(root.auth);
}

function getAuthProfiles(root: UnknownRecord): UnknownRecord | undefined {
  return getRecord(getAuthConfig(root)?.profiles);
}

function getAuthOrder(root: UnknownRecord): UnknownRecord | undefined {
  return getRecord(getAuthConfig(root)?.order);
}

function hasOrderedAuthProvider(root: UnknownRecord, provider: string): boolean {
  const value = getAuthOrder(root)?.[provider];
  return Array.isArray(value) && value.length > 0;
}

function hasProfileProvider(root: UnknownRecord, provider: string): boolean {
  const profiles = getAuthProfiles(root);
  if (!profiles) {
    return false;
  }
  return Object.values(profiles).some((profile) => getRecord(profile)?.provider === provider);
}

export function hasJarvisConsumerAnthropicAuth(root: UnknownRecord): boolean {
  return hasProfileProvider(root, "anthropic") || hasOrderedAuthProvider(root, "anthropic");
}

export function hasJarvisConsumerClaudeCliAuth(root: UnknownRecord): boolean {
  if (hasProfileProvider(root, "claude-cli") || hasOrderedAuthProvider(root, "claude-cli")) {
    return true;
  }

  const profiles = getAuthProfiles(root);
  if (!profiles) {
    return false;
  }

  return Object.entries(profiles).some(([profileId, profile]) => {
    const provider = readString(getRecord(profile)?.provider);
    return profileId.includes("claude-cli") || provider === "claude-cli";
  });
}

export function shouldMigrateJarvisConsumerModelDefaults(root: UnknownRecord): boolean {
  if (!isJarvisConsumerConfig(root)) {
    return false;
  }

  const primary = getJarvisConsumerPrimaryModel(root);
  const hasLegacyCodex = JARVIS_CONSUMER_LEGACY_CODEX_MODELS.some(
    (model) => primary === model || hasJarvisConsumerModel(root, model),
  );
  const needsCodexDefault =
    hasLegacyCodex && !hasJarvisConsumerModel(root, JARVIS_CONSUMER_CURRENT_CODEX_MODEL);
  const hasLegacyOpenAI = JARVIS_CONSUMER_LEGACY_OPENAI_MODELS.some(
    (model) => primary === model || hasJarvisConsumerModel(root, model),
  );
  const needsOpenAIDefault =
    hasLegacyOpenAI && !hasJarvisConsumerModel(root, JARVIS_CONSUMER_CURRENT_OPENAI_MODEL);
  const needsPrimaryPromotion =
    JARVIS_CONSUMER_LEGACY_CODEX_MODELS.some((model) => primary === model) ||
    JARVIS_CONSUMER_LEGACY_OPENAI_MODELS.some((model) => primary === model);
  const needsAliasTransfer =
    needsLegacyGptAliasTransfer(
      root,
      JARVIS_CONSUMER_LEGACY_CODEX_MODELS,
      JARVIS_CONSUMER_CURRENT_CODEX_MODEL,
    ) ||
    needsLegacyGptAliasTransfer(
      root,
      JARVIS_CONSUMER_LEGACY_OPENAI_MODELS,
      JARVIS_CONSUMER_CURRENT_OPENAI_MODEL,
    );
  const needsClaudeCli =
    hasJarvisConsumerClaudeCliAuth(root) &&
    !hasJarvisConsumerModel(root, JARVIS_CONSUMER_CLAUDE_CLI_MODEL);
  const needsAnthropic =
    hasJarvisConsumerAnthropicAuth(root) &&
    !hasJarvisConsumerModel(root, JARVIS_CONSUMER_ANTHROPIC_SONNET_MODEL);
  const needsCodexFallback = shouldMigrateJarvisConsumerCodexFallback(root);

  return (
    needsCodexDefault ||
    needsOpenAIDefault ||
    needsPrimaryPromotion ||
    needsAliasTransfer ||
    needsClaudeCli ||
    needsAnthropic ||
    needsCodexFallback
  );
}
