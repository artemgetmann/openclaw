import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import { resolveApiKeyForProfile } from "./oauth.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "./store.js";
import type { AuthProfileStore } from "./types.js";

const { getOAuthApiKeyMock } = vi.hoisted(() => ({
  getOAuthApiKeyMock: vi.fn(async () => {
    throw new Error("Failed to extract accountId from token");
  }),
}));

const {
  refreshProviderOAuthCredentialWithPluginMock,
  formatProviderAuthProfileApiKeyWithPluginMock,
  buildProviderAuthDoctorHintWithPluginMock,
  readCodexCliCredentialsMock,
} = vi.hoisted(() => ({
  refreshProviderOAuthCredentialWithPluginMock: vi.fn(
    async (_params?: { context?: unknown }) => undefined,
  ),
  formatProviderAuthProfileApiKeyWithPluginMock: vi.fn(() => undefined),
  buildProviderAuthDoctorHintWithPluginMock: vi.fn(async () => undefined),
  readCodexCliCredentialsMock: vi.fn<() => unknown>(() => null),
}));

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthApiKey: getOAuthApiKeyMock,
  getOAuthProviders: () => [
    { id: "openai-codex", envApiKey: "OPENAI_API_KEY", oauthTokenEnv: "OPENAI_OAUTH_TOKEN" }, // pragma: allowlist secret
    { id: "anthropic", envApiKey: "ANTHROPIC_API_KEY", oauthTokenEnv: "ANTHROPIC_OAUTH_TOKEN" }, // pragma: allowlist secret
  ],
}));

vi.mock("../../plugins/provider-runtime.runtime.js", () => ({
  refreshProviderOAuthCredentialWithPlugin: refreshProviderOAuthCredentialWithPluginMock,
  formatProviderAuthProfileApiKeyWithPlugin: formatProviderAuthProfileApiKeyWithPluginMock,
  buildProviderAuthDoctorHintWithPlugin: buildProviderAuthDoctorHintWithPluginMock,
}));

vi.mock("../cli-credentials.js", () => ({
  readCodexCliCredentials: readCodexCliCredentialsMock,
  readCodexCliCredentialsCached: readCodexCliCredentialsMock,
  readQwenCliCredentialsCached: vi.fn(() => null),
  readMiniMaxCliCredentialsCached: vi.fn(() => null),
}));

function createExpiredOauthStore(params: {
  profileId: string;
  provider: string;
  access?: string;
}): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [params.profileId]: {
        type: "oauth",
        provider: params.provider,
        access: params.access ?? "cached-access-token",
        refresh: "refresh-token",
        expires: Date.now() - 60_000,
      },
    },
  };
}

