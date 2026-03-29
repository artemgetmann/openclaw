import {
  resolveDefaultAgentId,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
} from "../../agents/agent-scope.js";
import {
  CLAUDE_CLI_PROFILE_ID,
  clearAuthProfileCooldown,
  dedupeProfileIds,
  ensureAuthProfileStore,
  listProfilesForProvider,
  loadAuthProfileStoreForRuntime,
  resolveAuthProfileOrder,
  upsertAuthProfile,
} from "../../agents/auth-profiles.js";
import {
  readClaudeCliCredentialsCached,
  type ClaudeCliCredential,
} from "../../agents/cli-credentials.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveProviderPluginChoice } from "../../plugins/provider-wizard.js";
import { resolvePluginProviders } from "../../plugins/providers.js";
import type { ProviderAuthResult, ProviderPlugin } from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import type {
  WizardConfirmParams,
  WizardMultiSelectParams,
  WizardProgress,
  WizardPrompter,
  WizardSelectParams,
  WizardTextParams,
} from "../../wizard/prompts.js";
import { createVpsAwareOAuthHandlers } from "../oauth-flow.js";
import { applyAuthProfileConfig } from "../onboard-auth.js";
import { openUrl } from "../onboard-helpers.js";
import { applyDefaultModel, mergeConfigPatch } from "../provider-auth-helpers.js";
import { resolveModelsReadiness, type ModelsReadinessResult } from "./readiness.js";
import { loadValidConfigOrThrow, updateConfig } from "./shared.js";

type ConsumerAuthProviderId =
  | "openai-codex"
  | "openai"
  | "anthropic"
  | "google"
  | "minimax"
  | "moonshot";

type ConsumerAuthChoiceDefinition = {
  id: string;
  authChoice: string;
  providerId: string;
  methodId: string;
  source?: "plugin" | "claude_cli";
  providerGroupId: ConsumerAuthProviderId;
  providerLabel: string;
  providerDescription: string;
  methodLabel: string;
  methodDescription: string;
  kind: "oauth" | "device_code" | "token" | "api_key";
  defaultModel: string;
  credentialLabel?: string;
  credentialHelp?: string;
  credentialPlaceholder?: string;
};

export type ConsumerAuthOption = {
  id: string;
  providerId: string;
  providerLabel: string;
  title: string;
  detail: string;
  inputKind: "none" | "api_key" | "token";
  submitLabel: string;
  inputLabel?: string;
  inputHelp?: string;
  inputPlaceholder?: string;
  methodKind: ConsumerAuthChoiceDefinition["kind"];
};

export type ApplyConsumerAuthParams = {
  optionId: string;
  secret?: string;
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  providers?: ProviderPlugin[];
  runtime?: RuntimeEnv;
  resolveReadiness?: () => Promise<ModelsReadinessResult>;
  openUrl?: (url: string) => Promise<boolean | void>;
  readClaudeCliCredential?: ClaudeCliCredentialReader;
};

export type ApplyConsumerAuthResult = {
  optionId: string;
  providerId: string;
  methodId: string;
  defaultModel?: string;
  profileIds: string[];
  notes: string[];
  readiness: ModelsReadinessResult;
};

type ClaudeCliCredentialReader = (options?: {
  allowKeychainPrompt?: boolean;
  ttlMs?: number;
  platform?: NodeJS.Platform;
  homeDir?: string;
}) => ClaudeCliCredential | null;

