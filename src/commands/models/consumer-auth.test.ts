import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import { clearConfigCache, loadConfig, writeConfigFile } from "../../config/config.js";
import type { ProviderAuthContext, ProviderAuthKind, ProviderPlugin } from "../../plugins/types.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { applyConsumerAuth, listConsumerAuthOptions } from "./consumer-auth.js";
import type { ModelsReadinessResult } from "./readiness.js";

type ConsumerAuthFixture = {
  root: string;
  stateDir: string;
  agentDir: string;
  configPath: string;
};

async function withConsumerAuthFixture(run: (fixture: ConsumerAuthFixture) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-consumer-auth-"));
  try {
    const stateDir = path.join(root, "state");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(agentDir, { recursive: true });

    await withEnvAsync(
      {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_AGENT_DIR: agentDir,
        PI_CODING_AGENT_DIR: agentDir,
        OPENCLAW_CONFIG_PATH: configPath,
      },
      async () => {
        clearConfigCache();
        await writeConfigFile({});
        clearConfigCache();
        await run({ root, stateDir, agentDir, configPath });
      },
    );
  } finally {
    clearConfigCache();
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function readAuthProfiles(agentDir: string) {
  const raw = await fs.readFile(path.join(agentDir, "auth-profiles.json"), "utf8");
  return JSON.parse(raw) as {
    profiles?: Record<string, AuthProfileCredential>;
  };
}

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    }),
  };
}

function readyReadiness(defaultModel: string): ModelsReadinessResult {
  return {
    status: "ready",
    mode: "byok",
    defaultModel,
    configPath: "/tmp/openclaw.json",
    stateDir: "/tmp/state",
    agentDir: "/tmp/agent",
    authMode: "byok",
    reasonCodes: [],
    summary: `AI ready on ${defaultModel}.`,
    actions: [],
    byokAvailable: true,
    lastProbeAt: Date.now(),
  };
}

function buildProvider(params: {
  id: string;
  label: string;
  methodId: string;
  methodKind: ProviderAuthKind;
  run: (ctx: ProviderAuthContext) => Promise<{
    profiles: Array<{
      profileId: string;
      credential: AuthProfileCredential;
    }>;
    defaultModel?: string;
    notes?: string[];
    configPatch?: Record<string, unknown>;
  }>;
}): ProviderPlugin {
  return {
    id: params.id,
    label: params.label,
    auth: [
      {
        id: params.methodId,
        label: params.methodId,
        kind: params.methodKind as never,
        run: params.run,
      },
    ],
  } as ProviderPlugin;
}

