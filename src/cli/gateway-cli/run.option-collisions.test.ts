import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempSecretFiles } from "../../test-utils/secret-file-fixture.js";
import { createCliRuntimeCapture } from "../test-runtime-capture.js";

const startGatewayServer = vi.fn(async (_port: number, _opts?: unknown) => ({
  close: vi.fn(async () => {}),
}));
const setGatewayWsLogStyle = vi.fn((_style: string) => undefined);
const setVerbose = vi.fn((_enabled: boolean) => undefined);
const forceFreePortAndWait = vi.fn(async (_port: number, _opts: unknown) => ({
  killed: [],
  waitedMs: 0,
  escalatedToSigkill: false,
}));
const waitForPortBindable = vi.fn(async (_port: number, _opts?: unknown) => 0);
const ensureDevGatewayConfig = vi.fn(async (_opts?: unknown) => {});
const cleanStaleGatewayProcessesSync = vi.fn((_port: number) => []);
const createStartupContext = (config: Record<string, unknown>) => ({
  config,
  preflightSnapshot: configState.snapshot,
  secretsPrechecked: false,
  authBootstrap: { generatedToken: false, persistedGeneratedToken: false },
  diagnosticsEnabled: false,
});
const runGatewayStartupConfigPreflight = vi.fn(async () => createStartupContext(configState.cfg));
const assertGatewayStagedRestartSnapshotFresh = vi.fn((_params: unknown) => undefined);
const runGatewayLoop = vi.fn(async ({ start }: { start: () => Promise<unknown> }) => {
  await start();
});
const configState = vi.hoisted(() => ({
  cfg: {} as Record<string, unknown>,
  snapshot: { exists: false } as Record<string, unknown>,
}));

const { runtimeErrors, defaultRuntime, resetRuntimeCapture } = createCliRuntimeCapture();

vi.mock("../../config/config.js", () => ({
  getConfigPath: () => "/tmp/openclaw-test-missing-config.json",
  isNixMode: false,
  readConfigFileSnapshot: async () => configState.snapshot,
  resolveStateDir: () => "/tmp",
  resolveGatewayPort: (cfg: { gateway?: { port?: number } }) => cfg.gateway?.port ?? 18789,
  writeConfigFile: async () => undefined,
}));

vi.mock("../../gateway/auth.js", () => ({
  resolveGatewayAuth: (params: {
    authConfig?: { mode?: string; token?: unknown; password?: unknown };
    authOverride?: { mode?: string; token?: unknown; password?: unknown };
    env?: NodeJS.ProcessEnv;
  }) => {
    const mode = params.authOverride?.mode ?? params.authConfig?.mode ?? "token";
    const token =
      (typeof params.authOverride?.token === "string" ? params.authOverride.token : undefined) ??
      (typeof params.authConfig?.token === "string" ? params.authConfig.token : undefined) ??
      params.env?.OPENCLAW_GATEWAY_TOKEN;
    const password =
      (typeof params.authOverride?.password === "string"
        ? params.authOverride.password
        : undefined) ??
      (typeof params.authConfig?.password === "string" ? params.authConfig.password : undefined) ??
      params.env?.OPENCLAW_GATEWAY_PASSWORD;
    return {
      mode,
      token,
      password,
      allowTailscale: false,
    };
  },
}));

vi.mock("../../gateway/server-startup-preflight.js", () => ({
  assertGatewayStagedRestartSnapshotFresh: (params: unknown) =>
    assertGatewayStagedRestartSnapshotFresh(params),
  formatGatewayStartupPreflightFailure: (err: unknown) => {
    const candidate = err as { name?: string; phase?: string; message?: string };
    return candidate?.name === "GatewayStartupPreflightError"
      ? `Gateway startup phase failed (${candidate.phase}): ${candidate.message}`
      : null;
  },
  runGatewayStartupConfigPreflight: () => runGatewayStartupConfigPreflight(),
}));

vi.mock("../../infra/restart-stale-pids.js", () => ({
  cleanStaleGatewayProcessesSync: (port: number) => cleanStaleGatewayProcessesSync(port),
}));

