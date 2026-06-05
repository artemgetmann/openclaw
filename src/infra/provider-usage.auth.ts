import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  dedupeProfileIds,
  ensureAuthProfileStore,
  listProfilesForProvider,
  resolveApiKeyForProfile,
  resolveAuthProfileOrder,
} from "../agents/auth-profiles.js";
import { isNonSecretApiKeyMarker } from "../agents/model-auth-markers.js";
import { resolveUsableCustomProviderApiKey } from "../agents/model-auth.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import { loadConfig, type OpenClawConfig } from "../config/config.js";
import { resolveProviderUsageAuthWithPlugin } from "../plugins/provider-runtime.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";
import { resolveRequiredHomeDir } from "./home-dir.js";
import type { UsageProviderId } from "./provider-usage.types.js";

export type ProviderAuth = {
  provider: UsageProviderId;
  token: string;
  accountId?: string;
};

type AuthStore = ReturnType<typeof ensureAuthProfileStore>;

type UsageAuthState = {
  cfg: OpenClawConfig;
  store: AuthStore;
  env: NodeJS.ProcessEnv;
  agentDir?: string;
};

function resolveProviderApiKeyFromConfigAndStore(params: {
  state: UsageAuthState;
  providerIds: string[];
  envDirect?: Array<string | undefined>;
}): string | undefined {
  const envDirect = params.envDirect?.map(normalizeSecretInput).find(Boolean);
  if (envDirect) {
    return envDirect;
  }

  for (const providerId of params.providerIds) {
    const key = resolveUsableCustomProviderApiKey({
      cfg: params.state.cfg,
      provider: providerId,
    })?.apiKey;
    if (key) {
      return key;
    }
  }

  const normalizedProviderIds = new Set(
    params.providerIds.map((providerId) => normalizeProviderId(providerId)).filter(Boolean),
  );
  const cred = [...normalizedProviderIds]
    .flatMap((providerId) => listProfilesForProvider(params.state.store, providerId))
    .map((id) => params.state.store.profiles[id])
    .find(
      (
        profile,
      ): profile is
        | { type: "api_key"; provider: string; key: string }
        | { type: "token"; provider: string; token: string } =>
        profile?.type === "api_key" || profile?.type === "token",
    );
  if (!cred) {
    return undefined;
  }
  if (cred.type === "api_key") {
    const key = normalizeSecretInput(cred.key);
    if (key && !isNonSecretApiKeyMarker(key)) {
      return key;
    }
    return undefined;
  }
  const token = normalizeSecretInput(cred.token);
  if (token && !isNonSecretApiKeyMarker(token)) {
    return token;
  }
  return undefined;
}

async function resolveOAuthToken(params: {
  state: UsageAuthState;
  provider: UsageProviderId;
}): Promise<ProviderAuth | null> {
  const order = resolveAuthProfileOrder({
    cfg: params.state.cfg,
    store: params.state.store,
    provider: params.provider,
  });
  const deduped = dedupeProfileIds(order);

  for (const profileId of deduped) {
    const cred = params.state.store.profiles[profileId];
    if (!cred || (cred.type !== "oauth" && cred.type !== "token")) {
      continue;
    }
    try {
      const resolved = await resolveApiKeyForProfile({
        // Usage snapshots should work even if config profile metadata is stale.
        // (e.g. config says api_key but the store has a token profile.)
        cfg: undefined,
        store: params.state.store,
        profileId,
        agentDir: params.state.agentDir,
      });
      if (!resolved) {
        continue;
      }
      return {
        provider: params.provider,
        token: resolved.apiKey,
        accountId:
          cred.type === "oauth" && "accountId" in cred
            ? (cred as { accountId?: string }).accountId
            : undefined,
      };
    } catch {
      // ignore
    }
  }

  return null;
}

async function resolveProviderUsageAuthViaPlugin(params: {
  state: UsageAuthState;
  provider: UsageProviderId;
}): Promise<ProviderAuth | null> {
  const resolved = await resolveProviderUsageAuthWithPlugin({
    provider: params.provider,
    config: params.state.cfg,
    env: params.state.env,
    context: {
      config: params.state.cfg,
      agentDir: params.state.agentDir,
      env: params.state.env,
      provider: params.provider,
      resolveApiKeyFromConfigAndStore: (options) =>
        resolveProviderApiKeyFromConfigAndStore({
          state: params.state,
          providerIds: options?.providerIds ?? [params.provider],
          envDirect: options?.envDirect,
        }),
      resolveOAuthToken: async () => {
        const auth = await resolveOAuthToken({
          state: params.state,
          provider: params.provider,
        });
        return auth
          ? {
              token: auth.token,
              ...(auth.accountId ? { accountId: auth.accountId } : {}),
            }
          : null;
      },
    },
  });
  if (!resolved?.token) {
    return null;
  }
  return {
    provider: params.provider,
    token: resolved.token,
    ...(resolved.accountId ? { accountId: resolved.accountId } : {}),
  };
}