describe("resolveApiKeyForProfile openai-codex refresh fallback", () => {
  const envSnapshot = captureEnv([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
    "CODEX_HOME",
    "OPENCLAW_DISABLE_EXTERNAL_CLI_AUTH_SYNC",
  ]);
  let tempRoot = "";
  let agentDir = "";

  beforeEach(async () => {
    getOAuthApiKeyMock.mockClear();
    refreshProviderOAuthCredentialWithPluginMock.mockReset();
    refreshProviderOAuthCredentialWithPluginMock.mockResolvedValue(undefined);
    formatProviderAuthProfileApiKeyWithPluginMock.mockReset();
    formatProviderAuthProfileApiKeyWithPluginMock.mockReturnValue(undefined);
    buildProviderAuthDoctorHintWithPluginMock.mockReset();
    buildProviderAuthDoctorHintWithPluginMock.mockResolvedValue(undefined);
    readCodexCliCredentialsMock.mockReset();
    readCodexCliCredentialsMock.mockReturnValue(null);
    clearRuntimeAuthProfileStoreSnapshots();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-refresh-fallback-"));
    agentDir = path.join(tempRoot, "agents", "main", "agent");
    await fs.mkdir(agentDir, { recursive: true });
    process.env.OPENCLAW_STATE_DIR = tempRoot;
    process.env.OPENCLAW_AGENT_DIR = agentDir;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.CODEX_HOME = path.join(tempRoot, "codex-home");
    delete process.env.OPENCLAW_DISABLE_EXTERNAL_CLI_AUTH_SYNC;
  });

  afterEach(async () => {
    clearRuntimeAuthProfileStoreSnapshots();
    envSnapshot.restore();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("falls back to cached access token when openai-codex refresh fails on accountId extraction", async () => {
    const profileId = "openai-codex:default";
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async (params?: { context?: unknown }) => params?.context as never,
    );
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
      }),
      agentDir,
    );

    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(agentDir),
      profileId,
      agentDir,
    });

    expect(result).toEqual({
      apiKey: "cached-access-token", // pragma: allowlist secret
      provider: "openai-codex",
      email: undefined,
    });
    expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1);
  });

  it("keeps throwing for non-codex providers on the same refresh error", async () => {
    const profileId = "anthropic:default";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "anthropic",
      }),
      agentDir,
    );

    await expect(
      resolveApiKeyForProfile({
        store: ensureAuthProfileStore(agentDir),
        profileId,
        agentDir,
      }),
    ).rejects.toThrow(/OAuth token refresh failed for anthropic/);
  });

  it("does not use fallback for unrelated openai-codex refresh errors", async () => {
    const profileId = "openai-codex:default";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
      }),
      agentDir,
    );
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(async () => {
      throw new Error("invalid_grant");
    });

    await expect(
      resolveApiKeyForProfile({
        store: ensureAuthProfileStore(agentDir),
        profileId,
        agentDir,
      }),
    ).rejects.toThrow(/OAuth token refresh failed for openai-codex/);
  });

  it("resyncs stale copied openai-codex auth from live Codex CLI credentials after refresh_token_reused", async () => {
    const profileId = "openai-codex:default";
    const staleStore = createExpiredOauthStore({
      profileId,
      provider: "openai-codex",
      access: "stale-copied-access",
    });
    const staleProfile = staleStore.profiles[profileId];
    if (staleProfile?.type !== "oauth") {
      throw new Error("test fixture did not create an OAuth profile");
    }
    staleStore.profiles[profileId] = {
      ...staleProfile,
      refresh: "stale-copied-refresh",
    };
    saveAuthProfileStore(staleStore, agentDir);
    process.env.OPENCLAW_DISABLE_EXTERNAL_CLI_AUTH_SYNC = "1";
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(async () => {
      throw new Error("refresh_token_reused");
    });
    readCodexCliCredentialsMock.mockReturnValue({
      type: "oauth",
      provider: "openai-codex",
      access: "fresh-cli-access",
      refresh: "fresh-cli-refresh",
      expires: Date.now() + 10 * 60_000,
      accountId: "acct_123",
    });

    const consoleSpies = [
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
    ];
    try {
      const result = await resolveApiKeyForProfile({
        store: ensureAuthProfileStore(agentDir),
        profileId,
        agentDir,
      });

      expect(result).toEqual({
        apiKey: "fresh-cli-access", // pragma: allowlist secret
        provider: "openai-codex",
        email: undefined,
      });
      expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1);
      const persisted = JSON.parse(
        await fs.readFile(path.join(agentDir, "auth-profiles.json"), "utf8"),
      ) as AuthProfileStore;
      expect(persisted.profiles[profileId]).toMatchObject({
        type: "oauth",
        provider: "openai-codex",
        access: "fresh-cli-access",
        refresh: "fresh-cli-refresh",
      });
      const printed = consoleSpies
        .flatMap((spy) => spy.mock.calls)
        .flat()
        .join("\n");
      expect(printed).not.toContain("fresh-cli-access");
      expect(printed).not.toContain("fresh-cli-refresh");
      expect(printed).not.toContain("stale-copied-refresh");
    } finally {
      for (const spy of consoleSpies) {
        spy.mockRestore();
      }
    }
  });
});