const CONSUMER_AUTH_CHOICES: readonly ConsumerAuthChoiceDefinition[] = [
  {
    id: "openai-codex-oauth",
    authChoice: "openai-codex",
    providerId: "openai-codex",
    methodId: "oauth",
    providerGroupId: "openai-codex",
    providerLabel: "ChatGPT / Codex",
    providerDescription: "Use your ChatGPT subscription for the built-in Codex path.",
    methodLabel: "Continue with ChatGPT",
    methodDescription: "Use your ChatGPT subscription. Best early-tester path for coding tasks.",
    kind: "oauth",
    defaultModel: "openai-codex/gpt-5.4",
  },
  {
    id: "anthropic-claude-cli",
    authChoice: "claude-cli",
    providerId: "anthropic",
    methodId: "claude-cli",
    source: "claude_cli",
    providerGroupId: "anthropic",
    providerLabel: "Claude",
    providerDescription: "Use your Claude subscription without pasting an API key.",
    methodLabel: "Continue with Claude",
    methodDescription:
      "Reuses the Claude sign-in already available on this Mac. Best path when Claude Code is already signed in.",
    kind: "oauth",
    defaultModel: "anthropic/claude-sonnet-4-6",
  },
  {
    id: "anthropic-setup-token",
    authChoice: "token",
    providerId: "anthropic",
    methodId: "setup-token",
    providerGroupId: "anthropic",
    providerLabel: "Claude setup-token",
    providerDescription:
      "Use your Claude subscription via a setup token, or bring an Anthropic API key.",
    methodLabel: "Paste Claude setup token",
    methodDescription:
      "Use your Claude subscription. Run `claude setup-token`, then paste the token here.",
    kind: "token",
    defaultModel: "anthropic/claude-sonnet-4-6",
    credentialLabel: "Anthropic setup-token",
    credentialHelp: "Generate it with `claude setup-token` on any machine.",
    credentialPlaceholder: "sk-ant-...",
  },
  {
    id: "openai-api-key",
    authChoice: "openai-api-key",
    providerId: "openai",
    methodId: "api-key",
    providerGroupId: "openai",
    providerLabel: "OpenAI",
    providerDescription: "Bring your own OpenAI API key instead of using a ChatGPT subscription.",
    methodLabel: "Bring your OpenAI API key",
    methodDescription: "Use direct OpenAI API billing.",
    kind: "api_key",
    defaultModel: "openai/gpt-5.4",
    credentialLabel: "OpenAI API key",
    credentialHelp: "Paste an OpenAI API key from platform.openai.com.",
    credentialPlaceholder: "sk-...",
  },
  {
    id: "anthropic-api-key",
    authChoice: "apiKey",
    providerId: "anthropic",
    methodId: "api-key",
    providerGroupId: "anthropic",
    providerLabel: "Claude",
    providerDescription:
      "Use your Claude subscription via a setup token, or bring an Anthropic API key.",
    methodLabel: "Bring your Anthropic API key",
    methodDescription: "Use direct Anthropic API billing.",
    kind: "api_key",
    defaultModel: "anthropic/claude-sonnet-4-6",
    credentialLabel: "Anthropic API key",
    credentialHelp: "Paste an Anthropic API key from console.anthropic.com.",
    credentialPlaceholder: "sk-ant-...",
  },
  {
    id: "google-gemini-api-key",
    authChoice: "gemini-api-key",
    providerId: "google",
    methodId: "api-key",
    providerGroupId: "google",
    providerLabel: "Gemini",
    providerDescription: "Bring your own Gemini API key from Google AI Studio.",
    methodLabel: "Bring your Gemini API key",
    methodDescription: "Use Gemini API billing via Google AI Studio.",
    kind: "api_key",
    defaultModel: "google/gemini-3.1-pro-preview",
    credentialLabel: "Gemini API key",
    credentialHelp: "Paste a Gemini API key from aistudio.google.com/apikey.",
    credentialPlaceholder: "AIza...",
  },
  {
    id: "minimax-global-api",
    authChoice: "minimax-global-api",
    providerId: "minimax",
    methodId: "api-global",
    providerGroupId: "minimax",
    providerLabel: "MiniMax",
    providerDescription: "Use your MiniMax account or bring a direct API key.",
    methodLabel: "Bring your MiniMax API key",
    methodDescription: "Use the global MiniMax API endpoint.",
    kind: "api_key",
    defaultModel: "minimax/MiniMax-M2.5",
    credentialLabel: "MiniMax API key",
    credentialHelp: "Paste a global MiniMax API key from platform.minimax.io.",
    credentialPlaceholder: "sk-api-...",
  },
  {
    id: "moonshot-api-key",
    authChoice: "moonshot-api-key",
    providerId: "moonshot",
    methodId: "api-key",
    providerGroupId: "moonshot",
    providerLabel: "Kimi",
    providerDescription: "Bring your own Kimi API key from Moonshot.",
    methodLabel: "Bring your Kimi API key",
    methodDescription: "Use Moonshot API billing for Kimi models.",
    kind: "api_key",
    defaultModel: "moonshot/kimi-k2.5",
    credentialLabel: "Moonshot API key",
    credentialHelp: "Paste a Moonshot API key from platform.moonshot.ai or kimi.com.",
    credentialPlaceholder: "sk-...",
  },
] as const;

function resolveChoiceOrThrow(choiceId: string): ConsumerAuthChoiceDefinition {
  const choice = CONSUMER_AUTH_CHOICES.find((entry) => entry.id === choiceId);
  if (!choice) {
    throw new Error(`Unknown consumer auth choice "${choiceId}".`);
  }
  return choice;
}

