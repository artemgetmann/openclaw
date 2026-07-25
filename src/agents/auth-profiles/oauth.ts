import {
  getOAuthApiKey,
  getOAuthProviders,
  type OAuthCredentials,
  type OAuthProvider,
} from "@mariozechner/pi-ai/oauth";
import { loadConfig, type OpenClawConfig } from "../../config/config.js";
import { coerceSecretRef } from "../../config/types.secrets.js";
import { withFileLock } from "../../infra/file-lock.js";
import { resolveSecretRefString, type SecretRefResolveCache } from "../../secrets/resolve.js";
import { refreshChutesTokens } from "../chutes-oauth.js";
import { readCodexCliCredentials } from "../cli-credentials.js";
import { AUTH_STORE_LOCK_OPTIONS, OAUTH_REFRESH_LOCK_OPTIONS, log } from "./constants.js";
import { resolveTokenExpiryState } from "./credential-state.js";
import { formatAuthDoctorHint } from "./doctor.js";
import { ensureAuthStoreFile, resolveAuthStorePath, resolveOAuthRefreshLockPath } from "./paths.js";
import { suggestOAuthProfileIdForLegacyDefault } from "./repair.js";
import {
  ensureAuthProfileStore,
  loadAuthProfileStoreForSecretsRuntime,
  saveAuthProfileStore,
  updateAuthProfileStoreWithLock,
} from "./store.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

const OAUTH_PROVIDER_IDS = new Set<string>(getOAuthProviders().map((provider) => provider.id));

let providerRuntimePromise:
  | Promise<typeof import("../../plugins/provider-runtime.runtime.js")>
  | undefined;

function loadProviderRuntime() {
  providerRuntimePromise ??= import("../../plugins/provider-runtime.runtime.js");
  return providerRuntimePromise;
}

const isOAuthProvider = (provider: string): provider is OAuthProvider =>
  OAUTH_PROVIDER_IDS.has(provider);

const resolveOAuthProvider = (provider: string): OAuthProvider | null =>
  isOAuthProvider(provider) ? provider : null;

/** Bearer-token auth modes that are interchangeable (oauth tokens and raw tokens). */
const BEARER_AUTH_MODES = new Set(["oauth", "token"]);

const isCompatibleModeType = (mode: string | undefined, type: string | undefined): boolean => {
  if (!mode || !type) {
    return false;
  }
  if (mode === type) {
    return true;
  }
  // Both token and oauth represent bearer-token auth paths — allow bidirectional compat.
  return BEARER_AUTH_MODES.has(mode) && BEARER_AUTH_MODES.has(type);
};

function isProfileConfigCompatible(params: {
  cfg?: OpenClawConfig;
  profileId: string;
  provider: string;
  mode: "api_key" | "token" | "oauth";
  allowOAuthTokenCompatibility?: boolean;
}): boolean {
  const profileConfig = params.cfg?.auth?.profiles?.[params.profileId];
  if (profileConfig && profileConfig.provider !== params.provider) {
    return false;
  }
  if (profileConfig && !isCompatibleModeType(profileConfig.mode, params.mode)) {
    return false;
  }
  return true;
}

async function buildOAuthApiKey(provider: string, credentials: OAuthCredential): Promise<string> {
  const { formatProviderAuthProfileApiKeyWithPlugin } = await loadProviderRuntime();
  const formatted = formatProviderAuthProfileApiKeyWithPlugin({
    provider,
    context: credentials,
  });
  return typeof formatted === "string" && formatted.length > 0 ? formatted : credentials.access;
}

function buildApiKeyProfileResult(params: { apiKey: string; provider: string; email?: string }) {
  return {
    apiKey: params.apiKey,
    provider: params.provider,
    email: params.email,
  };
}

async function buildOAuthProfileResult(params: {
  provider: string;
  credentials: OAuthCredential;
  email?: string;
}) {
  return buildApiKeyProfileResult({
    apiKey: await buildOAuthApiKey(params.provider, params.credentials),
    provider: params.provider,
    email: params.email,
  });
}

function extractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ResolveApiKeyForProfileParams = {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
};

type SecretDefaults = NonNullable<OpenClawConfig["secrets"]>["defaults"];

