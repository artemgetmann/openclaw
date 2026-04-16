import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootstrapTelegramLiveAcpValidationAuthStore,
  buildTelegramLiveRuntimeConfig,
  collectActiveTelegramTokenLeaseEntries,
  deriveTelegramLiveRuntimeProfile,
  extractTelegramBotTokensFromConfig,
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

  it("builds a Telegram-only runtime config that disables ACP without inheriting OpenAI secrets", () => {
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
        auth: {
          profiles: {
            "anthropic:default": { provider: "anthropic", mode: "api_key" },
            "openai-codex:default": { provider: "openai-codex", mode: "oauth" },
          },
          order: {
            anthropic: ["anthropic:default"],
            "openai-codex": ["openai-codex:default"],
          },
        },
      },
      assignedToken: "tester-token",
      runtimePort: 24567,
      workspaceDir: "/tmp/openclaw-live-onboarding",
      dmPolicy: "open",
    });

    expect(config.gateway).toMatchObject({
      port: 24567,
      bind: "loopback",
      mode: "local",
      controlUi: { enabled: false },
    });
    expect(config.channels).toEqual({
      telegram: {
        allowFrom: ["*"],
        enabled: true,
        requireMention: false,
        dmPolicy: "open",
        botToken: "tester-token",
      },
    });
    expect(config.env?.OPENAI_API_KEY).toBeUndefined();
    expect(config.env?.OPENCLAW_CONSUMER_OPENAI_API_KEY).toBeUndefined();
    expect(config.env?.vars?.OPENAI_API_KEY).toBeUndefined();
    expect(config.messages?.tts?.openai?.apiKey).toBeUndefined();
    expect(config.tools?.media?.audio?.models?.[0]?.apiKey).toBeUndefined();
    expect(config.models?.providers?.openai?.apiKey).toBeUndefined();
    expect(config.agents?.defaults?.model?.primary).not.toBe("openai/gpt-5.4");
    expect(config.agents?.defaults?.workspace).toBe("/tmp/openclaw-live-onboarding");
    expect(config.agents?.list).toEqual([{ id: "main" }]);
    expect(config.acp).toEqual({
      enabled: false,
      dispatch: { enabled: false },
    });
    expect(config.bindings).toEqual([]);
    expect(config.plugins).toMatchObject({
      enabled: true,
      allow: ["telegram"],
      slots: { memory: "none" },
    });
    expect(config.plugins?.deny).toEqual(["acpx"]);
    expect(config.plugins?.entries?.telegram).toMatchObject({ enabled: true });
    expect(config.plugins?.entries?.acpx).toMatchObject({ enabled: false });
    expect(config.auth).toEqual({
      profiles: {
        "anthropic:default": { provider: "anthropic", mode: "api_key" },
        "openai-codex:default": { provider: "openai-codex", mode: "oauth" },
      },
      order: {
        anthropic: ["anthropic:default"],
        "openai-codex": ["openai-codex:default"],
      },
    });
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
              fallbacks: ["anthropic/claude-sonnet-4-5"],
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
      fallbacks: ["anthropic/claude-sonnet-4-5"],
    });
    expect(config.agents?.defaults?.models).toEqual({
      "openai-codex/gpt-5.4": { alias: "Codex 5.4" },
    });
  });

  it("enables ACP validation mode with acpx and a Codex default model", () => {
    const config = buildTelegramLiveRuntimeConfig({
      acpValidation: "1",
      worktreePath: "/repo/live-lane",
      baseConfig: {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-opus-4-6",
              fallbacks: ["anthropic/claude-sonnet-4-5"],
            },
          },
        },
        acp: {
          enabled: false,
          dispatch: { enabled: false },
        },
        plugins: {
          deny: ["legacy"],
          entries: {
            acpx: { enabled: false },
          },
        },
        auth: {
          profiles: {
            "anthropic:default": { provider: "anthropic", mode: "api_key" },
            "openai-codex:default": { provider: "openai-codex", mode: "oauth" },
            "openai:default": { provider: "openai", mode: "api_key" },
          },
          order: {
            anthropic: ["anthropic:default"],
            openai: ["openai:default"],
            "openai-codex": ["openai-codex:default"],
          },
        },
      },
      assignedToken: "tester-token",
      runtimePort: 24567,
    });

    expect(config.agents?.defaults?.model).toMatchObject({
      primary: "openai-codex/gpt-5.4",
      fallbacks: ["anthropic/claude-sonnet-4-5"],
    });
    expect(config.agents?.defaults?.workspace).toBe("/repo/live-lane");
    expect(config.acp).toEqual({
      backend: "acpx",
      enabled: true,
      dispatch: { enabled: true },
    });
    expect(config.plugins).toMatchObject({
      allow: ["telegram", "acpx"],
      deny: [],
    });
    expect(config.plugins?.entries?.acpx).toMatchObject({ enabled: true });
    expect(config.auth).toEqual({
      profiles: {
        "openai-codex:default": { provider: "openai-codex", mode: "oauth" },
      },
      order: {
        "openai-codex": ["openai-codex:default"],
      },
    });
  });

  it("strips inherited OPENAI_API_KEY from the detached runtime env when pinned to Codex", () => {
    expect(
      buildTelegramLiveRuntimeChildEnv({
        preferredModel: "openai-codex/gpt-5.4",
        parentEnv: {
          OPENAI_API_KEY: "sk-live-test",
          OTHER_VALUE: "kept",
        },
      }),
    ).toEqual({
      OTHER_VALUE: "kept",
    });
  });

  it("keeps external CLI auth sync compatible with ACP validation Codex lanes", () => {
    const acpxBinDir = path.resolve("dist", "extensions", "acpx", "node_modules", ".bin");
    const acpxCommand = path.join(acpxBinDir, process.platform === "win32" ? "acpx.cmd" : "acpx");
    fs.mkdirSync(acpxBinDir, { recursive: true });
    fs.writeFileSync(acpxCommand, "");
    expect(
      buildTelegramLiveRuntimeChildEnv({
        acpValidation: "true",
        parentEnv: {
          OPENAI_API_KEY: "sk-live-test",
          OTHER_VALUE: "kept",
        },
      }),
    ).toEqual({
      ACPX_CMD: acpxCommand,
      OTHER_VALUE: "kept",
      PATH: acpxBinDir,
    });
  });

  it("exports the plugin-local acpx command into ACP validation child env", () => {
    const repoRoot = makeTempDir();
    const acpxBinDir = path.join(repoRoot, "dist", "extensions", "acpx", "node_modules", ".bin");
    const acpxCommand = path.join(acpxBinDir, process.platform === "win32" ? "acpx.cmd" : "acpx");
    fs.mkdirSync(acpxBinDir, { recursive: true });
    fs.writeFileSync(acpxCommand, "");

    expect(
      buildTelegramLiveRuntimeChildEnv({
        acpValidation: "1",
        repoRoot,
        parentEnv: {
          PATH: "/usr/bin",
          OTHER_VALUE: "kept",
        },
      }),
    ).toEqual({
      ACPX_CMD: acpxCommand,
      PATH: `${acpxBinDir}${path.delimiter}/usr/bin`,
      OTHER_VALUE: "kept",
    });
  });

  it("falls back to the source acpx command when the bundled dist binary is missing", () => {
    const repoRoot = makeTempDir();
    const acpxBinDir = path.join(repoRoot, "extensions", "acpx", "node_modules", ".bin");
    const acpxCommand = path.join(acpxBinDir, process.platform === "win32" ? "acpx.cmd" : "acpx");
    fs.mkdirSync(acpxBinDir, { recursive: true });
    fs.writeFileSync(acpxCommand, "");

    expect(
      buildTelegramLiveRuntimeChildEnv({
        acpValidation: "1",
        repoRoot,
        parentEnv: {
          PATH: "/usr/bin",
          OTHER_VALUE: "kept",
        },
      }),
    ).toEqual({
      ACPX_CMD: acpxCommand,
      PATH: `${acpxBinDir}${path.delimiter}/usr/bin`,
      OTHER_VALUE: "kept",
    });
  });

  it("uses a dedicated state dir for ACP validation lanes", () => {
    const profile = deriveTelegramLiveRuntimeProfile({
      worktreePath: "/repo/current",
      stateRoot: "/tmp/openclaw-telegram-live",
      acpValidation: "1",
    });

    expect(profile.runtimeStateDir).toMatch(
      /^\/tmp\/openclaw-telegram-live\/tg-live-[0-9a-f]{10}\/acp-validation$/,
    );
  });

  it("bootstraps the ACP validation auth store from local Codex auth", () => {
    const runtimeStateDir = makeTempDir();
    const codexHome = makeTempDir();
    const codexAuthPath = path.join(codexHome, "auth.json");
    fs.writeFileSync(
      codexAuthPath,
      JSON.stringify(
        {
          tokens: {
            access_token: "not-a-jwt-access-token",
            refresh_token: "refresh-token",
            account_id: "acct_123",
          },
        },
        null,
        2,
      ),
    );

    const result = bootstrapTelegramLiveAcpValidationAuthStore({
      runtimeStateDir,
      codexHome,
      agentId: "main",
    });

    expect(result).toMatchObject({
      ok: true,
      codexAuthPath,
      authStorePath: path.join(runtimeStateDir, "agents", "main", "agent", "auth-profiles.json"),
    });
    expect(
      JSON.parse(fs.readFileSync(result.authStorePath, "utf8")) as {
        profiles: Record<string, Record<string, unknown>>;
        order: Record<string, string[]>;
      },
    ).toMatchObject({
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "not-a-jwt-access-token",
          refresh: "refresh-token",
          accountId: "acct_123",
        },
      },
      order: {
        "openai-codex": ["openai-codex:default"],
      },
    });
  });

  it("reports a missing local Codex auth file during ACP validation bootstrap", () => {
    const runtimeStateDir = makeTempDir();
    const codexHome = makeTempDir();

    expect(
      bootstrapTelegramLiveAcpValidationAuthStore({
        runtimeStateDir,
        codexHome,
      }),
    ).toMatchObject({
      ok: false,
      reason: "codex_auth_missing",
      codexAuthPath: path.join(codexHome, "auth.json"),
      authStorePath: path.join(runtimeStateDir, "agents", "main", "agent", "auth-profiles.json"),
    });
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