function resolveConsumerProviderChoice(
  providers: ProviderPlugin[],
  choice: ConsumerAuthChoiceDefinition,
): {
  provider: ProviderPlugin;
  method: ProviderPlugin["auth"][number];
} | null {
  const wizardResolved = resolveProviderPluginChoice({
    providers,
    choice: choice.authChoice,
  });
  if (wizardResolved) {
    return wizardResolved;
  }

  const provider = providers.find((entry) => entry.id === choice.providerId);
  const method = provider?.auth.find((entry) => entry.id === choice.methodId);
  return provider && method ? { provider, method } : null;
}

function isClaudeCliChoiceAvailable(reader: ClaudeCliCredentialReader): boolean {
  if (process.platform === "darwin") {
    // Consumer macOS should always offer the Claude subscription lane. The
    // actual keychain check happens when the user clicks Continue so the app
    // can prompt intentionally instead of hiding the option.
    return true;
  }
  return Boolean(
    reader({
      allowKeychainPrompt: false,
      ttlMs: 0,
    }),
  );
}

function buildConsumerRuntime(notes: string[]): RuntimeEnv {
  const pushNote = (...args: unknown[]) => {
    const message = args
      .map((value) => (typeof value === "string" ? value : String(value)))
      .join(" ")
      .trim();
    if (message) {
      notes.push(message);
    }
  };
  return {
    log: (...args: unknown[]) => pushNote(...args),
    error: (...args: unknown[]) => pushNote(...args),
    exit: (code: number) => {
      throw new Error(`consumer auth exited with code ${code}`);
    },
  };
}

function buildConsumerPrompter(params: {
  choice: ConsumerAuthChoiceDefinition;
  notes: string[];
  secret?: string;
}): WizardPrompter {
  const { choice, notes, secret } = params;
  return {
    intro: async () => {},
    outro: async () => {},
    note: async (message: string, title?: string) => {
      const trimmed = message.trim();
      if (!trimmed) {
        return;
      }
      notes.push(title?.trim() ? `${title.trim()}: ${trimmed}` : trimmed);
    },
    select: async <T>(_params: WizardSelectParams<T>) => {
      throw new Error(`consumer auth does not support interactive select for ${choice.id}`);
    },
    multiselect: async <T>(_params: WizardMultiSelectParams<T>) => {
      throw new Error(`consumer auth does not support interactive multiselect for ${choice.id}`);
    },
    text: async (params: WizardTextParams) => {
      const message = params.message.trim().toLowerCase();
      if (choice.kind === "token" && message.includes("paste anthropic setup-token")) {
        const token = secret?.trim();
        if (!token) {
          throw new Error("This auth method requires a setup-token.");
        }
        return token;
      }
      if (choice.kind === "token" && message.includes("token name")) {
        // Consumer setup keeps the default name so the auth store stays boring.
        return "";
      }
      throw new Error(`consumer auth received unsupported text prompt: ${params.message}`);
    },
    confirm: async (params: WizardConfirmParams) => {
      throw new Error(`consumer auth received unsupported confirm prompt: ${params.message}`);
    },
    progress: (_label: string): WizardProgress => ({
      update: () => {},
      stop: () => {},
    }),
  };
}

function toAuthInputKind(
  kind: ConsumerAuthChoiceDefinition["kind"],
): ConsumerAuthOption["inputKind"] {
  if (kind === "api_key") {
    return "api_key";
  }
  if (kind === "token") {
    return "token";
  }
  return "none";
}

function buildFlatOptions(
  choiceDefs: readonly ConsumerAuthChoiceDefinition[],
): ConsumerAuthOption[] {
  return choiceDefs.map((choice) => ({
    id: choice.id,
    providerId: choice.providerId,
    providerLabel: choice.providerLabel,
    title: choice.methodLabel,
    detail: choice.methodDescription,
    inputKind: toAuthInputKind(choice.kind),
    submitLabel:
      choice.kind === "api_key" || choice.kind === "token" ? "Save and Check" : "Continue",
    ...(choice.credentialLabel ? { inputLabel: choice.credentialLabel } : {}),
    ...(choice.credentialHelp ? { inputHelp: choice.credentialHelp } : {}),
    ...(choice.credentialPlaceholder ? { inputPlaceholder: choice.credentialPlaceholder } : {}),
    methodKind: choice.kind,
  }));
}

