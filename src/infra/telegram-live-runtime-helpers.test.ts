import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTelegramLiveRuntimeConfig,
  buildTelegramLiveRuntimeChildEnv,
  collectActiveTelegramTokenLeaseEntries,
  extractTelegramBotTokensFromConfig,
  pruneTesterRuntimeAuthStore,
  selectTelegramTesterToken,
} from "../../scripts/lib/telegram-live-runtime-helpers.mjs";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-live-helper-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("telegram live runtime helpers", () => {
  it("extracts reserved Telegram bot tokens from base config", () => {
    const tokens = extractTelegramBotTokensFromConfig({
      channels: {
        telegram: {
          botToken: "default-token",
          accounts: {
            coder: { botToken: "coder-token" },
            empty: { enabled: true },
            finance: { botToken: "finance-token" },
          },
        },
      },
    });

    expect(tokens).toEqual(["default-token", "coder-token", "finance-token"]);
  });

  it("reassigns when the current tester token is reserved by the main runtime", () => {
    const result = selectTelegramTesterToken({
      poolTokens: ["prod-token", "tester-a", "tester-b"],
      claimedTokens: ["tester-a"],
      reservedTokens: ["prod-token"],
      currentToken: "prod-token",
    });

    expect(result).toMatchObject({
      ok: true,
      action: "assign",
      reason: "reassign_conflict_or_invalid",
      selectedToken: "tester-b",
    });
  });

  it("reassigns when the current tester token is actively leased by another runtime", () => {
    const result = selectTelegramTesterToken({
      poolTokens: ["tester-a", "tester-b"],
      claimedTokens: [],
      leasedEntries: [{ token: "tester-a", worktreePath: "/tmp/other", pid: 123 }],
      reservedTokens: [],
      currentToken: "tester-a",
    });

    expect(result).toMatchObject({
      ok: true,
      action: "assign",
      reason: "reassign_conflict_or_invalid",
      selectedToken: "tester-b",
    });
  });

  it("detects active leases from other worktrees without blocking the current worktree lease", () => {
    const leaseRoot = makeTempDir();
    const currentWorktree = "/repo/current";
    const otherWorktree = "/repo/other";
    const liveToken = "12345:live";
    const localToken = "23456:local";
    const liveHash = crypto.createHash("sha256").update(liveToken).digest("hex");
    const localHash = crypto.createHash("sha256").update(localToken).digest("hex");

    fs.writeFileSync(
      path.join(leaseRoot, `12345-${liveHash}.json`),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        starttime: null,
        createdAt: new Date().toISOString(),
        tokenHash: liveHash,
        tokenFingerprint: "livefinger",
        botId: "12345",
        accountId: "finance",
        worktree: otherWorktree,
      }),
    );
    fs.writeFileSync(
      path.join(leaseRoot, `23456-${localHash}.json`),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        starttime: null,
        createdAt: new Date().toISOString(),
        tokenHash: localHash,
        tokenFingerprint: "localfinger",
        botId: "23456",
        accountId: "tester",
        worktree: currentWorktree,
      }),
    );

    expect(
      collectActiveTelegramTokenLeaseEntries({
        tokens: [liveToken, localToken],
        leaseRoot,
        currentWorktreePath: currentWorktree,
      }),
    ).toEqual([
      { token: liveToken, worktreePath: otherWorktree, pid: process.pid, accountId: "finance" },
    ]);
  });

  it("builds a Telegram-only runtime config that disables ACP without inheriting OpenAI secrets or auto-switching to plain OpenAI", () => {
    const config = buildTelegramLiveRuntimeConfig({
      baseConfig: {
        env: {
          OPENAI_API_KEY: "sk-live-test",
          OPENCLAW_CONSUMER_OPENAI_API_KEY: "sk-consumer-test",
          vars: {
            OPENAI_API_KEY: "sk-live-vars",
          },
        },
        messages: {
          tts: {
            openai: {
              apiKey: "${OPENAI_API_KEY}",
            },
          },
        },
        tools: {
          media: {
            audio: {
              models: [{ provider: "openai", apiKey: "${OPENCLAW_CONSUMER_OPENAI_API_KEY}" }],
            },
          },
        },
        models: {
          providers: {
            openai: { apiKey: "sk-main-provider" },
          },
        },
        acp: {
          backend: "acpx",
          dispatch: { enabled: true },
        },
        channels: {
          telegram: {
            enabled: false,
            requireMention: false,
            accounts: {
              coder: { botToken: "prod-token" },
            },
          },
          slack: { enabled: true },
        },
        plugins: {
          allow: ["slack"],
          deny: ["legacy"],
          entries: {
            acpx: { enabled: true },
            slack: { enabled: true },
          },
          slots: {
            memory: "default",
          },
        },
      },
      assignedToken: "tester-token",
      runtimePort: 24567,
    });

    expect(config.gateway).toMatchObject({
      port: 24567,
      bind: "loopback",
      mode: "local",
      controlUi: { enabled: false },
    });
    expect(config.channels).toEqual({
      telegram: {
        enabled: true,
        requireMention: false,
        botToken: "tester-token",
      },
    });
    expect(config.env?.OPENAI_API_KEY).toBeUndefined();
    expect(config.env?.OPENCLAW_CONSUMER_OPENAI_API_KEY).toBeUndefined();
    expect(config.env?.vars?.OPENAI_API_KEY).toBeUndefined();
    expect(config.messages?.tts?.openai?.apiKey).toBeUndefined();
    expect(config.tools?.media?.audio?.models?.[0]?.apiKey).toBeUndefined();
    expect(config.models?.providers?.openai?.apiKey).toBeUndefined();
    expect(config.agents?.defaults?.model).toBeUndefined();
    expect(config.agents?.defaults?.heartbeat).toEqual({
      every: "0m",
      target: "none",
    });
    expect(config.acp).toEqual({
      enabled: false,
      dispatch: { enabled: false },
    });
    expect(config.plugins).toMatchObject({
      enabled: true,
      allow: ["telegram"],
      slots: { memory: "none" },
    });
    expect(config.plugins?.deny).toEqual(["acpx"]);
    expect(config.plugins?.entries?.telegram).toMatchObject({ enabled: true });
    expect(config.plugins?.entries?.acpx).toMatchObject({ enabled: false });
  });

  it("honors an explicit preferred model for isolated Telegram tester lanes", () => {
    const config = buildTelegramLiveRuntimeConfig({
      baseConfig: {
        env: {
          OPENAI_API_KEY: "sk-live-test",
        },
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-opus-4-6",
              fallbacks: ["openai/gpt-5.4", "anthropic/claude-sonnet-4-5"],
            },
            models: {
              "openai/gpt-5.4": { alias: "GPT 5.4" },
              "openai-codex/gpt-5.4": { alias: "Codex 5.4" },
            },
          },
        },
      },
      assignedToken: "tester-token",
      preferredModel: "openai-codex/gpt-5.4",
      runtimePort: 24567,
    });

    expect(config.agents?.defaults?.model).toMatchObject({
      primary: "openai-codex/gpt-5.4",
      fallbacks: [],
    });
    expect(config.agents?.defaults?.models).toEqual({
      "openai-codex/gpt-5.4": { alias: "Codex 5.4" },
    });
  });

  it("derives a safe effective model when the inherited default is plain openai", () => {
    const config = buildTelegramLiveRuntimeConfig({
      baseConfig: {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.4",
              fallbacks: ["anthropic/claude-sonnet-4-5", "openai/gpt-5.2"],
            },
            models: {
              "openai/gpt-5.4": { alias: "GPT 5.4" },
              "openai-codex/gpt-5.4": { alias: "Codex 5.4" },
              "anthropic/claude-sonnet-4-5": { alias: "Claude Sonnet" },
            },
          },
        },
      },
      assignedToken: "tester-token",
      runtimePort: 24567,
    });

    expect(config.agents?.defaults?.model).toMatchObject({
      primary: "anthropic/claude-sonnet-4-5",
      fallbacks: [],
    });
    expect(config.agents?.defaults?.models).toEqual({
      "openai/gpt-5.4": { alias: "GPT 5.4" },
      "openai-codex/gpt-5.4": { alias: "Codex 5.4" },
      "anthropic/claude-sonnet-4-5": { alias: "Claude Sonnet" },
    });
  });

  it("derives a Codex twin when the inherited plain OpenAI default has no safe fallback", () => {
    const config = buildTelegramLiveRuntimeConfig({
      baseConfig: {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.4",
            },
            models: {
              "openai/gpt-5.4": { alias: "GPT 5.4" },
              "openai-codex/gpt-5.4": { alias: "Codex 5.4" },
            },
          },
        },
      },
      assignedToken: "tester-token",
      runtimePort: 24567,
    });

    expect(config.agents?.defaults?.model).toMatchObject({
      primary: "openai-codex/gpt-5.4",
      fallbacks: [],
    });
    expect(config.agents?.defaults?.models).toEqual({
      "openai-codex/gpt-5.4": { alias: "Codex 5.4" },
    });
  });

  it("strips raw OpenAI env defaults from detached tester runtime envs", () => {
    expect(
      buildTelegramLiveRuntimeChildEnv({
        parentEnv: {
          OPENAI_API_KEY: "sk-live-test",
          OPENAI_MODEL_API_KEY: "sk-model-split",
          OPENAI_BASE_URL: "https://api.openai.test/v1",
          OPENAI_MODEL: "openai/gpt-5.4",
          OPENCLAW_CONSUMER_OPENAI_API_KEY: "sk-consumer-test",
          OTHER_VALUE: "kept",
        },
      }),
    ).toEqual({
      OTHER_VALUE: "kept",
    });
  });

  it("prunes tester auth stores down to the pinned model provider", () => {
    const pruned = pruneTesterRuntimeAuthStore({
      preferredModel: "openai-codex/gpt-5.4",
      store: {
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
            access: "codex-access",
            refresh: "codex-refresh",
            expires: 123,
          },
          "anthropic:default": {
            type: "api_key",
            provider: "anthropic",
            keyRef: { source: "env", provider: "default", id: "ANTHROPIC_API_KEY" },
          },
        },
        order: {
          "openai-codex": ["openai-codex:default"],
          anthropic: ["anthropic:default"],
        },
        lastGood: {
          "openai-codex": "openai-codex:default",
          anthropic: "anthropic:default",
        },
        usageStats: {
          "openai-codex:default": { lastUsed: 1 },
          "anthropic:default": { lastUsed: 2 },
        },
      },
    });

    expect(Object.keys(pruned.profiles)).toEqual(["openai-codex:default"]);
    expect(pruned.order).toEqual({ "openai-codex": ["openai-codex:default"] });
    expect(pruned.lastGood).toEqual({ "openai-codex": "openai-codex:default" });
    expect(pruned.usageStats).toEqual({ "openai-codex:default": { lastUsed: 1 } });
  });

  it("does not mutate the canonical base config while deriving a tester runtime config", () => {
    const baseConfig = {
      channels: {
        telegram: {
          enabled: false,
          botToken: "99999:main-bot",
          accounts: {
            main: { botToken: "88888:main-account" },
          },
        },
      },
      models: {
        providers: {
          openai: {
            apiKey: "sk-main-provider",
          },
        },
      },
    };

    const config = buildTelegramLiveRuntimeConfig({
      baseConfig,
      assignedToken: "tester-token",
      runtimePort: 24567,
    });

    expect(baseConfig.channels.telegram.botToken).toBe("99999:main-bot");
    expect(baseConfig.channels.telegram.accounts.main.botToken).toBe("88888:main-account");
    expect(config.channels.telegram.botToken).toBe("tester-token");
  });
});