function adoptNewerMainOAuthCredential(params: {
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
  cred: OAuthCredentials & { type: "oauth"; provider: string; email?: string };
}): (OAuthCredentials & { type: "oauth"; provider: string; email?: string }) | null {
  if (!params.agentDir) {
    return null;
  }
  try {
    const mainStore = ensureAuthProfileStore(undefined);
    const mainCred = mainStore.profiles[params.profileId];
    if (
      mainCred?.type === "oauth" &&
      mainCred.provider === params.cred.provider &&
      Number.isFinite(mainCred.expires) &&
      (!Number.isFinite(params.cred.expires) || mainCred.expires > params.cred.expires) &&
      isSafeToCopyOAuthCredential(params.cred, mainCred)
    ) {
      params.store.profiles[params.profileId] = { ...mainCred };
      saveAuthProfileStore(params.store, params.agentDir);
      log.info("adopted newer OAuth credentials from main agent", {
        profileId: params.profileId,
        agentDir: params.agentDir,
        expires: new Date(mainCred.expires).toISOString(),
      });
      return mainCred;
    }
  } catch (err) {
    // Best-effort: don't crash if main agent store is missing or unreadable.
    log.debug("adoptNewerMainOAuthCredential failed", {
      profileId: params.profileId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return null;
}

function isFreshOAuthCredential(
  cred: OAuthCredentials & { type: "oauth"; provider: string },
): boolean {
  return Number.isFinite(cred.expires) && Date.now() < cred.expires;
}

function shouldAdoptCodexCliCredential(params: {
  current: OAuthCredentials & { type: "oauth"; provider: string };
  candidate: OAuthCredentials & { type: "oauth"; provider: string };
}): boolean {
  if (params.current.provider !== "openai-codex" || params.candidate.provider !== "openai-codex") {
    return false;
  }
  if (!isFreshOAuthCredential(params.candidate)) {
    return false;
  }
  if (!Number.isFinite(params.current.expires)) {
    return true;
  }
  if (params.candidate.expires > params.current.expires) {
    return true;
  }
  // Access-token expiry can tie when two stores are written in the same refresh
  // window. For Codex, a changed refresh token at the same or later expiry still
  // means the CLI has the live rotated token and the copied profile does not.
  return (
    params.candidate.expires >= params.current.expires &&
    (params.candidate.access !== params.current.access ||
      params.candidate.refresh !== params.current.refresh)
  );
}

async function adoptFreshCodexCliCredential(params: {
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
  cred: OAuthCredentials & { type: "oauth"; provider: string; email?: string };
}): Promise<{ apiKey: string; provider: string; email?: string } | null> {
  if (params.cred.provider !== "openai-codex") {
    return null;
  }

  try {
    const cliCred = readCodexCliCredentials();
    if (
      !cliCred ||
      !shouldAdoptCodexCliCredential({
        current: params.cred,
        candidate: cliCred,
      })
    ) {
      return null;
    }

    const adopted = {
      ...params.cred,
      ...cliCred,
      type: "oauth" as const,
      provider: "openai-codex",
      email: params.cred.email,
    };
    params.store.profiles[params.profileId] = adopted;
    saveAuthProfileStore(params.store, params.agentDir);
    log.info("adopted fresh Codex CLI OAuth credentials", {
      profileId: params.profileId,
      agentDir: params.agentDir,
      expires: new Date(adopted.expires).toISOString(),
    });
    return await buildOAuthProfileResult({
      provider: adopted.provider,
      credentials: adopted,
      email: adopted.email,
    });
  } catch (err) {
    log.debug("adoptFreshCodexCliCredential failed", {
      profileId: params.profileId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// The file lock helper is intentionally re-entrant inside one process. OAuth
// refresh is different: two concurrent lanes in the gateway must never spend
// the same single-use refresh token. This FIFO queue closes that same-process
// gap before the cross-process lock below coordinates sibling agents.
const refreshQueues = new Map<string, Promise<unknown>>();

function refreshQueueKey(provider: string, profileId: string): string {
  return `${provider}\u0000${profileId}`;
}

export function resetOAuthRefreshQueuesForTest(): void {
  refreshQueues.clear();
}

function normalizeOAuthIdentity(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized || undefined;
}

/**
 * Refuse cross-agent credential copies when both stores identify different
 * accounts. Missing identity on the old credential is allowed so a refresh can
 * upgrade legacy profiles that predate account metadata.
 */
function isSafeToCopyOAuthCredential(
  existing: OAuthCredential,
  incoming: OAuthCredential,
): boolean {
  const existingAccountId = normalizeOAuthIdentity(existing.accountId);
  const incomingAccountId = normalizeOAuthIdentity(incoming.accountId);
  if (existingAccountId && incomingAccountId) {
    return existingAccountId === incomingAccountId;
  }
  const existingEmail = normalizeOAuthIdentity(existing.email);
  const incomingEmail = normalizeOAuthIdentity(incoming.email);
  if (existingEmail && incomingEmail) {
    return existingEmail === incomingEmail;
  }
  // If the existing profile has identity but the incoming credential cannot
  // prove the same identity, do not let a sibling agent overwrite it.
  if (existingAccountId || existingEmail) {
    return false;
  }
  return true;
}

async function mirrorRefreshedCredentialIntoMainStore(params: {
  profileId: string;
  refreshed: OAuthCredential;
}): Promise<void> {
  try {
    await updateAuthProfileStoreWithLock({
      agentDir: undefined,
      updater: (store) => {
        const existing = store.profiles[params.profileId];
        if (existing && existing.type !== "oauth") {
          return false;
        }
        if (existing && existing.provider !== params.refreshed.provider) {
          return false;
        }
        if (existing && !isSafeToCopyOAuthCredential(existing, params.refreshed)) {
          log.warn("refused to mirror OAuth credential with mismatched identity", {
            profileId: params.profileId,
          });
          return false;
        }
        if (
          existing &&
          Number.isFinite(existing.expires) &&
          existing.expires >= params.refreshed.expires
        ) {
          return false;
        }
        store.profiles[params.profileId] = { ...params.refreshed };
        return true;
      },
    });
  } catch (err) {
    // The caller already persisted its own fresh credential. Mirroring is a
    // cross-agent optimization and must not turn a successful refresh into a
    // failed user request.
    log.debug("mirrorRefreshedCredentialIntoMainStore failed", {
      profileId: params.profileId,
      error: extractErrorMessage(err),
    });
  }
}

async function refreshOAuthTokenWithLock(params: {
  profileId: string;
  provider: string;
  agentDir?: string;
}): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
  const key = refreshQueueKey(params.provider, params.profileId);
  const previous = refreshQueues.get(key) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const queueGate = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  refreshQueues.set(key, queueGate);
  try {
    await previous;
    return await refreshOAuthTokenAcrossAgents(params);
  } finally {
    releaseQueue();
    if (refreshQueues.get(key) === queueGate) {
      refreshQueues.delete(key);
    }
  }
}

async function refreshOAuthTokenAcrossAgents(params: {
  profileId: string;
  provider: string;
  agentDir?: string;
}): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
  const authPath = resolveAuthStorePath(params.agentDir);
  ensureAuthStoreFile(authPath);
  const refreshLockPath = resolveOAuthRefreshLockPath(params.provider, params.profileId);

  return await withFileLock(refreshLockPath, OAUTH_REFRESH_LOCK_OPTIONS, async () =>
    withFileLock(authPath, AUTH_STORE_LOCK_OPTIONS, async () => {
      // Bypass runtime snapshots after taking the locks. Another lane may have
      // refreshed and persisted this profile while the current caller waited.
      const store = loadAuthProfileStoreForSecretsRuntime(params.agentDir);
      const cred = store.profiles[params.profileId];
      if (!cred || cred.type !== "oauth" || cred.provider !== params.provider) {
        return null;
      }

      if (Date.now() < cred.expires) {
        return {
          apiKey: await buildOAuthApiKey(cred.provider, cred),
          newCredentials: cred,
        };
      }

      // OAuth setup copies credentials into sibling agent stores. Once one
      // sibling refreshes, peers should adopt the fresh main credential rather
      // than reuse the rotated token they still have on disk.
      if (params.agentDir) {
        const mainPath = resolveAuthStorePath(undefined);
        if (mainPath !== authPath) {
          const mainStore = loadAuthProfileStoreForSecretsRuntime(undefined);
          const mainCred = mainStore.profiles[params.profileId];
          if (
            mainCred?.type === "oauth" &&
            mainCred.provider === cred.provider &&
            Date.now() < mainCred.expires &&
            isSafeToCopyOAuthCredential(cred, mainCred)
          ) {
            store.profiles[params.profileId] = { ...mainCred };
            saveAuthProfileStore(store, params.agentDir);
            return {
              apiKey: await buildOAuthApiKey(mainCred.provider, mainCred),
              newCredentials: mainCred,
            };
          }
        }
      }

      const { refreshProviderOAuthCredentialWithPlugin } = await loadProviderRuntime();
      const pluginRefreshed = await refreshProviderOAuthCredentialWithPlugin({
        provider: cred.provider,
        context: cred,
      });
      if (pluginRefreshed) {
        // Provider refresh tokens rotate. Persist the merged credential before
        // returning, otherwise the next request reuses the dead token.
        const refreshedCredential: OAuthCredential = {
          ...cred,
          ...pluginRefreshed,
          type: "oauth",
          provider: cred.provider,
        };
        store.profiles[params.profileId] = refreshedCredential;
        saveAuthProfileStore(store, params.agentDir);
        if (params.agentDir && resolveAuthStorePath(undefined) !== authPath) {
          await mirrorRefreshedCredentialIntoMainStore({
            profileId: params.profileId,
            refreshed: refreshedCredential,
          });
        }
        return {
          apiKey: await buildOAuthApiKey(cred.provider, refreshedCredential),
          newCredentials: refreshedCredential,
        };
      }

      const oauthCreds: Record<string, OAuthCredentials> = { [cred.provider]: cred };
      const result =
        String(cred.provider) === "chutes"
          ? await (async () => {
              const newCredentials = await refreshChutesTokens({
                credential: cred,
              });
              return { apiKey: newCredentials.access, newCredentials };
            })()
          : await (async () => {
              const oauthProvider = resolveOAuthProvider(cred.provider);
              if (!oauthProvider) {
                return null;
              }
              return await getOAuthApiKey(oauthProvider, oauthCreds);
            })();
      if (!result) {
        return null;
      }
      const refreshedCredential: OAuthCredential = {
        ...cred,
        ...result.newCredentials,
        type: "oauth",
        provider: cred.provider,
      };
      store.profiles[params.profileId] = refreshedCredential;
      saveAuthProfileStore(store, params.agentDir);
      if (params.agentDir && resolveAuthStorePath(undefined) !== authPath) {
        await mirrorRefreshedCredentialIntoMainStore({
          profileId: params.profileId,
          refreshed: refreshedCredential,
        });
      }

      return {
        apiKey: await buildOAuthApiKey(cred.provider, refreshedCredential),
        newCredentials: refreshedCredential,
      };
    }),
  );
}

async function tryResolveOAuthProfile(
  params: ResolveApiKeyForProfileParams,
): Promise<{ apiKey: string; provider: string; email?: string } | null> {
  const { cfg, store, profileId } = params;
  const cred = store.profiles[profileId];
  if (!cred || cred.type !== "oauth") {
    return null;
  }
  if (
    !isProfileConfigCompatible({
      cfg,
      profileId,
      provider: cred.provider,
      mode: cred.type,
    })
  ) {
    return null;
  }

  if (Date.now() < cred.expires) {
    return await buildOAuthProfileResult({
      provider: cred.provider,
      credentials: cred,
      email: cred.email,
    });
  }

  const refreshed = await refreshOAuthTokenWithLock({
    profileId,
    provider: cred.provider,
    agentDir: params.agentDir,
  });
  if (!refreshed) {
    return null;
  }
  return buildApiKeyProfileResult({
    apiKey: refreshed.apiKey,
    provider: cred.provider,
    email: cred.email,
  });
}

async function resolveProfileSecretString(params: {
  profileId: string;
  provider: string;
  value: string | undefined;
  valueRef: unknown;
  refDefaults: SecretDefaults | undefined;
  configForRefResolution: OpenClawConfig;
  cache: SecretRefResolveCache;
  inlineFailureMessage: string;
  refFailureMessage: string;
}): Promise<string | undefined> {
  let resolvedValue = params.value?.trim();
  if (resolvedValue) {
    const inlineRef = coerceSecretRef(resolvedValue, params.refDefaults);
    if (inlineRef) {
      try {
        resolvedValue = await resolveSecretRefString(inlineRef, {
          config: params.configForRefResolution,
          env: process.env,
          cache: params.cache,
        });
      } catch (err) {
        log.debug(params.inlineFailureMessage, {
          profileId: params.profileId,
          provider: params.provider,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const explicitRef = coerceSecretRef(params.valueRef, params.refDefaults);
  if (!resolvedValue && explicitRef) {
    try {
      resolvedValue = await resolveSecretRefString(explicitRef, {
        config: params.configForRefResolution,
        env: process.env,
        cache: params.cache,
      });
    } catch (err) {
      log.debug(params.refFailureMessage, {
        profileId: params.profileId,
        provider: params.provider,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return resolvedValue;
}

export async function resolveApiKeyForProfile(
  params: ResolveApiKeyForProfileParams,
): Promise<{ apiKey: string; provider: string; email?: string } | null> {
  const { cfg, store, profileId } = params;
  const cred = store.profiles[profileId];
  if (!cred) {
    return null;
  }
  if (
    !isProfileConfigCompatible({
      cfg,
      profileId,
      provider: cred.provider,
      mode: cred.type,
      // Compatibility: treat "oauth" config as compatible with stored token profiles.
      allowOAuthTokenCompatibility: true,
    })
  ) {
    return null;
  }

  const refResolveCache: SecretRefResolveCache = {};
  const configForRefResolution = cfg ?? loadConfig();
  const refDefaults = configForRefResolution.secrets?.defaults;

  if (cred.type === "api_key") {
    const key = await resolveProfileSecretString({
      profileId,
      provider: cred.provider,
      value: cred.key,
      valueRef: cred.keyRef,
      refDefaults,
      configForRefResolution,
      cache: refResolveCache,
      inlineFailureMessage: "failed to resolve inline auth profile api_key ref",
      refFailureMessage: "failed to resolve auth profile api_key ref",
    });
    if (!key) {
      return null;
    }
    return buildApiKeyProfileResult({ apiKey: key, provider: cred.provider, email: cred.email });
  }
  if (cred.type === "token") {
    const expiryState = resolveTokenExpiryState(cred.expires);
    if (expiryState === "expired" || expiryState === "invalid_expires") {
      return null;
    }
    const token = await resolveProfileSecretString({
      profileId,
      provider: cred.provider,
      value: cred.token,
      valueRef: cred.tokenRef,
      refDefaults,
      configForRefResolution,
      cache: refResolveCache,
      inlineFailureMessage: "failed to resolve inline auth profile token ref",
      refFailureMessage: "failed to resolve auth profile token ref",
    });
    if (!token) {
      return null;
    }
    return buildApiKeyProfileResult({ apiKey: token, provider: cred.provider, email: cred.email });
  }

  const oauthCred =
    adoptNewerMainOAuthCredential({
      store,
      profileId,
      agentDir: params.agentDir,
      cred,
    }) ?? cred;

  if (Date.now() < oauthCred.expires) {
    return await buildOAuthProfileResult({
      provider: oauthCred.provider,
      credentials: oauthCred,
      email: oauthCred.email,
    });
  }

  try {
    const result = await refreshOAuthTokenWithLock({
      profileId,
      provider: oauthCred.provider,
      agentDir: params.agentDir,
    });
    if (!result) {
      return null;
    }
    return buildApiKeyProfileResult({
      apiKey: result.apiKey,
      provider: cred.provider,
      email: cred.email,
    });
  } catch (error) {
    const refreshedStore = ensureAuthProfileStore(params.agentDir);
    const refreshed = refreshedStore.profiles[profileId];
    if (refreshed?.type === "oauth" && Date.now() < refreshed.expires) {
      return await buildOAuthProfileResult({
        provider: refreshed.provider,
        credentials: refreshed,
        email: refreshed.email ?? cred.email,
      });
    }

    const codexCliResolved = await adoptFreshCodexCliCredential({
      store: refreshedStore,
      profileId,
      agentDir: params.agentDir,
      cred,
    });
    if (codexCliResolved) {
      return codexCliResolved;
    }

    const fallbackProfileId = suggestOAuthProfileIdForLegacyDefault({
      cfg,
      store: refreshedStore,
      provider: cred.provider,
      legacyProfileId: profileId,
    });
    if (fallbackProfileId && fallbackProfileId !== profileId) {
      try {
        const fallbackResolved = await tryResolveOAuthProfile({
          cfg,
          store: refreshedStore,
          profileId: fallbackProfileId,
          agentDir: params.agentDir,
        });
        if (fallbackResolved) {
          return fallbackResolved;
        }
      } catch {
        // keep original error
      }
    }

    // Fallback: if this is a secondary agent, try using the main agent's credentials
    if (params.agentDir) {
      try {
        const mainStore = ensureAuthProfileStore(undefined); // main agent (no agentDir)
        const mainCred = mainStore.profiles[profileId];
        if (
          mainCred?.type === "oauth" &&
          Date.now() < mainCred.expires &&
          isSafeToCopyOAuthCredential(cred, mainCred)
        ) {
          // Main agent has fresh credentials - copy them to this agent and use them
          refreshedStore.profiles[profileId] = { ...mainCred };
          saveAuthProfileStore(refreshedStore, params.agentDir);
          log.info("inherited fresh OAuth credentials from main agent", {
            profileId,
            agentDir: params.agentDir,
            expires: new Date(mainCred.expires).toISOString(),
          });
          return await buildOAuthProfileResult({
            provider: mainCred.provider,
            credentials: mainCred,
            email: mainCred.email,
          });
        }
      } catch {
        // keep original error if main agent fallback also fails
      }
    }

    const message = extractErrorMessage(error);
    const hint = await formatAuthDoctorHint({
      cfg,
      store: refreshedStore,
      provider: cred.provider,
      profileId,
    });
    throw new Error(
      `OAuth token refresh failed for ${cred.provider}: ${message}. ` +
        "Please try again or re-authenticate." +
        (hint ? `\n\n${hint}` : ""),
      { cause: error },
    );
  }
}