async function clearStaleProfileLockouts(provider: string, agentDir: string): Promise<void> {
  try {
    const store = loadAuthProfileStoreForRuntime(agentDir);
    const profileIds = listProfilesForProvider(store, provider);
    for (const profileId of profileIds) {
      await clearAuthProfileCooldown({ store, profileId, agentDir });
    }
  } catch {
    // Re-auth should stay best-effort even if stale cooldown state is broken.
  }
}

function resolveClaudeCliCredentialOrThrow(params: {
  readCredential: ClaudeCliCredentialReader;
}): ClaudeCliCredential {
  const credential =
    params.readCredential({
      allowKeychainPrompt: process.platform === "darwin",
      ttlMs: 0,
    }) ??
    params.readCredential({
      allowKeychainPrompt: false,
      ttlMs: 0,
    });
  if (credential) {
    return credential;
  }

  if (process.platform === "darwin") {
    throw new Error(
      "No Claude subscription sign-in was found on this Mac. Sign in to Claude Code first, or use the Claude setup-token path.",
    );
  }
  throw new Error(
    "No Claude subscription sign-in was found. Sign in with Claude Code first, or use the Claude setup-token path.",
  );
}

function pinSelectedProfilesFirst(
  cfg: OpenClawConfig,
  params: {
    provider: string;
    store: ReturnType<typeof ensureAuthProfileStore>;
    selectedProfileIds: string[];
  },
): OpenClawConfig {
  const selectedProfileIds = dedupeProfileIds(params.selectedProfileIds);
  if (selectedProfileIds.length === 0) {
    return cfg;
  }

  const ordered = dedupeProfileIds([
    ...selectedProfileIds,
    ...resolveAuthProfileOrder({
      cfg,
      store: params.store,
      provider: params.provider,
    }),
  ]);

  return {
    ...cfg,
    auth: {
      ...cfg.auth,
      order: {
        ...cfg.auth?.order,
        [params.provider]: ordered,
      },
    },
  };
}

function applyProviderAuthResult(
  cfg: OpenClawConfig,
  result: ProviderAuthResult,
  fallbackDefaultModel?: string,
): {
  config: OpenClawConfig;
  selectedProfileIds: string[];
} {
  let next = cfg;
  if (result.configPatch) {
    next = mergeConfigPatch(next, result.configPatch);
  }

  const selectedProfileIds: string[] = [];
  for (const profile of result.profiles) {
    selectedProfileIds.push(profile.profileId);
    next = applyAuthProfileConfig(next, {
      profileId: profile.profileId,
      provider: profile.credential.provider,
      mode: profile.credential.type === "token" ? "token" : profile.credential.type,
      ...("email" in profile.credential && profile.credential.email
        ? { email: profile.credential.email }
        : {}),
    });
  }

  const defaultModel = result.defaultModel?.trim() || fallbackDefaultModel?.trim();
  if (defaultModel) {
    next = applyDefaultModel(next, defaultModel);
  }

  return { config: next, selectedProfileIds };
}

export async function listConsumerAuthOptions(
  params: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    providers?: ProviderPlugin[];
    readClaudeCliCredential?: ClaudeCliCredentialReader;
  } = {},
): Promise<ConsumerAuthOption[]> {
  const cfg = params.config ?? (await loadValidConfigOrThrow());
  const agentId = resolveDefaultAgentId(cfg);
  const workspaceDir =
    params.workspaceDir ??
    resolveAgentWorkspaceDir(cfg, agentId) ??
    resolveDefaultAgentWorkspaceDir();
  const providers =
    params.providers ??
    resolvePluginProviders({
      config: cfg,
      workspaceDir,
      bundledProviderAllowlistCompat: true,
      bundledProviderVitestCompat: true,
    });
  const readClaudeCliCredential = params.readClaudeCliCredential ?? readClaudeCliCredentialsCached;

  // Keep the consumer UI honest. Only surface shortlist entries whose provider
  // plugin/method still exists in this exact runtime.
  const available = CONSUMER_AUTH_CHOICES.filter((choice) => {
    if (choice.source === "claude_cli") {
      return isClaudeCliChoiceAvailable(readClaudeCliCredential);
    }
    const resolved = resolveConsumerProviderChoice(providers, choice);
    return resolved?.provider.id === choice.providerId && resolved.method.id === choice.methodId;
  });

  return buildFlatOptions(available);
}