vi.mock("../../gateway/server.js", () => ({
  startGatewayServer: (port: number, opts?: unknown) => startGatewayServer(port, opts),
}));

vi.mock("../../gateway/ws-logging.js", () => ({
  setGatewayWsLogStyle: (style: string) => setGatewayWsLogStyle(style),
}));

vi.mock("../../globals.js", () => ({
  setVerbose: (enabled: boolean) => setVerbose(enabled),
}));

vi.mock("../../infra/gateway-lock.js", () => ({
  GatewayLockError: class GatewayLockError extends Error {},
}));

vi.mock("../../infra/ports.js", () => ({
  formatPortDiagnostics: () => [],
  inspectPortUsage: async () => ({ status: "free" }),
}));

vi.mock("../../logging/console.js", () => ({
  setConsoleSubsystemFilter: () => undefined,
  setConsoleTimestampPrefix: () => undefined,
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => {
    const logger = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      child: () => logger,
    };
    return logger;
  },
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime,
}));

vi.mock("../command-format.js", () => ({
  formatCliCommand: (cmd: string) => cmd,
}));

vi.mock("../ports.js", () => ({
  forceFreePortAndWait: (port: number, opts: unknown) => forceFreePortAndWait(port, opts),
  waitForPortBindable: (port: number, opts?: unknown) => waitForPortBindable(port, opts),
}));

vi.mock("./dev.js", () => ({
  ensureDevGatewayConfig: (opts?: unknown) => ensureDevGatewayConfig(opts),
}));

vi.mock("./run-loop.js", () => ({
  runGatewayLoop: (params: { start: () => Promise<unknown> }) => runGatewayLoop(params),
}));

