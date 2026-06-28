import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  ConfigFileSnapshot,
  GatewayAuthConfig,
  GatewayTailscaleConfig,
  OpenClawConfig,
} from "../config/config.js";
import {
  classifyGatewayStartupPreflightError,
  createGatewayStartupContext,
  formatGatewayStartupPreflightFailure,
  runGatewayStartupAuthBootstrap,
  GatewayStartupPreflightError,
  runGatewayStartupConfigPreflight,
  runGatewayStartupRuntimePolicyPhase,
  runGatewayStartupSecretsPrecheck,
} from "./server-startup-preflight.js";

function createSnapshot(overrides: Partial<ConfigFileSnapshot> = {}): ConfigFileSnapshot {
  return {
    path: "/tmp/openclaw.json",
    exists: true,
    raw: "{}",
    parsed: {},
    resolved: {},
    valid: true,
    config: {},
    hash: "hash",
    issues: [],
    warnings: [],
    legacyIssues: [],
    ...overrides,
  };
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-startup-preflight-"));
}

describe("runGatewayStartupConfigPreflight", () => {
  it("classifies invalid config errors in config_validation phase", async () => {
    const invalid = createSnapshot({
      valid: false,
      issues: [{ path: "gateway.port", message: "Expected number, got string" }],
    });
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(createSnapshot())
      .mockResolvedValueOnce(invalid);

    await expect(
      runGatewayStartupConfigPreflight({
        readSnapshot,
        writeConfig: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn() },
        isNixMode: false,
      }),
    ).rejects.toMatchObject({
      name: "GatewayStartupPreflightError",
      phase: "config_validation",
      message: expect.stringContaining('Run "openclaw doctor"'),
    });
  });

  it("classifies legacy migration failures in Nix mode", async () => {
    const readSnapshot = vi.fn<() => Promise<ConfigFileSnapshot>>().mockResolvedValue(
      createSnapshot({
        legacyIssues: [{ path: "routing.allowFrom", message: "legacy key" }],
      }),
    );
    const writeConfig = vi.fn<(config: OpenClawConfig) => Promise<void>>();

    await expect(
      runGatewayStartupConfigPreflight({
        readSnapshot,
        writeConfig,
        log: { info: vi.fn(), warn: vi.fn() },
        isNixMode: true,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<GatewayStartupPreflightError>>({
        phase: "config_legacy_migration",
      }),
    );

    expect(writeConfig).not.toHaveBeenCalled();
  });

  it("repairs legacy media model apiKey before startup validation", async () => {
    const legacyParsed = {
      tools: {
        media: {
          audio: {
            models: [{ provider: "openai", model: "whisper-1", apiKey: "old-key" }],
          },
        },
      },
    };
    const migratedConfig: OpenClawConfig = {
      tools: {
        media: {
          audio: {
            models: [{ provider: "openai", model: "whisper-1" }],
          },
        },
      },
    };
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(
        createSnapshot({
          parsed: legacyParsed,
          valid: false,
          legacyIssues: [
            {
              path: "tools.media.audio.models",
              message: "legacy inline media model apiKey",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(createSnapshot({ config: migratedConfig }));
    const writeConfig = vi.fn<(config: OpenClawConfig) => Promise<void>>().mockResolvedValue();

    const result = await runGatewayStartupConfigPreflight({
      readSnapshot,
      writeConfig,
      log: { info: vi.fn(), warn: vi.fn() },
      isNixMode: false,
    });

    const writtenConfig = writeConfig.mock.calls[0]?.[0];
    expect(writtenConfig?.tools?.media?.audio?.models).toEqual([
      { provider: "openai", model: "whisper-1" },
    ]);
    expect(result.config).toEqual(migratedConfig);
  });

  it("repairs stale Jarvis consumer model defaults before startup validation", async () => {
    const legacyParsed = {
      jarvis: {
        managedServices: { mode: "managed" as const },
        backend: { baseUrl: "https://jarvis.example.invalid" },
      },
      auth: {
        profiles: {
          "openai-codex:default": { provider: "openai-codex", mode: "oauth" as const },
        },
        order: {
          "openai-codex": ["openai-codex:default"],
        },
      },
      agents: {
        defaults: {
          model: { primary: "openai-codex/gpt-5.4" },
          models: {
            "openai-codex/gpt-5.3-codex": {},
            "openai-codex/gpt-5.4": {},
          },
        },
      },
    };
    const migratedConfig: OpenClawConfig = {
      ...legacyParsed,
      agents: {
        defaults: {
          model: { primary: "openai-codex/gpt-5.5" },
          models: {
            "openai-codex/gpt-5.3-codex": {},
            "openai-codex/gpt-5.4": {},
            "openai-codex/gpt-5.5": {},
          },
        },
      },
    };
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(
        createSnapshot({
          parsed: legacyParsed,
          valid: false,
          legacyIssues: [
            {
              path: "agents.defaults",
              message: "stale Jarvis consumer model defaults",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(createSnapshot({ config: migratedConfig }));
    const writeConfig = vi.fn<(config: OpenClawConfig) => Promise<void>>().mockResolvedValue();

    const result = await runGatewayStartupConfigPreflight({
      readSnapshot,
      writeConfig,
      log: { info: vi.fn(), warn: vi.fn() },
      isNixMode: false,
    });

    const writtenConfig = writeConfig.mock.calls[0]?.[0];
    expect(writtenConfig?.agents?.defaults?.model).toEqual({
      primary: "openai-codex/gpt-5.5",
    });
    expect(writtenConfig?.agents?.defaults?.models?.["openai-codex/gpt-5.5"]).toEqual({});
    expect(result.config).toEqual(migratedConfig);
  });

  it("repairs stale Jarvis workspace pointers before startup validation", async () => {
    const home = makeTempDir();
    const legacyWorkspace = path.join(
      home,
      "Library",
      "Application Support",
      "OpenClaw",
      ".openclaw",
      "workspace",
    );
    const canonicalWorkspace = path.join(
      home,
      "Library",
      "Application Support",
      "Jarvis",
      ".jarvis",
      "workspace",
    );
    const jarvisConfigPath = path.join(
      home,
      "Library",
      "Application Support",
      "Jarvis",
      ".jarvis",
      "openclaw.json",
    );
    const staleConfig: OpenClawConfig = {
      agents: {
        defaults: { workspace: legacyWorkspace },
        list: [
          { id: "main", workspace: legacyWorkspace },
          { id: "codex", workspace: legacyWorkspace },
        ],
      },
    };
    const migratedConfig: OpenClawConfig = {
      agents: {
        defaults: { workspace: canonicalWorkspace },
        list: [
          { id: "main", workspace: canonicalWorkspace },
          { id: "codex", workspace: canonicalWorkspace },
        ],
      },
    };
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(createSnapshot({ path: jarvisConfigPath, config: staleConfig }))
      .mockResolvedValueOnce(createSnapshot({ path: jarvisConfigPath, config: staleConfig }))
      .mockResolvedValueOnce(createSnapshot({ path: jarvisConfigPath, config: migratedConfig }));
    const writeConfig = vi.fn<(config: OpenClawConfig) => Promise<void>>().mockResolvedValue();
    const info = vi.fn<(message: string) => void>();

    const result = await runGatewayStartupConfigPreflight({
      readSnapshot,
      writeConfig,
      log: { info, warn: vi.fn() },
      isNixMode: false,
      env: { HOME: home } as NodeJS.ProcessEnv,
    });

    expect(writeConfig).toHaveBeenCalledWith(migratedConfig);
    expect(info).toHaveBeenCalledWith(expect.stringContaining("stale Jarvis workspace pointers"));
    expect(result.config).toEqual(migratedConfig);
  });

  it("repairs stale Jarvis consumer bundled skill allowlists before startup validation", async () => {
    const home = makeTempDir();
    const jarvisConfigPath = path.join(
      home,
      "Library",
      "Application Support",
      "Jarvis",
      ".jarvis",
      "openclaw.json",
    );
    const staleConfig: OpenClawConfig = {
      skills: { allowBundled: ["consumer-setup", "peekaboo"] },
    };
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(createSnapshot({ path: jarvisConfigPath, config: staleConfig }))
      .mockResolvedValueOnce(createSnapshot({ path: jarvisConfigPath, config: staleConfig }))
      .mockResolvedValueOnce(
        createSnapshot({
          path: jarvisConfigPath,
          config: {
            skills: {
              allowBundled: ["consumer-setup", "peekaboo", "jarvis-gui-control"],
            },
          },
        }),
      );
    const writeConfig = vi.fn<(config: OpenClawConfig) => Promise<void>>().mockResolvedValue();
    const info = vi.fn<(message: string) => void>();

    const result = await runGatewayStartupConfigPreflight({
      readSnapshot,
      writeConfig,
      log: { info, warn: vi.fn() },
      isNixMode: false,
      env: { HOME: home, OPENCLAW_PROFILE: "consumer" } as NodeJS.ProcessEnv,
    });

    const writtenConfig = writeConfig.mock.calls[0]?.[0];
    expect(writtenConfig?.skills?.allowBundled?.slice(0, 2)).toEqual([
      "consumer-setup",
      "peekaboo",
    ]);
    expect(writtenConfig?.skills?.allowBundled).toContain("jarvis-gui-control");
    expect(info).toHaveBeenCalledWith(expect.stringContaining("consumer bundled skill allowlist"));
    expect(result.config.skills?.allowBundled).toContain("jarvis-gui-control");
  });

  it("writes auto-enabled plugins and re-reads snapshot on success", async () => {
    const phaseTwo = createSnapshot({
      config: { plugins: { entries: { msteams: { enabled: false } } } },
    });
    const phaseThree = createSnapshot({
      config: { plugins: { entries: { msteams: { enabled: true } } } },
    });
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(createSnapshot())
      .mockResolvedValueOnce(phaseTwo)
      .mockResolvedValueOnce(phaseThree);
    const writeConfig = vi.fn<(config: OpenClawConfig) => Promise<void>>().mockResolvedValue();
    const info = vi.fn<(message: string) => void>();

    const result = await runGatewayStartupConfigPreflight({
      readSnapshot,
      writeConfig,
      log: { info, warn: vi.fn() },
      isNixMode: false,
      applyPluginAutoEnableFn: () => ({
        config: phaseThree.config,
        changes: ["plugins.msteams.enabled"],
      }),
    });

    expect(writeConfig).toHaveBeenCalledWith(phaseThree.config);
    expect(info).toHaveBeenCalledWith(expect.stringContaining("auto-enabled plugins"));
    expect(result).toEqual(
      expect.objectContaining({
        preflightSnapshot: phaseThree,
        config: phaseThree.config,
      }),
    );
  });

  it("refuses noncanonical startup when the canonical shared config owns the token", async () => {
    const home = makeTempDir();
    const canonicalMainRepo = path.join(home, "Programming_Projects", "openclaw");
    fs.mkdirSync(path.join(canonicalMainRepo, "dist"), { recursive: true });
    fs.writeFileSync(path.join(canonicalMainRepo, "dist", "index.js"), "", "utf8");
    fs.writeFileSync(path.join(canonicalMainRepo, "package.json"), "{}\n", "utf8");
    const canonicalMainRepoReal = fs.realpathSync.native(canonicalMainRepo);
    const fakeBin = path.join(home, "bin");
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "launchctl"),
      `#!/bin/sh\nprintf 'pid = 123\\nprogram = "${canonicalMainRepoReal}/dist/index.js"\\n'\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(fakeBin, "ps"),
      `#!/bin/sh\nprintf 'node ${canonicalMainRepoReal}/dist/index.js gateway run\\n'\n`,
      "utf8",
    );
    fs.chmodSync(path.join(fakeBin, "launchctl"), 0o755);
    fs.chmodSync(path.join(fakeBin, "ps"), 0o755);
    fs.mkdirSync(path.join(home, ".openclaw"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".openclaw", "openclaw.json"),
      JSON.stringify({
        channels: {
          telegram: {
            botToken: "main-token",
            accounts: {
              finance: { botToken: "finance-token" },
            },
          },
        },
      }),
      "utf8",
    );

    const readSnapshot = vi.fn<() => Promise<ConfigFileSnapshot>>().mockResolvedValue(
      createSnapshot({
        path: path.join(
          home,
          ".openclaw",
          "telegram-live-worktrees",
          "tg-live-1",
          "openclaw.telegram-live.json",
        ),
        config: {
          channels: {
            telegram: {
              botToken: "main-token",
              accounts: {
                finance: { botToken: "finance-token" },
              },
            },
          },
        },
      }),
    );
    const mainTokenFingerprint = createHash("sha256")
      .update("main-token")
      .digest("hex")
      .slice(0, 12);
    const financeTokenFingerprint = createHash("sha256")
      .update("finance-token")
      .digest("hex")
      .slice(0, 12);

    await expect(
      runGatewayStartupConfigPreflight({
        readSnapshot,
        writeConfig: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn() },
        isNixMode: false,
        env: {
          HOME: home,
          OPENCLAW_MAIN_REPO: canonicalMainRepo,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<GatewayStartupPreflightError>>({
        phase: "config_validation",
        message: expect.stringContaining(
          `Token fingerprints: ${mainTokenFingerprint}, ${financeTokenFingerprint}.`,
        ),
      }),
    );

    await expect(
      runGatewayStartupConfigPreflight({
        readSnapshot,
        writeConfig: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn() },
        isNixMode: false,
        env: {
          HOME: home,
          OPENCLAW_MAIN_REPO: canonicalMainRepo,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      }),
    ).rejects.not.toThrow(/main-token|finance-token/);
  });
});

describe("runGatewayStartupSecretsPrecheck", () => {
  it("classifies invalid config errors before secrets activation", async () => {
    const invalid = createSnapshot({
      valid: false,
      issues: [{ path: "auth.profile", message: "Missing profile" }],
    });
    const readSnapshot = vi.fn<() => Promise<ConfigFileSnapshot>>().mockResolvedValue(invalid);
    const prepareConfig = vi.fn<(config: OpenClawConfig) => OpenClawConfig>();
    const activateRuntimeSecrets = vi.fn<(config: OpenClawConfig) => Promise<void>>();

    await expect(
      runGatewayStartupSecretsPrecheck({
        context: createGatewayStartupContext(createSnapshot()),
        readSnapshot,
        prepareConfig,
        activateRuntimeSecrets,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<GatewayStartupPreflightError>>({
        phase: "config_validation",
        message: expect.stringContaining("Invalid config at /tmp/openclaw.json"),
      }),
    );

    expect(prepareConfig).not.toHaveBeenCalled();
    expect(activateRuntimeSecrets).not.toHaveBeenCalled();
  });

  it("prepares config and runs secrets precheck for valid snapshots", async () => {
    const snapshot = createSnapshot({
      config: { auth: { profiles: { default: { provider: "openai", mode: "api_key" } } } },
    });
    const preparedConfig: OpenClawConfig = {
      auth: { profiles: { gateway: { provider: "openai", mode: "api_key" } } },
    };
    const readSnapshot = vi.fn<() => Promise<ConfigFileSnapshot>>().mockResolvedValue(snapshot);
    const prepareConfig = vi
      .fn<(config: OpenClawConfig) => OpenClawConfig>()
      .mockReturnValue(preparedConfig);
    const activateRuntimeSecrets = vi
      .fn<(config: OpenClawConfig) => Promise<void>>()
      .mockResolvedValue();

    const result = await runGatewayStartupSecretsPrecheck({
      context: createGatewayStartupContext(snapshot),
      readSnapshot,
      prepareConfig,
      activateRuntimeSecrets,
    });

    expect(prepareConfig).toHaveBeenCalledWith(snapshot.config);
    expect(activateRuntimeSecrets).toHaveBeenCalledWith(preparedConfig);
    expect(result.secretsPrechecked).toBe(true);
    expect(result.config).toEqual(snapshot.config);
  });
});

describe("runGatewayStartupAuthBootstrap", () => {
  it("passes overrides into startup auth bootstrap and returns activated config", async () => {
    const initialConfig: OpenClawConfig = { gateway: { auth: { mode: "token" } } };
    const authConfig: OpenClawConfig = { gateway: { auth: { mode: "token", token: "abc123" } } };
    const activatedConfig: OpenClawConfig = { gateway: { auth: { mode: "none" } } };
    const env = { OPENCLAW_GATEWAY_PORT: "18789" } as NodeJS.ProcessEnv;
    const ensureGatewayStartupAuth = vi
      .fn<
        (params: {
          cfg: OpenClawConfig;
          env: NodeJS.ProcessEnv;
          authOverride?: unknown;
          tailscaleOverride?: unknown;
          persist: true;
        }) => Promise<{
          cfg: OpenClawConfig;
          generatedToken?: string;
          persistedGeneratedToken: boolean;
        }>
      >()
      .mockResolvedValue({
        cfg: authConfig,
        persistedGeneratedToken: false,
      });
    const activateRuntimeSecrets = vi
      .fn<(config: OpenClawConfig) => Promise<{ config: OpenClawConfig }>>()
      .mockResolvedValue({ config: activatedConfig });
    const authOverride: GatewayAuthConfig = { mode: "token", token: "override" };
    const tailscaleOverride: GatewayTailscaleConfig = { mode: "serve" };

    const result = await runGatewayStartupAuthBootstrap({
      loadConfig: () => initialConfig,
      context: createGatewayStartupContext(createSnapshot({ config: initialConfig })),
      ensureGatewayStartupAuth,
      activateRuntimeSecrets,
      log: { info: vi.fn(), warn: vi.fn() },
      env,
      authOverride,
      tailscaleOverride,
    });

    expect(ensureGatewayStartupAuth).toHaveBeenCalledWith({
      cfg: initialConfig,
      env,
      authOverride,
      tailscaleOverride,
      persist: true,
    });
    expect(activateRuntimeSecrets).toHaveBeenCalledWith(authConfig);
    expect(result.config).toBe(activatedConfig);
  });

  it("logs info when token generation is persisted", async () => {
    const info = vi.fn<(message: string) => void>();
    const warn = vi.fn<(message: string) => void>();

    await runGatewayStartupAuthBootstrap({
      loadConfig: () => ({}),
      context: createGatewayStartupContext(createSnapshot()),
      ensureGatewayStartupAuth: vi.fn().mockResolvedValue({
        cfg: {},
        generatedToken: "generated",
        persistedGeneratedToken: true,
      }),
      activateRuntimeSecrets: vi.fn().mockResolvedValue({ config: {} }),
      log: { info, warn },
    });

    expect(info).toHaveBeenCalledWith(
      "Gateway auth token was missing. Generated a new token and saved it to config (gateway.auth.token).",
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs warning when token generation is runtime-only", async () => {
    const info = vi.fn<(message: string) => void>();
    const warn = vi.fn<(message: string) => void>();

    await runGatewayStartupAuthBootstrap({
      loadConfig: () => ({}),
      context: createGatewayStartupContext(createSnapshot()),
      ensureGatewayStartupAuth: vi.fn().mockResolvedValue({
        cfg: {},
        generatedToken: "generated",
        persistedGeneratedToken: false,
      }),
      activateRuntimeSecrets: vi.fn().mockResolvedValue({ config: {} }),
      log: { info, warn },
    });

    expect(warn).toHaveBeenCalledWith(
      "Gateway auth token was missing. Generated a runtime token for this startup without changing config; restart will generate a different token. Persist one with `openclaw config set gateway.auth.mode token` and `openclaw config set gateway.auth.token <token>`.",
    );
    expect(info).not.toHaveBeenCalled();
  });
});

describe("runGatewayStartupRuntimePolicyPhase", () => {
  it("enables diagnostics and applies runtime policies", async () => {
    const config: OpenClawConfig = { gateway: {} };
    const seededConfig: OpenClawConfig = {
      ...config,
      gateway: {
        ...config.gateway,
        controlUi: { allowedOrigins: ["https://example.com"] },
      },
    };
    const startDiagnosticHeartbeat = vi.fn<() => void>();
    const setGatewaySigusr1RestartPolicy = vi.fn<(opts: { allowExternal: boolean }) => void>();
    const setPreRestartDeferralCheck = vi.fn<(check: () => number) => void>();
    const getPendingWorkCount = vi.fn<() => number>().mockReturnValue(7);
    const seedControlUiAllowedOrigins = vi
      .fn<(nextConfig: OpenClawConfig) => Promise<OpenClawConfig>>()
      .mockResolvedValue(seededConfig);

    const result = await runGatewayStartupRuntimePolicyPhase({
      context: createGatewayStartupContext(createSnapshot({ config })),
      isDiagnosticsEnabled: () => true,
      startDiagnosticHeartbeat,
      isRestartEnabled: () => true,
      setGatewaySigusr1RestartPolicy,
      setPreRestartDeferralCheck,
      getPendingWorkCount,
      seedControlUiAllowedOrigins,
    });

    expect(startDiagnosticHeartbeat).toHaveBeenCalledTimes(1);
    expect(setGatewaySigusr1RestartPolicy).toHaveBeenCalledWith({ allowExternal: true });
    expect(setPreRestartDeferralCheck).toHaveBeenCalledTimes(1);
    expect(setPreRestartDeferralCheck.mock.calls[0]?.[0]()).toBe(7);
    expect(seedControlUiAllowedOrigins).toHaveBeenCalledWith(config);
    expect(result).toEqual(
      expect.objectContaining({
        config: seededConfig,
        diagnosticsEnabled: true,
      }),
    );
  });

  it("does not start diagnostics when disabled", async () => {
    const startDiagnosticHeartbeat = vi.fn<() => void>();

    const result = await runGatewayStartupRuntimePolicyPhase({
      context: createGatewayStartupContext(createSnapshot()),
      isDiagnosticsEnabled: () => false,
      startDiagnosticHeartbeat,
      isRestartEnabled: () => false,
      setGatewaySigusr1RestartPolicy: vi.fn(),
      setPreRestartDeferralCheck: vi.fn(),
      getPendingWorkCount: () => 0,
      seedControlUiAllowedOrigins: async (config) => config,
    });

    expect(startDiagnosticHeartbeat).not.toHaveBeenCalled();
    expect(result.diagnosticsEnabled).toBe(false);
  });

  it("refuses to boot the canonical shared runtime from a feature worktree", async () => {
    const home = makeTempDir();
    const canonicalRepo = path.join(home, "Programming_Projects", "openclaw");
    const sharedConfigPath = path.join(home, ".openclaw", "openclaw.json");
    fs.mkdirSync(canonicalRepo, { recursive: true });
    fs.writeFileSync(path.join(canonicalRepo, "package.json"), '{"name":"openclaw"}\n', "utf8");
    fs.mkdirSync(path.dirname(sharedConfigPath), { recursive: true });
    fs.writeFileSync(sharedConfigPath, "{}\n", "utf8");

    await expect(
      runGatewayStartupRuntimePolicyPhase({
        context: createGatewayStartupContext(createSnapshot({ path: sharedConfigPath })),
        isDiagnosticsEnabled: () => false,
        startDiagnosticHeartbeat: vi.fn(),
        isRestartEnabled: () => false,
        setGatewaySigusr1RestartPolicy: vi.fn(),
        setPreRestartDeferralCheck: vi.fn(),
        getPendingWorkCount: () => 0,
        seedControlUiAllowedOrigins: async (config) => config,
        env: { HOME: home },
        runtimeFingerprint: {
          branch: "codex/feature-runtime",
          worktree: path.join(home, "Programming_Projects", "openclaw", ".worktrees", "lane"),
          stateDir: path.join(home, ".openclaw"),
          configPath: sharedConfigPath,
          serviceLabel: "ai.openclaw.gateway",
        },
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<GatewayStartupPreflightError>>({
        phase: "runtime_policy",
        message: expect.stringContaining(
          "Refusing to start the default shared gateway runtime from a non-canonical checkout.",
        ),
      }),
    );
  });

  it("refuses shared LaunchAgent identity from feature worktrees even with noncanonical app-support config", async () => {
    const home = makeTempDir();
    const canonicalRepo = path.join(home, "Programming_Projects", "openclaw");
    const appSupportConfigPath = path.join(
      home,
      "Library",
      "Application Support",
      "OpenClaw",
      ".openclaw",
      "openclaw.json",
    );
    fs.mkdirSync(canonicalRepo, { recursive: true });
    fs.writeFileSync(path.join(canonicalRepo, "package.json"), '{"name":"openclaw"}\n', "utf8");
    fs.mkdirSync(path.dirname(appSupportConfigPath), { recursive: true });
    fs.writeFileSync(appSupportConfigPath, "{}\n", "utf8");

    await expect(
      runGatewayStartupRuntimePolicyPhase({
        context: createGatewayStartupContext(createSnapshot({ path: appSupportConfigPath })),
        isDiagnosticsEnabled: () => false,
        startDiagnosticHeartbeat: vi.fn(),
        isRestartEnabled: () => false,
        setGatewaySigusr1RestartPolicy: vi.fn(),
        setPreRestartDeferralCheck: vi.fn(),
        getPendingWorkCount: () => 0,
        seedControlUiAllowedOrigins: async (config) => config,
        env: {
          HOME: home,
          OPENCLAW_CONFIG_PATH: appSupportConfigPath,
          OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway",
        },
        runtimeFingerprint: {
          branch: "codex/feature-runtime",
          worktree: path.join(home, "Programming_Projects", "openclaw", ".worktrees", "lane"),
          stateDir: path.dirname(appSupportConfigPath),
          configPath: appSupportConfigPath,
          serviceLabel: "ai.openclaw.gateway",
        },
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<GatewayStartupPreflightError>>({
        phase: "runtime_policy",
        message: expect.stringContaining(
          "Refusing to start the default shared gateway runtime from a non-canonical checkout.",
        ),
      }),
    );
  });

  it("allows packaged public Jarvis to own its protected app-support config", async () => {
    const home = makeTempDir();
    const canonicalRepo = path.join(home, "Programming_Projects", "openclaw");
    const jarvisConfigPath = path.join(
      home,
      "Library",
      "Application Support",
      "Jarvis",
      ".jarvis",
      "openclaw.json",
    );
    const jarvisRuntime = path.join(
      home,
      "Library",
      "Application Support",
      "Jarvis",
      ".jarvis",
      "lib",
      "openclaw-bundled",
    );
    fs.mkdirSync(canonicalRepo, { recursive: true });
    fs.writeFileSync(path.join(canonicalRepo, "package.json"), '{"name":"openclaw"}\n', "utf8");
    fs.mkdirSync(path.dirname(jarvisConfigPath), { recursive: true });
    fs.writeFileSync(jarvisConfigPath, "{}\n", "utf8");

    const result = await runGatewayStartupRuntimePolicyPhase({
      context: createGatewayStartupContext(createSnapshot({ path: jarvisConfigPath })),
      isDiagnosticsEnabled: () => false,
      startDiagnosticHeartbeat: vi.fn(),
      isRestartEnabled: () => false,
      setGatewaySigusr1RestartPolicy: vi.fn(),
      setPreRestartDeferralCheck: vi.fn(),
      getPendingWorkCount: () => 0,
      seedControlUiAllowedOrigins: async (config) => config,
      env: {
        HOME: home,
        OPENCLAW_CONFIG_PATH: jarvisConfigPath,
        OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH: jarvisConfigPath,
        OPENCLAW_LAUNCHD_LABEL: "ai.jarvis.gateway",
      },
      runtimeFingerprint: {
        branch: "unknown",
        worktree: jarvisRuntime,
        stateDir: path.dirname(jarvisConfigPath),
        configPath: jarvisConfigPath,
        serviceLabel: "ai.jarvis.gateway",
      },
    });

    expect(result.diagnosticsEnabled).toBe(false);
  });

  it("still refuses public Jarvis label from feature worktrees", async () => {
    const home = makeTempDir();
    const canonicalRepo = path.join(home, "Programming_Projects", "openclaw");
    const jarvisConfigPath = path.join(
      home,
      "Library",
      "Application Support",
      "Jarvis",
      ".jarvis",
      "openclaw.json",
    );
    fs.mkdirSync(canonicalRepo, { recursive: true });
    fs.writeFileSync(path.join(canonicalRepo, "package.json"), '{"name":"openclaw"}\n', "utf8");
    fs.mkdirSync(path.dirname(jarvisConfigPath), { recursive: true });
    fs.writeFileSync(jarvisConfigPath, "{}\n", "utf8");

    await expect(
      runGatewayStartupRuntimePolicyPhase({
        context: createGatewayStartupContext(createSnapshot({ path: jarvisConfigPath })),
        isDiagnosticsEnabled: () => false,
        startDiagnosticHeartbeat: vi.fn(),
        isRestartEnabled: () => false,
        setGatewaySigusr1RestartPolicy: vi.fn(),
        setPreRestartDeferralCheck: vi.fn(),
        getPendingWorkCount: () => 0,
        seedControlUiAllowedOrigins: async (config) => config,
        env: {
          HOME: home,
          OPENCLAW_CONFIG_PATH: jarvisConfigPath,
          OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH: jarvisConfigPath,
          OPENCLAW_LAUNCHD_LABEL: "ai.jarvis.gateway",
        },
        runtimeFingerprint: {
          branch: "codex/feature-runtime",
          worktree: path.join(home, "Programming_Projects", "openclaw", ".worktrees", "lane"),
          stateDir: path.dirname(jarvisConfigPath),
          configPath: jarvisConfigPath,
          serviceLabel: "ai.jarvis.gateway",
        },
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<GatewayStartupPreflightError>>({
        phase: "runtime_policy",
        message: expect.stringContaining(
          "Refusing to start the default shared gateway runtime from a non-canonical checkout.",
        ),
      }),
    );
  });

  it("allows isolated consumer runtime configs from feature worktrees", async () => {
    const home = makeTempDir();
    const canonicalRepo = path.join(home, "Programming_Projects", "openclaw");
    const isolatedConfigPath = path.join(
      home,
      "Library",
      "Application Support",
      "OpenClaw",
      "instances",
      "visible-surface-parity",
      ".openclaw",
      "openclaw.json",
    );
    fs.mkdirSync(canonicalRepo, { recursive: true });
    fs.writeFileSync(path.join(canonicalRepo, "package.json"), '{"name":"openclaw"}\n', "utf8");
    fs.mkdirSync(path.dirname(isolatedConfigPath), { recursive: true });
    fs.writeFileSync(isolatedConfigPath, "{}\n", "utf8");

    const result = await runGatewayStartupRuntimePolicyPhase({
      context: createGatewayStartupContext(createSnapshot({ path: isolatedConfigPath })),
      isDiagnosticsEnabled: () => false,
      startDiagnosticHeartbeat: vi.fn(),
      isRestartEnabled: () => false,
      setGatewaySigusr1RestartPolicy: vi.fn(),
      setPreRestartDeferralCheck: vi.fn(),
      getPendingWorkCount: () => 0,
      seedControlUiAllowedOrigins: async (config) => config,
      env: {
        HOME: home,
        OPENCLAW_PROFILE: "consumer-visible-surface-parity",
        OPENCLAW_CONFIG_PATH: isolatedConfigPath,
      },
      runtimeFingerprint: {
        branch: "codex/visible-surface-parity",
        worktree: path.join(home, "Programming_Projects", "openclaw", ".worktrees", "lane"),
        stateDir: path.dirname(isolatedConfigPath),
        configPath: isolatedConfigPath,
        serviceLabel: "ai.openclaw.consumer.visible-surface-parity.gateway",
      },
    });

    expect(result.diagnosticsEnabled).toBe(false);
  });

  it("allows the canonical shared runtime from the sacred main checkout", async () => {
    const home = makeTempDir();
    const canonicalRepo = path.join(home, "Programming_Projects", "openclaw");
    const sharedConfigPath = path.join(home, ".openclaw", "openclaw.json");
    fs.mkdirSync(canonicalRepo, { recursive: true });
    fs.writeFileSync(path.join(canonicalRepo, "package.json"), '{"name":"openclaw"}\n', "utf8");
    fs.mkdirSync(path.dirname(sharedConfigPath), { recursive: true });
    fs.writeFileSync(sharedConfigPath, "{}\n", "utf8");

    const result = await runGatewayStartupRuntimePolicyPhase({
      context: createGatewayStartupContext(createSnapshot({ path: sharedConfigPath })),
      isDiagnosticsEnabled: () => false,
      startDiagnosticHeartbeat: vi.fn(),
      isRestartEnabled: () => false,
      setGatewaySigusr1RestartPolicy: vi.fn(),
      setPreRestartDeferralCheck: vi.fn(),
      getPendingWorkCount: () => 0,
      seedControlUiAllowedOrigins: async (config) => config,
      env: { HOME: home },
      runtimeFingerprint: {
        branch: "main",
        worktree: canonicalRepo,
        stateDir: path.join(home, ".openclaw"),
        configPath: sharedConfigPath,
        serviceLabel: "ai.openclaw.gateway",
      },
    });

    expect(result.diagnosticsEnabled).toBe(false);
  });

  it("allows explicit break-glass override for the shared runtime", async () => {
    const home = makeTempDir();
    const canonicalRepo = path.join(home, "Programming_Projects", "openclaw");
    const sharedConfigPath = path.join(home, ".openclaw", "openclaw.json");
    fs.mkdirSync(canonicalRepo, { recursive: true });
    fs.writeFileSync(path.join(canonicalRepo, "package.json"), '{"name":"openclaw"}\n', "utf8");
    fs.mkdirSync(path.dirname(sharedConfigPath), { recursive: true });
    fs.writeFileSync(sharedConfigPath, "{}\n", "utf8");

    const result = await runGatewayStartupRuntimePolicyPhase({
      context: createGatewayStartupContext(createSnapshot({ path: sharedConfigPath })),
      isDiagnosticsEnabled: () => false,
      startDiagnosticHeartbeat: vi.fn(),
      isRestartEnabled: () => false,
      setGatewaySigusr1RestartPolicy: vi.fn(),
      setPreRestartDeferralCheck: vi.fn(),
      getPendingWorkCount: () => 0,
      seedControlUiAllowedOrigins: async (config) => config,
      env: {
        HOME: home,
        OPENCLAW_ALLOW_NONCANONICAL_SHARED_RUNTIME: "1",
      },
      runtimeFingerprint: {
        branch: "codex/feature-runtime",
        worktree: path.join(home, "Programming_Projects", "openclaw", ".worktrees", "lane"),
        stateDir: path.join(home, ".openclaw"),
        configPath: sharedConfigPath,
        serviceLabel: "ai.openclaw.gateway",
      },
    });

    expect(result.diagnosticsEnabled).toBe(false);
  });

  it("allows explicit break-glass override for shared LaunchAgent identity with noncanonical config", async () => {
    const home = makeTempDir();
    const canonicalRepo = path.join(home, "Programming_Projects", "openclaw");
    const appSupportConfigPath = path.join(
      home,
      "Library",
      "Application Support",
      "OpenClaw",
      ".openclaw",
      "openclaw.json",
    );
    fs.mkdirSync(canonicalRepo, { recursive: true });
    fs.writeFileSync(path.join(canonicalRepo, "package.json"), '{"name":"openclaw"}\n', "utf8");
    fs.mkdirSync(path.dirname(appSupportConfigPath), { recursive: true });
    fs.writeFileSync(appSupportConfigPath, "{}\n", "utf8");

    const result = await runGatewayStartupRuntimePolicyPhase({
      context: createGatewayStartupContext(createSnapshot({ path: appSupportConfigPath })),
      isDiagnosticsEnabled: () => false,
      startDiagnosticHeartbeat: vi.fn(),
      isRestartEnabled: () => false,
      setGatewaySigusr1RestartPolicy: vi.fn(),
      setPreRestartDeferralCheck: vi.fn(),
      getPendingWorkCount: () => 0,
      seedControlUiAllowedOrigins: async (config) => config,
      env: {
        HOME: home,
        OPENCLAW_CONFIG_PATH: appSupportConfigPath,
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway",
        OPENCLAW_ALLOW_NONCANONICAL_SHARED_RUNTIME: "1",
      },
      runtimeFingerprint: {
        branch: "codex/feature-runtime",
        worktree: path.join(home, "Programming_Projects", "openclaw", ".worktrees", "lane"),
        stateDir: path.dirname(appSupportConfigPath),
        configPath: appSupportConfigPath,
        serviceLabel: "ai.openclaw.gateway",
      },
    });

    expect(result.diagnosticsEnabled).toBe(false);
  });
});

describe("classifyGatewayStartupPreflightError", () => {
  it("classifies concrete startup preflight errors", () => {
    const classified = classifyGatewayStartupPreflightError(
      new GatewayStartupPreflightError("config_validation", "bad config"),
    );

    expect(classified).toEqual({
      phase: "config_validation",
      message: "bad config",
    });
  });

  it("classifies serialized startup preflight errors", () => {
    const classified = classifyGatewayStartupPreflightError({
      name: "GatewayStartupPreflightError",
      phase: "config_legacy_migration",
      message: "legacy keys",
    });

    expect(classified).toEqual({
      phase: "config_legacy_migration",
      message: "legacy keys",
    });
  });

  it("returns null for non-preflight errors", () => {
    expect(classifyGatewayStartupPreflightError(new Error("boom"))).toBeNull();
  });
});

describe("formatGatewayStartupPreflightFailure", () => {
  it("formats classified startup phase failures", () => {
    expect(
      formatGatewayStartupPreflightFailure({
        name: "GatewayStartupPreflightError",
        phase: "config_validation",
        message: "Invalid config",
      }),
    ).toBe("Gateway startup phase failed (config_validation): Invalid config");
  });

  it("returns null for non-classified failures", () => {
    expect(formatGatewayStartupPreflightFailure(new Error("boom"))).toBeNull();
  });
});