describe("consumer auth", () => {
  it("lists only the curated providers that are actually available", async () => {
    const options = await listConsumerAuthOptions({
      config: {},
      workspaceDir: "/tmp/workspace",
      readClaudeCliCredential: vi.fn(() => null),
      providers: [
        buildProvider({
          id: "openai-codex",
          label: "OpenAI Codex",
          methodId: "oauth",
          methodKind: "oauth",
          run: async () => ({ profiles: [] }),
        }),
        buildProvider({
          id: "openai",
          label: "OpenAI",
          methodId: "api-key",
          methodKind: "api_key",
          run: async () => ({ profiles: [] }),
        }),
        buildProvider({
          id: "minimax-portal",
          label: "MiniMax",
          methodId: "oauth",
          methodKind: "device_code",
          run: async () => ({ profiles: [] }),
        }),
        buildProvider({
          id: "totally-unsupported",
          label: "Unsupported",
          methodId: "api-key",
          methodKind: "api_key",
          run: async () => ({ profiles: [] }),
        }),
      ],
    });

    expect(options.map((option) => option.id)).toEqual([
      "openai-codex-oauth",
      "anthropic-claude-cli",
      "openai-api-key",
    ]);
  });

  it("persists a consumer API key into the tester-local auth store and config", async () => {
    await withConsumerAuthFixture(async ({ agentDir }) => {
      const runtime = createRuntime();
      const options = [
        buildProvider({
          id: "openai",
          label: "OpenAI",
          methodId: "api-key",
          methodKind: "api_key",
          run: async (ctx) => {
            const key = String((ctx.opts as { token?: string } | undefined)?.token ?? "").trim();
            return {
              profiles: [
                {
                  profileId: "openai:default",
                  credential: {
                    type: "api_key",
                    provider: "openai",
                    key,
                  },
                },
              ],
            };
          },
        }),
      ];

      const result = await applyConsumerAuth({
        optionId: "openai-api-key",
        secret: "sk-openai-test",
        providers: options,
        runtime,
        resolveReadiness: async () => readyReadiness("openai/gpt-5.4"),
      });

      expect(result.profileIds).toEqual(["openai:default"]);
      expect(result.defaultModel).toBe("openai/gpt-5.4");
      const store = await readAuthProfiles(agentDir);
      expect(store.profiles?.["openai:default"]).toMatchObject({
        type: "api_key",
        provider: "openai",
        key: "sk-openai-test",
      });

      const cfg = loadConfig();
      expect(cfg.auth?.profiles?.["openai:default"]).toMatchObject({
        provider: "openai",
        mode: "api_key",
      });
      expect(cfg.agents?.defaults?.model).toMatchObject({
        primary: "openai/gpt-5.4",
      });
    });
  });

  it("rejects missing credentials for single-field consumer auth methods", async () => {
    await expect(
      applyConsumerAuth({
        optionId: "openai-api-key",
        secret: "",
        providers: [],
      }),
    ).rejects.toThrow("This sign-in method requires OpenAI API key.");
  });

  it("auto-answers the Anthropic token-name follow-up so setup stays single-field", async () => {
    await withConsumerAuthFixture(async ({ agentDir }) => {
      const runtime = createRuntime();
      const providers = [
        buildProvider({
          id: "anthropic",
          label: "Anthropic",
          methodId: "setup-token",
          methodKind: "token",
          run: async (ctx) => {
            const token = await ctx.prompter.text({
              message: "Paste Anthropic setup-token",
              validate: (value) => (value.trim() ? undefined : "Required"),
            });
            const name = await ctx.prompter.text({
              message: "Token name (blank = default)",
            });
            return {
              profiles: [
                {
                  profileId: name.trim() ? `anthropic:${name.trim()}` : "anthropic:default",
                  credential: {
                    type: "token",
                    provider: "anthropic",
                    token,
                  },
                },
              ],
              defaultModel: "anthropic/claude-sonnet-4-6",
            };
          },
        }),
      ];

      const result = await applyConsumerAuth({
        optionId: "anthropic-setup-token",
        secret: "anthropic-setup-token-test",
        providers,
        runtime,
        resolveReadiness: async () => readyReadiness("anthropic/claude-sonnet-4-6"),
      });

      expect(result.profileIds).toEqual(["anthropic:default"]);
      const store = await readAuthProfiles(agentDir);
      expect(store.profiles?.["anthropic:default"]).toMatchObject({
        type: "token",
        provider: "anthropic",
        token: "anthropic-setup-token-test",
      });
    });
  });

  it("reuses Claude Code credentials for the Claude subscription path", async () => {
    await withConsumerAuthFixture(async ({ agentDir }) => {
      const runtime = createRuntime();

      const result = await applyConsumerAuth({
        optionId: "anthropic-claude-cli",
        providers: [],
        runtime,
        readClaudeCliCredential: vi.fn(() => ({
          type: "oauth",
          provider: "anthropic",
          access: "claude-access",
          refresh: "claude-refresh",
          expires: Date.now() + 60_000,
        })),
        resolveReadiness: async () => readyReadiness("anthropic/claude-sonnet-4-6"),
      });

      expect(result.profileIds).toEqual(["anthropic:claude-cli"]);
      expect(result.defaultModel).toBe("anthropic/claude-sonnet-4-6");
      expect(result.notes).toContain(
        "Reused the Claude subscription sign-in already available on this Mac.",
      );

      const store = await readAuthProfiles(agentDir);
      expect(store.profiles?.["anthropic:claude-cli"]).toMatchObject({
        type: "oauth",
        provider: "anthropic",
        access: "claude-access",
        refresh: "claude-refresh",
      });

      const cfg = loadConfig();
      expect(cfg.auth?.profiles?.["anthropic:claude-cli"]).toMatchObject({
        provider: "anthropic",
        mode: "oauth",
      });
      expect(cfg.agents?.defaults?.model).toMatchObject({
        primary: "anthropic/claude-sonnet-4-6",
      });
      expect(cfg.auth?.order?.anthropic).toEqual(["anthropic:claude-cli"]);
    });
  });
});