describe("gateway run option collisions", () => {
  let addGatewayRunCommand: typeof import("./run.js").addGatewayRunCommand;
  let sharedProgram: Command;

  beforeAll(async () => {
    ({ addGatewayRunCommand } = await import("./run.js"));
    sharedProgram = new Command();
    sharedProgram.exitOverride();
    const gateway = addGatewayRunCommand(sharedProgram.command("gateway"));
    addGatewayRunCommand(gateway.command("run"));
  });

  beforeEach(() => {
    resetRuntimeCapture();
    configState.cfg = {};
    configState.snapshot = { exists: false };
    startGatewayServer.mockClear();
    setGatewayWsLogStyle.mockClear();
    setVerbose.mockClear();
    forceFreePortAndWait.mockClear();
    waitForPortBindable.mockClear();
    ensureDevGatewayConfig.mockClear();
    cleanStaleGatewayProcessesSync.mockClear();
    runGatewayStartupConfigPreflight.mockClear();
    runGatewayStartupConfigPreflight.mockImplementation(async () =>
      createStartupContext(configState.cfg),
    );
    assertGatewayStagedRestartSnapshotFresh.mockClear();
    assertGatewayStagedRestartSnapshotFresh.mockImplementation(() => undefined);
    runGatewayLoop.mockClear();
  });

  async function runGatewayCli(argv: string[]) {
    await sharedProgram.parseAsync(argv, { from: "user" });
  }

  function expectAuthOverrideMode(mode: string) {
    expect(startGatewayServer).toHaveBeenCalledWith(
      18789,
      expect.objectContaining({
        auth: expect.objectContaining({
          mode,
        }),
      }),
    );
  }

  it("forwards parent-captured options to `gateway run` subcommand", async () => {
    await runGatewayCli([
      "gateway",
      "run",
      "--token",
      "tok_run",
      "--allow-unconfigured",
      "--ws-log",
      "full",
      "--force",
    ]);

    expect(forceFreePortAndWait).toHaveBeenCalledWith(18789, expect.anything());
    expect(waitForPortBindable).toHaveBeenCalledWith(
      18789,
      expect.objectContaining({ host: "127.0.0.1" }),
    );
    expect(setGatewayWsLogStyle).toHaveBeenCalledWith("full");
    expect(startGatewayServer).toHaveBeenCalledWith(
      18789,
      expect.objectContaining({
        auth: expect.objectContaining({
          token: "tok_run",
        }),
      }),
    );
  });

  it("starts gateway when token mode has no configured token (startup bootstrap path)", async () => {
    await runGatewayCli(["gateway", "run", "--allow-unconfigured"]);

    expect(startGatewayServer).toHaveBeenCalledWith(
      18789,
      expect.objectContaining({
        bind: "loopback",
      }),
    );
  });

  it("migrates legacy consumer model config before resolving gateway defaults", async () => {
    const legacyConfig = {
      jarvis: { managedServices: { mode: "managed" } },
      gateway: { mode: "local", port: 18888, bind: "lan" },
      agents: {
        defaults: {
          model: { primary: "openai-codex/gpt-5.5" },
          models: { "openai-codex/gpt-5.5": {} },
        },
      },
    };
    const migratedConfig = {
      gateway: { mode: "local", port: 19991, bind: "loopback" },
      agents: {
        defaults: {
          model: {
            primary: "openai-codex/gpt-5.6-sol",
            fallbacks: ["openai-codex/gpt-5.5"],
          },
          models: {
            "openai-codex/gpt-5.5": {},
            "openai-codex/gpt-5.6-sol": {},
          },
        },
      },
    };
    configState.cfg = legacyConfig;
    configState.snapshot = { exists: true, parsed: legacyConfig };
    runGatewayStartupConfigPreflight.mockImplementationOnce(async () => {
      // This mock marks the exact CLI seam under test: startup preflight sees
      // the persisted GPT-5.5 config and returns its validated migration before
      // gateway run resolves any config-backed option defaults.
      expect((configState.cfg as typeof legacyConfig).agents.defaults.model.primary).toBe(
        "openai-codex/gpt-5.5",
      );
      configState.cfg = migratedConfig;
      configState.snapshot = { exists: true, parsed: migratedConfig };
      return createStartupContext(migratedConfig);
    });

    await runGatewayCli(["gateway", "run"]);

    expect(runGatewayStartupConfigPreflight).toHaveBeenCalledTimes(1);
    expect(startGatewayServer).toHaveBeenCalledWith(
      19991,
      expect.objectContaining({
        bind: "loopback",
        startupContext: expect.objectContaining({ config: migratedConfig }),
      }),
    );
    expect(migratedConfig.agents.defaults.model).toEqual({
      primary: "openai-codex/gpt-5.6-sol",
      fallbacks: ["openai-codex/gpt-5.5"],
    });
  });

  it("fails residual invalid config before gateway startup side effects", async () => {
    runGatewayStartupConfigPreflight.mockRejectedValueOnce({
      name: "GatewayStartupPreflightError",
      phase: "config_validation",
      message: "Invalid config at /tmp/openclaw.json",
    });

    await expect(runGatewayCli(["gateway", "run", "--force"])).rejects.toThrow("__exit__:1");

    expect(runtimeErrors).toContain(
      "Gateway startup phase failed (config_validation): Invalid config at /tmp/openclaw.json",
    );
    expect(forceFreePortAndWait).not.toHaveBeenCalled();
    expect(startGatewayServer).not.toHaveBeenCalled();
  });

  it("rejects a stale preflight context before service cleanup", async () => {
    assertGatewayStagedRestartSnapshotFresh.mockImplementationOnce(() => {
      throw {
        name: "GatewayStartupPreflightError",
        phase: "config_validation",
        message: "Config changed after startup preflight",
      };
    });
    process.env.OPENCLAW_SERVICE_MARKER = "test-service";

    try {
      await expect(
        runGatewayCli(["gateway", "run", "--force", "--allow-unconfigured"]),
      ).rejects.toThrow("__exit__:1");
    } finally {
      delete process.env.OPENCLAW_SERVICE_MARKER;
    }

    expect(runtimeErrors).toContain(
      "Gateway startup phase failed (config_validation): Config changed after startup preflight",
    );
    expect(cleanStaleGatewayProcessesSync).not.toHaveBeenCalled();
    expect(forceFreePortAndWait).not.toHaveBeenCalled();
    expect(startGatewayServer).not.toHaveBeenCalled();
  });

  it("rejects a stale preflight context before forced port cleanup", async () => {
    assertGatewayStagedRestartSnapshotFresh.mockImplementationOnce(() => {
      throw {
        name: "GatewayStartupPreflightError",
        phase: "config_validation",
        message: "Config changed after startup preflight",
      };
    });

    await expect(
      runGatewayCli(["gateway", "run", "--force", "--allow-unconfigured"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors).toContain(
      "Gateway startup phase failed (config_validation): Config changed after startup preflight",
    );
    expect(cleanStaleGatewayProcessesSync).not.toHaveBeenCalled();
    expect(forceFreePortAndWait).not.toHaveBeenCalled();
    expect(startGatewayServer).not.toHaveBeenCalled();
  });

  it("surfaces startup preflight phase classification on startup failure", async () => {
    startGatewayServer.mockRejectedValueOnce({
      name: "GatewayStartupPreflightError",
      phase: "config_validation",
      message: "Invalid config at /tmp/openclaw.json",
    });

    await expect(runGatewayCli(["gateway", "run", "--allow-unconfigured"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors).toContain(
      "Gateway startup phase failed (config_validation): Invalid config at /tmp/openclaw.json",
    );
  });

  it.each(["none", "trusted-proxy"] as const)("accepts --auth %s override", async (mode) => {
    await runGatewayCli(["gateway", "run", "--auth", mode, "--allow-unconfigured"]);

    expectAuthOverrideMode(mode);
  });

  it("prints all supported modes on invalid --auth value", async () => {
    await expect(
      runGatewayCli(["gateway", "run", "--auth", "bad-mode", "--allow-unconfigured"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors).toContain(
      'Invalid --auth (use "none", "token", "password", or "trusted-proxy")',
    );
  });

  it("allows password mode preflight when password is configured via SecretRef", async () => {
    configState.cfg = {
      gateway: {
        auth: {
          mode: "password",
          password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
        },
      },
      secrets: {
        defaults: {
          env: "default",
        },
      },
    };
    configState.snapshot = { exists: true, parsed: configState.cfg };

    await runGatewayCli(["gateway", "run", "--allow-unconfigured"]);

    expect(startGatewayServer).toHaveBeenCalledWith(
      18789,
      expect.objectContaining({
        bind: "loopback",
      }),
    );
  });

  it("reads gateway password from --password-file", async () => {
    await withTempSecretFiles(
      "openclaw-gateway-run-",
      { password: "pw_from_file\n" },
      async ({ passwordFile }) => {
        await runGatewayCli([
          "gateway",
          "run",
          "--auth",
          "password",
          "--password-file",
          passwordFile ?? "",
          "--allow-unconfigured",
        ]);
      },
    );

    expect(startGatewayServer).toHaveBeenCalledWith(
      18789,
      expect.objectContaining({
        auth: expect.objectContaining({
          mode: "password",
          password: "pw_from_file", // pragma: allowlist secret
        }),
      }),
    );
    expect(runtimeErrors).not.toContain(
      "Warning: --password can be exposed via process listings. Prefer --password-file or OPENCLAW_GATEWAY_PASSWORD.",
    );
  });

  it("warns when gateway password is passed inline", async () => {
    await runGatewayCli([
      "gateway",
      "run",
      "--auth",
      "password",
      "--password",
      "pw_inline",
      "--allow-unconfigured",
    ]);

    expect(runtimeErrors).toContain(
      "Warning: --password can be exposed via process listings. Prefer --password-file or OPENCLAW_GATEWAY_PASSWORD.",
    );
  });

  it("rejects using both --password and --password-file", async () => {
    await withTempSecretFiles(
      "openclaw-gateway-run-",
      { password: "pw_from_file\n" },
      async ({ passwordFile }) => {
        await expect(
          runGatewayCli([
            "gateway",
            "run",
            "--password",
            "pw_inline",
            "--password-file",
            passwordFile ?? "",
            "--allow-unconfigured",
          ]),
        ).rejects.toThrow("__exit__:1");
      },
    );

    expect(runtimeErrors).toContain("Use either --password or --password-file.");
  });
});