function resolveLegacyZaiUsageToken(env: NodeJS.ProcessEnv): string | undefined {
  try {
    const authPath = path.join(
      resolveRequiredHomeDir(env, os.homedir),
      ".pi",
      "agent",
      "auth.json",
    );
    if (!fs.existsSync(authPath)) {
      return undefined;
    }
    const parsed = JSON.parse(fs.readFileSync(authPath, "utf8")) as Record<
      string,
      { access?: string }
    >;
    return normalizeSecretInput(parsed["z-ai"]?.access || parsed.zai?.access);
  } catch {
    return undefined;
  }
}

function parseGoogleGeminiCliUsageToken(token: string): string {
  try {
    const parsed = JSON.parse(token) as { token?: unknown };
    if (typeof parsed.token === "string" && parsed.token.trim()) {
      return parsed.token;
    }
  } catch {
    // Raw OAuth token profile payloads are still valid.
  }
  return token;
}

function resolveSimpleBuiltInProviderUsageAuth(params: {
  state: UsageAuthState;
  provider: UsageProviderId;
}): ProviderAuth | null | undefined {
  if (params.provider === "minimax") {
    const token = resolveProviderApiKeyFromConfigAndStore({
      state: params.state,
      providerIds: ["minimax", "minimax-cn"],
      envDirect: [params.state.env.MINIMAX_CODE_PLAN_KEY, params.state.env.MINIMAX_API_KEY],
    });
    return token ? { provider: "minimax", token } : null;
  }

  if (params.provider === "xiaomi") {
    const token = resolveProviderApiKeyFromConfigAndStore({
      state: params.state,
      providerIds: ["xiaomi"],
      envDirect: [params.state.env.XIAOMI_API_KEY],
    });
    return token ? { provider: "xiaomi", token } : null;
  }

  if (params.provider === "zai") {
    const token =
      resolveProviderApiKeyFromConfigAndStore({
        state: params.state,
        providerIds: ["zai", "z-ai"],
        envDirect: [params.state.env.ZAI_API_KEY, params.state.env.Z_AI_API_KEY],
      }) ?? resolveLegacyZaiUsageToken(params.state.env);
    return token ? { provider: "zai", token } : null;
  }

  return undefined;
}

async function resolveBuiltInOAuthProviderUsageAuth(params: {
  state: UsageAuthState;
  provider: UsageProviderId;
}): Promise<ProviderAuth | null | undefined> {
  if (
    params.provider !== "anthropic" &&
    params.provider !== "github-copilot" &&
    params.provider !== "google-gemini-cli" &&
    params.provider !== "openai-codex"
  ) {
    return undefined;
  }

  const auth = await resolveOAuthToken({
    state: params.state,
    provider: params.provider,
  });
  if (!auth) {
    return null;
  }
  if (params.provider === "google-gemini-cli") {
    return {
      ...auth,
      token: parseGoogleGeminiCliUsageToken(auth.token),
    };
  }
  return auth;
}

export async function resolveProviderAuths(params: {
  providers: UsageProviderId[];
  auth?: ProviderAuth[];
  agentDir?: string;
}): Promise<ProviderAuth[]> {
  if (params.auth) {
    return params.auth;
  }

  const state: UsageAuthState = {
    cfg: loadConfig(),
    store: ensureAuthProfileStore(params.agentDir, {
      allowKeychainPrompt: false,
    }),
    env: process.env,
    agentDir: params.agentDir,
  };
  const auths: ProviderAuth[] = [];

  for (const provider of params.providers) {
    const builtInAuth = resolveSimpleBuiltInProviderUsageAuth({
      state,
      provider,
    });
    if (builtInAuth) {
      auths.push(builtInAuth);
      continue;
    }
    if (builtInAuth === null) {
      continue;
    }

    const builtInOAuthAuth = await resolveBuiltInOAuthProviderUsageAuth({
      state,
      provider,
    });
    if (builtInOAuthAuth) {
      auths.push(builtInOAuthAuth);
      continue;
    }
    if (builtInOAuthAuth === null) {
      continue;
    }

    const pluginAuth = await resolveProviderUsageAuthViaPlugin({
      state,
      provider,
    });
    if (pluginAuth) {
      auths.push(pluginAuth);
    }
  }

  return auths;
}