export async function applyConsumerAuth(
  params: ApplyConsumerAuthParams,
): Promise<ApplyConsumerAuthResult> {
  const choice = resolveChoiceOrThrow(params.optionId);
  if ((choice.kind === "api_key" || choice.kind === "token") && !params.secret?.trim()) {
    throw new Error(`This sign-in method requires ${choice.credentialLabel ?? "a credential"}.`);
  }

  const cfg = params.config ?? (await loadValidConfigOrThrow());
  const agentId = resolveDefaultAgentId(cfg);
  const agentDir = params.agentDir ?? resolveAgentDir(cfg, agentId);
  const workspaceDir =
    params.workspaceDir ??
    resolveAgentWorkspaceDir(cfg, agentId) ??
    resolveDefaultAgentWorkspaceDir();
  const providers =
    params.providers ??
    resolvePluginProviders({
      config: cfg,
      workspaceDir,
      bundledProviderAllowlistCompat: true,
      bundledProviderVitestCompat: true,
    });
  const notes: string[] = [];
  const runtime = params.runtime ?? buildConsumerRuntime(notes);
  const readClaudeCliCredential = params.readClaudeCliCredential ?? readClaudeCliCredentialsCached;

  await clearStaleProfileLockouts(choice.providerId, agentDir);

  let next:
    | {
        config: OpenClawConfig;
        selectedProfileIds: string[];
      }
    | undefined;
  let notesFromProvider: string[] = [];

  if (choice.source === "claude_cli") {
    const credential = resolveClaudeCliCredentialOrThrow({
      readCredential: readClaudeCliCredential,
    });
    upsertAuthProfile({
      profileId: CLAUDE_CLI_PROFILE_ID,
      credential,
      agentDir,
    });
    notesFromProvider = [
      credential.type === "oauth"
        ? "Reused the Claude subscription sign-in already available on this Mac."
        : "Reused the Claude setup-token already available on this Mac.",
    ];
    let nextConfig = applyAuthProfileConfig(cfg, {
      profileId: CLAUDE_CLI_PROFILE_ID,
      provider: "anthropic",
      mode: credential.type === "token" ? "token" : "oauth",
    });
    nextConfig = applyDefaultModel(nextConfig, choice.defaultModel);
    next = {
      config: nextConfig,
      selectedProfileIds: [CLAUDE_CLI_PROFILE_ID],
    };
  } else {
    const resolved = resolveConsumerProviderChoice(providers, choice);
    if (
      !resolved ||
      resolved.provider.id !== choice.providerId ||
      resolved.method.id !== choice.methodId
    ) {
      throw new Error(`Consumer auth choice "${choice.id}" is not available in this runtime.`);
    }

    const prompter = buildConsumerPrompter({
      choice,
      notes,
      secret: params.secret,
    });
    const result = await resolved.method.run({
      config: cfg,
      agentDir,
      workspaceDir,
      prompter,
      runtime,
      opts:
        choice.kind === "api_key"
          ? { token: params.secret, tokenProvider: choice.providerId }
          : undefined,
      secretInputMode: "plaintext",
      allowSecretRefPrompt: false,
      isRemote: false,
      openUrl: async (url) => {
        await (params.openUrl ?? openUrl)(url);
      },
      oauth: {
        createVpsAwareHandlers: createVpsAwareOAuthHandlers,
      },
    });
    notesFromProvider = (result.notes ?? []).map((note) => note.trim()).filter(Boolean);
    if (result.profiles.length === 0) {
      throw new Error("Login did not return a usable credential.");
    }

    for (const profile of result.profiles) {
      upsertAuthProfile({
        profileId: profile.profileId,
        credential: profile.credential,
        agentDir,
      });
    }

    next = applyProviderAuthResult(cfg, result, choice.defaultModel);
  }

  notes.push(...notesFromProvider);
  const store = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
  });
  next.config = pinSelectedProfilesFirst(next.config, {
    provider: choice.providerId,
    store,
    selectedProfileIds: next.selectedProfileIds,
  });

  await updateConfig(() => next.config);
  const readiness = await (params.resolveReadiness ?? resolveModelsReadiness)();
  const defaultModel = next.config.agents?.defaults?.model?.primary?.trim() || choice.defaultModel;

  return {
    optionId: choice.id,
    providerId: choice.providerId,
    methodId: choice.methodId,
    ...(defaultModel ? { defaultModel } : {}),
    profileIds: next.selectedProfileIds,
    notes,
    readiness,
  };
}
