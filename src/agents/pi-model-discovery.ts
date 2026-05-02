import fs from "node:fs";
import path from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import * as PiCodingAgent from "@mariozechner/pi-coding-agent";
import type {
  AuthStorage as PiAuthStorage,
  ModelRegistry as PiModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { ensureAuthProfileStore } from "./auth-profiles.js";
import { normalizeModelCompat } from "./model-compat.js";
import { resolvePiCredentialMapFromStore, type PiCredentialMap } from "./pi-auth-credentials.js";

const PiAuthStorageClass = PiCodingAgent.AuthStorage;
const PiModelRegistryClass = PiCodingAgent.ModelRegistry;

export { PiAuthStorageClass as AuthStorage, PiModelRegistryClass as ModelRegistry };

type InMemoryAuthStorageBackendLike = {
  withLock<T>(
    update: (current: string) => {
      result: T;
      next?: string;
    },
  ): T;
};

type ProviderRuntimeModelLike = Model<Api> & {
  api?: string | null;
};

const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";

function isOpenAICodexDiscoveryRoute(baseUrl?: string): boolean {
  const trimmed = baseUrl?.trim();
  return Boolean(trimmed && /^https?:\/\/chatgpt\.com\/backend-api(?:\/v1)?\/?$/i.test(trimmed));
}

function createInMemoryAuthStorageBackend(
  initialData: PiCredentialMap,
): InMemoryAuthStorageBackendLike {
  let snapshot = JSON.stringify(initialData, null, 2);
  return {
    withLock<T>(
      update: (current: string) => {
        result: T;
        next?: string;
      },
    ): T {
      const { result, next } = update(snapshot);
      if (typeof next === "string") {
        snapshot = next;
      }
      return result;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scrubLegacyStaticAuthJsonEntries(pathname: string): void {
  if (process.env.OPENCLAW_AUTH_STORE_READONLY === "1") {
    return;
  }
  if (!fs.existsSync(pathname)) {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(pathname, "utf8")) as unknown;
  } catch {
    return;
  }
  if (!isRecord(parsed)) {
    return;
  }

  let changed = false;
  for (const [provider, value] of Object.entries(parsed)) {
    if (!isRecord(value)) {
      continue;
    }
    if (value.type !== "api_key") {
      continue;
    }
    delete parsed[provider];
    changed = true;
  }

  if (!changed) {
    return;
  }

  if (Object.keys(parsed).length === 0) {
    fs.rmSync(pathname, { force: true });
    return;
  }

  fs.writeFileSync(pathname, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  fs.chmodSync(pathname, 0o600);
}

function createAuthStorage(AuthStorageLike: unknown, path: string, creds: PiCredentialMap) {
  const withInMemory = AuthStorageLike as { inMemory?: (data?: unknown) => unknown };
  if (typeof withInMemory.inMemory === "function") {
    return withInMemory.inMemory(creds) as PiAuthStorage;
  }

  const withFromStorage = AuthStorageLike as {
    fromStorage?: (storage: unknown) => unknown;
  };
  if (typeof withFromStorage.fromStorage === "function") {
    const backendCtor = (
      PiCodingAgent as { InMemoryAuthStorageBackend?: new () => InMemoryAuthStorageBackendLike }
    ).InMemoryAuthStorageBackend;
    const backend =
      typeof backendCtor === "function"
        ? new backendCtor()
        : createInMemoryAuthStorageBackend(creds);
    backend.withLock(() => ({
      result: undefined,
      next: JSON.stringify(creds, null, 2),
    }));
    return withFromStorage.fromStorage(backend) as PiAuthStorage;
  }

  const withFactory = AuthStorageLike as { create?: (path: string) => unknown };
  const withRuntimeOverride = (
    typeof withFactory.create === "function"
      ? withFactory.create(path)
      : new (AuthStorageLike as { new (path: string): unknown })(path)
  ) as PiAuthStorage & {
    setRuntimeApiKey?: (provider: string, apiKey: string) => void; // pragma: allowlist secret
  };
  const hasRuntimeApiKeyOverride = typeof withRuntimeOverride.setRuntimeApiKey === "function"; // pragma: allowlist secret
  if (hasRuntimeApiKeyOverride) {
    for (const [provider, credential] of Object.entries(creds)) {
      if (credential.type === "api_key") {
        withRuntimeOverride.setRuntimeApiKey(provider, credential.key);
        continue;
      }
      withRuntimeOverride.setRuntimeApiKey(provider, credential.access);
    }
  }
  return withRuntimeOverride;
}

function resolvePiCredentials(agentDir: string): PiCredentialMap {
  const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  return resolvePiCredentialMapFromStore(store);
}

export function normalizeDiscoveredPiModel<T>(value: T, _agentDir: string): T {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.provider !== "string"
  ) {
    return value;
  }
  const model = value as unknown as ProviderRuntimeModelLike;
  // Keep discovery normalization cheap. This file is imported by hot model-registry paths,
  // so only repair the known stale Codex transport shape instead of loading provider plugins.
  if (model.provider !== "openai-codex" || !isOpenAICodexDiscoveryRoute(model.baseUrl)) {
    return value;
  }
  const api =
    !model.api || model.api === "openai-responses" || model.api === "openai-codex-responses"
      ? "openai-codex-responses"
      : model.api;
  if (api !== "openai-codex-responses") {
    return value;
  }
  return normalizeModelCompat({
    ...model,
    api,
    baseUrl: OPENAI_CODEX_BASE_URL,
  } as Model<Api>) as T;
}

function normalizeDiscoveredPiModels<T>(values: T, agentDir: string): T {
  return Array.isArray(values)
    ? (values.map((value) => normalizeDiscoveredPiModel(value, agentDir)) as T)
    : normalizeDiscoveredPiModel(values, agentDir);
}

// Compatibility helpers for pi-coding-agent 0.50+ (discover* helpers removed).
export function discoverAuthStorage(agentDir: string): PiAuthStorage {
  const credentials = resolvePiCredentials(agentDir);
  const authPath = path.join(agentDir, "auth.json");
  scrubLegacyStaticAuthJsonEntries(authPath);
  return createAuthStorage(PiAuthStorageClass, authPath, credentials);
}

export function discoverModels(authStorage: PiAuthStorage, agentDir: string): PiModelRegistry {
  const registry = new PiModelRegistryClass(authStorage, path.join(agentDir, "models.json"));
  // Older persisted models.json files can hold stale OpenAI Codex transport metadata.
  // Normalize reads at the registry boundary so list, availability, and runtime resolution agree.
  const mutableRegistry = registry as unknown as {
    find?: (...args: unknown[]) => unknown;
    getAll?: (...args: unknown[]) => unknown;
    getAvailable?: (...args: unknown[]) => unknown;
  };
  const originalFind = mutableRegistry.find?.bind(registry);
  if (originalFind) {
    mutableRegistry.find = (...args: unknown[]) =>
      normalizeDiscoveredPiModels(originalFind(...args), agentDir);
  }
  const originalGetAll = mutableRegistry.getAll?.bind(registry);
  if (originalGetAll) {
    mutableRegistry.getAll = (...args: unknown[]) =>
      normalizeDiscoveredPiModels(originalGetAll(...args), agentDir);
  }
  const originalGetAvailable = mutableRegistry.getAvailable?.bind(registry);
  if (originalGetAvailable) {
    mutableRegistry.getAvailable = (...args: unknown[]) =>
      normalizeDiscoveredPiModels(originalGetAvailable(...args), agentDir);
  }
  return registry;
}
