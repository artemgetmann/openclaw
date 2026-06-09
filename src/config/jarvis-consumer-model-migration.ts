export const JARVIS_CONSUMER_LEGACY_CODEX_MODEL = "openai-codex/gpt-5.4";
export const JARVIS_CONSUMER_CURRENT_CODEX_MODEL = "openai-codex/gpt-5.5";
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
  const hasLegacyCodex =
    primary === JARVIS_CONSUMER_LEGACY_CODEX_MODEL ||
    hasJarvisConsumerModel(root, JARVIS_CONSUMER_LEGACY_CODEX_MODEL);
  const needsCodexDefault =
    hasLegacyCodex && !hasJarvisConsumerModel(root, JARVIS_CONSUMER_CURRENT_CODEX_MODEL);
  const needsClaudeCli =
    hasJarvisConsumerClaudeCliAuth(root) &&
    !hasJarvisConsumerModel(root, JARVIS_CONSUMER_CLAUDE_CLI_MODEL);
  const needsAnthropic =
    hasJarvisConsumerAnthropicAuth(root) &&
    !hasJarvisConsumerModel(root, JARVIS_CONSUMER_ANTHROPIC_SONNET_MODEL);

  return needsCodexDefault || needsClaudeCli || needsAnthropic;
}
