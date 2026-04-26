import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootstrapTelegramLiveAcpValidationAuthStore,
  bootstrapTelegramLiveCodexAuthStore,
  buildTelegramLiveRuntimeConfig,
  buildTelegramLiveRuntimeChildEnv,
  collectActiveReservedTelegramBotTokensFromCanonicalConfig,
  collectActiveTelegramTokenLeaseEntries,
  deriveTelegramLiveRuntimeProfile,
  extractTelegramBotTokensFromConfig,
  isLocalCodexAuthAvailable,
  isCanonicalSharedGatewayActive,
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

  it("treats canonical-config tokens as reserved only while the shared gateway is active", () => {
    const home = makeTempDir();
    const canonicalMainRepo = path.join(home, "Programming_Projects", "openclaw");
    const canonicalConfigPath = path.join(home, ".openclaw", "openclaw.json");
    fs.mkdirSync(path.join(canonicalMainRepo, "dist"), { recursive: true });
    fs.writeFileSync(path.join(canonicalMainRepo, "dist", "index.js"), "", "utf8");
    fs.writeFileSync(path.join(canonicalMainRepo, "package.json"), "{}\n", "utf8");
    const canonicalMainRepoReal = fs.realpathSync.native(canonicalMainRepo);
    fs.mkdirSync(path.dirname(canonicalConfigPath), { recursive: true });
    fs.writeFileSync(
      canonicalConfigPath,
      JSON.stringify({
        channels: {
          telegram: {
            botToken: "exec-token",
            accounts: {
              finance: { botToken: "finance-token" },
            },
          },
        },
      }),
      "utf8",
    );

    const execTextFn = (command, args) => {
      const joined = `${command} ${args.join(" ")}`;
      if (joined.includes("launchctl print")) {
        return `pid = 456\nprogram = "${canonicalMainRepoReal}/dist/index.js"\n`;
      }
      if (joined.includes("ps -o command=")) {
        return `node ${canonicalMainRepoReal}/dist/index.js gateway run`;
      }
      return "";
    };

    expect(
      isCanonicalSharedGatewayActive({
        env: { HOME: home, OPENCLAW_MAIN_REPO: canonicalMainRepo },
        execTextFn,
        getUidFn: () => 501,
      }),
    ).toBe(true);
    expect(
      collectActiveReservedTelegramBotTokensFromCanonicalConfig({
        env: { HOME: home, OPENCLAW_MAIN_REPO: canonicalMainRepo },
        baseConfigPath: canonicalConfigPath,
        execTextFn,
        getUidFn: () => 501,
      }),
    ).toEqual(["exec-token", "finance-token"]);
    expect(
      collectActiveReservedTelegramBotTokensFromCanonicalConfig({
        env: { HOME: home, OPENCLAW_MAIN_REPO: canonicalMainRepo },
        baseConfigPath: canonicalConfigPath,
        execTextFn: () => "",
        getUidFn: () => 501,
      }),
    ).toEqual([]);
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

  it("defaults isolated tester lanes to Codex when local Codex auth is available", () => {
    const config = buildTelegramLiveRuntimeConfig({
      baseConfig: {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-opus-4-6",
              fallbacks: ["anthropic/claude-sonnet-4-5"],
            },
            models: {
              "anthropic/claude-opus-4-6": { alias: "Claude Opus" },
              "openai-codex/gpt-5.4": { alias: "Codex 5.4" },
            },
          },
        },
      },
      assignedToken: "tester-token",
      preferCodexAuth: true,
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

  it("preseeds isolated gateway auth so startup does not rewrite config", () => {
    const config = buildTelegramLiveRuntimeConfig({
      baseConfig: {
        gateway: {
          auth: {
            mode: "token",
          },
        },
      },
      assignedToken: "tester-token",
      gatewayAuthToken: "isolated-gateway-token",
      runtimePort: 24567,
    });

    expect(config.gateway?.auth).toMatchObject({
      mode: "token",
      token: "isolated-gateway-token",
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
      fallbacks: [],
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

  it("strips inherited OPENAI_API_KEY from the detached runtime env when pinned to Codex", () => {
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
      OPENCLAW_TELEGRAM_IGNORE_PERSISTED_UPDATE_OFFSET: "1",
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
      OPENCLAW_TELEGRAM_IGNORE_PERSISTED_UPDATE_OFFSET: "1",
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
      OPENCLAW_TELEGRAM_IGNORE_PERSISTED_UPDATE_OFFSET: "1",
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

  it("detects usable local Codex auth without exposing token contents", () => {
    const codexHome = makeTempDir();
    const codexAuthPath = path.join(codexHome, "auth.json");

    expect(isLocalCodexAuthAvailable({ codexHome })).toBe(false);

    fs.writeFileSync(
      codexAuthPath,
      JSON.stringify({
        tokens: {
          access_token: "access-token",
          refresh_token: "refresh-token",
        },
      }),
    );

    expect(isLocalCodexAuthAvailable({ codexHome })).toBe(true);
  });

  it("bootstraps generic tester Codex auth stores from local Codex auth", () => {
    const runtimeStateDir = makeTempDir();
    const codexHome = makeTempDir();
    const codexAuthPath = path.join(codexHome, "auth.json");
    fs.writeFileSync(
      codexAuthPath,
      JSON.stringify({
        tokens: {
          access_token: "access-token",
          refresh_token: "refresh-token",
        },
      }),
    );

    const result = bootstrapTelegramLiveCodexAuthStore({
      runtimeStateDir,
      codexHome,
      agentId: "main",
    });

    expect(result.ok).toBe(true);
    const store = JSON.parse(fs.readFileSync(result.authStorePath, "utf8")) as {
      profiles: Record<string, Record<string, unknown>>;
      order: Record<string, string[]>;
    };
    expect(store.profiles["openai-codex:default"]).toMatchObject({
      type: "oauth",
      provider: "openai-codex",
    });
    expect(store.order).toEqual({ "openai-codex": ["openai-codex:default"] });
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
