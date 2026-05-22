import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { ProviderPlugin } from "../../plugins/types.js";

const mocks = vi.hoisted(() => ({
  clearAuthProfileCooldown: vi.fn(),
  ensureAuthProfileStore: vi.fn(() => ({
    version: 1,
    profiles: {},
    order: {},
  })),
  listProfilesForProvider: vi.fn(() => []),
  loadAuthProfileStoreForRuntime: vi.fn(() => ({
    version: 1,
    profiles: {},
    order: {},
  })),
  resolveAuthProfileOrder: vi.fn(() => []),
  upsertAuthProfile: vi.fn(),
  updateConfig: vi.fn(async (mutator: (cfg: OpenClawConfig) => OpenClawConfig) =>
    mutator(baseConfig),
  ),
}));

vi.mock("../../agents/auth-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/auth-profiles.js")>();
  return {
    ...actual,
    clearAuthProfileCooldown: mocks.clearAuthProfileCooldown,
    ensureAuthProfileStore: mocks.ensureAuthProfileStore,
    listProfilesForProvider: mocks.listProfilesForProvider,
    loadAuthProfileStoreForRuntime: mocks.loadAuthProfileStoreForRuntime,
    resolveAuthProfileOrder: mocks.resolveAuthProfileOrder,
    upsertAuthProfile: mocks.upsertAuthProfile,
  };
});

vi.mock("./shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared.js")>();
  return {
    ...actual,
    updateConfig: mocks.updateConfig,
  };
});

const { applyConsumerAuth, listConsumerAuthOptions } = await import("./consumer-auth.js");

const baseConfig: OpenClawConfig = {
  agents: {
    defaults: {
      model: {
        primary: "openai-codex/gpt-5.5",
      },
    },
  },
};

const anthropicProvider: ProviderPlugin = {
  id: "anthropic",
  label: "Claude",
  auth: [
    {
      id: "setup-token",
      label: "Setup token",
      kind: "token",
      run: async () => ({
        profiles: [],
      }),
    },
    {
      id: "api-key",
      label: "API key",
      kind: "api_key",
      run: async () => ({
        profiles: [],
      }),
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("consumer auth Claude CLI setup detection", () => {
  it("hides Continue with Claude until the local claude command and auth are both detected", async () => {
    const missingCommand = await listConsumerAuthOptions({
      config: baseConfig,
      agentDir: "/tmp/openclaw-agent",
      workspaceDir: "/tmp/openclaw-workspace",
      providers: [anthropicProvider],
      claudeCommandExists: () => false,
      readClaudeCliCredential: () => ({
        type: "oauth",
        provider: "anthropic",
        access: "access",
        refresh: "refresh",
        expires: Date.now() + 60_000,
      }),
    });

    expect(missingCommand.options.map((option) => option.id)).not.toContain("anthropic-claude-cli");
    expect(missingCommand.options.map((option) => option.id)).toContain("anthropic-setup-token");

    const missingAuth = await listConsumerAuthOptions({
      config: baseConfig,
      agentDir: "/tmp/openclaw-agent",
      workspaceDir: "/tmp/openclaw-workspace",
      providers: [anthropicProvider],
      claudeCommandExists: () => true,
      readClaudeCliCredential: () => null,
    });

    expect(missingAuth.options.map((option) => option.id)).not.toContain("anthropic-claude-cli");

    const ready = await listConsumerAuthOptions({
      config: baseConfig,
      agentDir: "/tmp/openclaw-agent",
      workspaceDir: "/tmp/openclaw-workspace",
      providers: [anthropicProvider],
      claudeCommandExists: () => true,
      readClaudeCliCredential: () => ({
        type: "oauth",
        provider: "anthropic",
        access: "access",
        refresh: "refresh",
        expires: Date.now() + 60_000,
      }),
    });

    expect(ready.options.map((option) => option.id)).toContain("anthropic-claude-cli");
  });

  it("detects a configured Claude CLI command outside PATH", async () => {
    const configuredCommand = "/Users/user/.local/bin/claude";
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          ...baseConfig.agents?.defaults,
          cliBackends: {
            "claude-cli": {
              command: configuredCommand,
            },
          },
        },
      },
    };
    const seenCommands: string[] = [];

    const ready = await listConsumerAuthOptions({
      config,
      agentDir: "/tmp/openclaw-agent",
      workspaceDir: "/tmp/openclaw-workspace",
      providers: [anthropicProvider],
      claudeCommandExists: (command) => {
        seenCommands.push(command ?? "");
        return command === configuredCommand;
      },
      readClaudeCliCredential: () => ({
        type: "oauth",
        provider: "anthropic",
        access: "access",
        refresh: "refresh",
        expires: Date.now() + 60_000,
      }),
    });

    expect(seenCommands).toEqual([configuredCommand]);
    expect(ready.options.map((option) => option.id)).toContain("anthropic-claude-cli");
  });

  it("blocks direct Claude CLI apply with install and auth instructions when claude is missing", async () => {
    await expect(
      applyConsumerAuth({
        optionId: "anthropic-claude-cli",
        config: baseConfig,
        agentDir: "/tmp/openclaw-agent",
        workspaceDir: "/tmp/openclaw-workspace",
        providers: [anthropicProvider],
        claudeCommandExists: () => false,
        readClaudeCliCredential: () => ({
          type: "oauth",
          provider: "anthropic",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        }),
        resolveReadiness: async () => ({
          status: "ready",
          mode: "byok",
          defaultModel: "anthropic/claude-sonnet-4-6",
          configPath: "/tmp/openclaw/config.json",
          stateDir: "/tmp/openclaw",
          agentDir: "/tmp/openclaw-agent",
          authMode: "byok",
          reasonCodes: [],
          summary: "ready",
          actions: [],
          byokAvailable: true,
          voiceStatus: "ready",
          voiceSummary: "ready",
          voiceActions: [],
        }),
      }),
    ).rejects.toThrow("Install Claude Code so the `claude` command is executable");
  });
});

describe("consumer auth ChatGPT OAuth setup", () => {
  it("surfaces a zero-profile openai-codex OAuth result without retrying provider auth", async () => {
    const runOpenAiCodexOAuth = vi.fn(async () => ({
      profiles: [],
      notes: ["ChatGPT OAuth completed but did not return a usable profile."],
    }));
    const openAiCodexProvider: ProviderPlugin = {
      id: "openai-codex",
      label: "ChatGPT / Codex",
      auth: [
        {
          id: "oauth",
          label: "OAuth",
          kind: "oauth",
          run: runOpenAiCodexOAuth,
        },
      ],
    };

    await expect(
      applyConsumerAuth({
        optionId: "openai-codex-oauth",
        config: baseConfig,
        agentDir: "/tmp/openclaw-agent",
        workspaceDir: "/tmp/openclaw-workspace",
        providers: [openAiCodexProvider],
      }),
    ).rejects.toThrow("ChatGPT OAuth completed but did not return a usable profile.");

    expect(runOpenAiCodexOAuth).toHaveBeenCalledTimes(1);
    expect(mocks.upsertAuthProfile).not.toHaveBeenCalled();
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });
});
