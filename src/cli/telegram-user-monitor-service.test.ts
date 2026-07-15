import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConsumerRuntimeIdentity } from "../consumer/runtime-identity.js";
import { updateListenerHealth } from "../monitor/listener-health.js";

const readConfigMock = vi.hoisted(() => vi.fn());
const resolveGatewayPortMock = vi.hoisted(() => vi.fn());
const buildInstallPlanMock = vi.hoisted(() => vi.fn());
const clearBindingMock = vi.hoisted(() => vi.fn());
const readBindingMock = vi.hoisted(() => vi.fn());
const writeBindingMock = vi.hoisted(() => vi.fn());
const summarizeBindingMock = vi.hoisted(() => vi.fn());
const service = vi.hoisted(() => ({
  install: vi.fn(),
  isLoaded: vi.fn(),
  label: "LaunchAgent",
  loadedText: "loaded",
  notLoadedText: "not loaded",
  readCommand: vi.fn(),
  readRuntime: vi.fn(),
  restart: vi.fn(),
  stop: vi.fn(),
  uninstall: vi.fn(),
}));

vi.mock("../daemon/telegram-monitor-service.js", () => ({
  resolveTelegramMonitorService: () => service,
}));

vi.mock("../config/config.js", () => ({
  readBestEffortConfig: readConfigMock,
  resolveGatewayPort: resolveGatewayPortMock,
}));

vi.mock("../commands/telegram-monitor-service-install-helpers.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../commands/telegram-monitor-service-install-helpers.js")
    >();
  return {
    ...actual,
    buildTelegramMonitorServiceInstallPlan: buildInstallPlanMock,
  };
});

vi.mock("../telegram-user/monitor-service-binding.js", () => ({
  clearTelegramUserMonitorBinding: clearBindingMock,
  readTelegramUserMonitorBinding: readBindingMock,
  summarizeTelegramUserMonitorBinding: summarizeBindingMock,
  writeTelegramUserMonitorBinding: writeBindingMock,
}));

let runTelegramMonitorServiceStatus: typeof import("./telegram-user-monitor-service.js").runTelegramMonitorServiceStatus;
let runTelegramMonitorServiceInstall: typeof import("./telegram-user-monitor-service.js").runTelegramMonitorServiceInstall;
let runTelegramMonitorServiceUninstall: typeof import("./telegram-user-monitor-service.js").runTelegramMonitorServiceUninstall;
let defaultRuntime: typeof import("../runtime.js").defaultRuntime;

function readLoggedJson(log: ReturnType<typeof vi.spyOn>) {
  const logged = log.mock.calls[0]?.[0];
  expect(typeof logged).toBe("string");
  return JSON.parse(logged as string);
}

beforeAll(async () => {
  ({
    runTelegramMonitorServiceInstall,
    runTelegramMonitorServiceStatus,
    runTelegramMonitorServiceUninstall,
  } = await import("./telegram-user-monitor-service.js"));
  ({ defaultRuntime } = await import("../runtime.js"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("telegram-user monitor-service cli", () => {
  beforeEach(() => {
    readConfigMock.mockResolvedValue({});
    resolveGatewayPortMock.mockImplementation(
      (_cfg: unknown, env: Record<string, string | undefined>) =>
        Number(env.OPENCLAW_GATEWAY_PORT?.trim()) || 18789,
    );
    buildInstallPlanMock.mockResolvedValue({
      binding: { env: { OPENCLAW_STATE_DIR: "/state" }, envFile: "/private/account.env" },
      description: "Telegram monitor",
      environment: { OPENCLAW_STATE_DIR: "/state" },
      programArguments: [
        "openclaw",
        "telegram-user",
        "monitor-poll",
        "--env-file",
        "/private/account.env",
        "--session",
        "/private/account.session",
      ],
    });
    clearBindingMock.mockResolvedValue(undefined);
    readBindingMock.mockResolvedValue(null);
    summarizeBindingMock.mockResolvedValue({
      configured: false,
      source: "none",
      envFile: { configured: false, present: false },
      session: { configured: false, present: false },
    });
    service.readCommand.mockResolvedValue(null);
  });

  it("proves selectors are writable before installing the service", async () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    vi.stubEnv("HOME", "/Users/test");
    vi.stubEnv("OPENCLAW_PROFILE", "consumer-lane");
    service.isLoaded.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    service.install.mockResolvedValueOnce(undefined);

    await runTelegramMonitorServiceInstall({ json: true, envFile: "/private/account.env" });

    expect(service.install).toHaveBeenCalledOnce();
    expect(service.isLoaded).toHaveBeenNthCalledWith(1, {
      env: expect.objectContaining({ OPENCLAW_STATE_DIR: expect.any(String) }),
    });
    expect(writeBindingMock).toHaveBeenCalledWith(
      expect.objectContaining({ envFile: "/private/account.env" }),
    );
    expect(readLoggedJson(log)).toMatchObject({ ok: true, result: "installed" });
  });

  it("does not overwrite an existing binding for an already-installed no-op", async () => {
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    readBindingMock.mockResolvedValueOnce({ envFile: "/private/existing.env" });
    service.isLoaded.mockResolvedValueOnce(true);

    await runTelegramMonitorServiceInstall({ json: true, envFile: "/private/replacement.env" });

    expect(buildInstallPlanMock).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
    expect(service.readCommand).not.toHaveBeenCalled();
    expect(writeBindingMock).not.toHaveBeenCalled();
  });

  it("backfills a missing binding from an already-installed command", async () => {
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    service.isLoaded.mockResolvedValueOnce(true);
    service.readCommand.mockResolvedValueOnce({
      programArguments: [
        "openclaw",
        "telegram-user",
        "monitor-poll",
        "--env-file",
        "/private/installed.env",
        "--session",
        "/private/installed.session",
      ],
    });

    await runTelegramMonitorServiceInstall({ json: true });

    expect(buildInstallPlanMock).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
    expect(writeBindingMock).toHaveBeenCalledWith({
      env: expect.any(Object),
      envFile: "/private/installed.env",
      session: "/private/installed.session",
    });
  });

  it("backfills relative legacy selectors from the installed working directory", async () => {
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    service.isLoaded.mockResolvedValueOnce(true);
    service.readCommand.mockResolvedValueOnce({
      workingDirectory: "/opt/openclaw-installed",
      programArguments: [
        "openclaw",
        "telegram-user",
        "monitor-poll",
        "--env-file",
        "config/account.env",
        "--session",
        "state/account.session",
      ],
    });

    await runTelegramMonitorServiceInstall({ json: true });

    expect(writeBindingMock).toHaveBeenCalledWith({
      env: expect.any(Object),
      envFile: "/opt/openclaw-installed/config/account.env",
      session: "/opt/openclaw-installed/state/account.session",
    });
  });

  it("does not overwrite an incompatible binding during legacy backfill", async () => {
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
    service.isLoaded.mockResolvedValueOnce(true);
    readBindingMock.mockRejectedValueOnce(new Error("unsupported binding version"));

    await runTelegramMonitorServiceInstall({ json: true });

    expect(service.readCommand).not.toHaveBeenCalled();
    expect(writeBindingMock).not.toHaveBeenCalled();
  });

  it("does not install when the proposed binding cannot be written", async () => {
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
    service.isLoaded.mockResolvedValueOnce(false);
    writeBindingMock.mockRejectedValueOnce(new Error("binding blocked"));

    await runTelegramMonitorServiceInstall({ json: true, envFile: "/private/account.env" });

    expect(service.install).not.toHaveBeenCalled();
  });

  it("restores the prior binding when a failed install did not load the service", async () => {
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
    readBindingMock.mockResolvedValueOnce({ envFile: "/private/previous.env" });
    service.isLoaded.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    service.install.mockRejectedValueOnce(new Error("install broke"));

    await runTelegramMonitorServiceInstall({ json: true, envFile: "/private/account.env" });

    expect(writeBindingMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        envFile: "/private/account.env",
      }),
    );
    expect(writeBindingMock).toHaveBeenNthCalledWith(2, {
      env: { OPENCLAW_STATE_DIR: "/state" },
      envFile: "/private/previous.env",
    });
    expect(clearBindingMock).not.toHaveBeenCalled();
  });

  it("keeps the new binding when a partial install error still loads the service", async () => {
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
    service.isLoaded.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    service.install.mockRejectedValueOnce(new Error("install reported late failure"));

    await runTelegramMonitorServiceInstall({ json: true, envFile: "/private/account.env" });

    expect(writeBindingMock).toHaveBeenCalledOnce();
    expect(clearBindingMock).not.toHaveBeenCalled();
  });

  it("restores the prior binding when a forced reinstall leaves the old service loaded", async () => {
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
    readBindingMock.mockResolvedValueOnce({ envFile: "/private/previous.env" });
    service.readCommand.mockResolvedValueOnce({
      programArguments: [
        "openclaw",
        "telegram-user",
        "monitor-poll",
        "--env-file",
        "/private/previous.env",
      ],
    });
    service.isLoaded.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    service.install.mockRejectedValueOnce(new Error("forced install broke"));

    await runTelegramMonitorServiceInstall({
      force: true,
      json: true,
      envFile: "/private/account.env",
    });

    expect(writeBindingMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ envFile: "/private/account.env" }),
    );
    expect(writeBindingMock).toHaveBeenNthCalledWith(2, {
      env: { OPENCLAW_STATE_DIR: "/state" },
      envFile: "/private/previous.env",
    });
  });

  it("refuses forced replacement when EnvironmentFile values cannot be restored", async () => {
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
    service.isLoaded.mockResolvedValueOnce(true);
    service.readCommand.mockResolvedValueOnce({
      environment: { OPENCLAW_GATEWAY_TOKEN: "resolved-secret" },
      environmentValueSources: { OPENCLAW_GATEWAY_TOKEN: "file" },
      programArguments: ["openclaw", "telegram-user", "monitor-poll"],
    });

    await runTelegramMonitorServiceInstall({ force: true, json: true });

    expect(buildInstallPlanMock).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
  });

  it("refuses forced replacement when an empty EnvironmentFile directive is installed", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-unit-"));
    const sourcePath = path.join(tempDir, "telegram-monitor.service");
    await fs.writeFile(
      sourcePath,
      "[Service]\nEnvironmentFile=-/missing/operator.env\nExecStart=/usr/bin/openclaw\n",
    );
    try {
      vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
      vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
      service.isLoaded.mockResolvedValueOnce(false);
      service.readCommand.mockResolvedValueOnce({
        programArguments: ["openclaw", "telegram-user", "monitor-poll"],
        sourcePath,
      });

      await runTelegramMonitorServiceInstall({ force: true, json: true });

      expect(buildInstallPlanMock).not.toHaveBeenCalled();
      expect(service.install).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });

  it("restores a stopped prior command and binding after forced replacement fails", async () => {
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
    const previousCommand = {
      programArguments: [
        "openclaw",
        "telegram-user",
        "monitor-poll",
        "--env-file",
        "/private/previous.env",
      ],
    };
    readBindingMock.mockResolvedValueOnce({ envFile: "/private/previous.env" });
    service.isLoaded.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    service.readCommand.mockResolvedValueOnce(previousCommand).mockResolvedValueOnce(null);
    service.install
      .mockRejectedValueOnce(new Error("replacement failed"))
      .mockResolvedValueOnce(undefined);

    await runTelegramMonitorServiceInstall({
      force: true,
      json: true,
      envFile: "/private/account.env",
    });

    expect(service.install).toHaveBeenCalledTimes(2);
    expect(service.install).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ programArguments: previousCommand.programArguments }),
    );
    expect(writeBindingMock).toHaveBeenNthCalledWith(2, {
      env: { OPENCLAW_STATE_DIR: "/state" },
      envFile: "/private/previous.env",
    });
  });

  it("restores the prior binding when a failed replacement rewrites the unit file", async () => {
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
    readBindingMock.mockResolvedValueOnce({ envFile: "/private/previous.env" });
    service.readCommand.mockResolvedValueOnce({
      programArguments: [
        "openclaw",
        "telegram-user",
        "monitor-poll",
        "--env-file",
        "/private/previous.env",
      ],
    });
    service.isLoaded.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    service.install.mockRejectedValueOnce(new Error("install reported late failure"));

    await runTelegramMonitorServiceInstall({
      force: true,
      json: true,
      envFile: "/private/account.env",
    });

    expect(writeBindingMock).toHaveBeenNthCalledWith(2, {
      env: { OPENCLAW_STATE_DIR: "/state" },
      envFile: "/private/previous.env",
    });
    expect(clearBindingMock).not.toHaveBeenCalled();
  });

  it("restores the prior binding when a failed replacement leaves the service unloaded", async () => {
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
    readBindingMock.mockResolvedValueOnce({ envFile: "/private/previous.env" });
    service.readCommand.mockResolvedValueOnce({
      programArguments: [
        "openclaw",
        "telegram-user",
        "monitor-poll",
        "--env-file",
        "/private/previous.env",
      ],
    });
    service.isLoaded.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    service.install.mockRejectedValueOnce(new Error("replacement bootstrap failed"));

    await runTelegramMonitorServiceInstall({
      force: true,
      json: true,
      envFile: "/private/account.env",
    });

    expect(writeBindingMock).toHaveBeenNthCalledWith(2, {
      env: { OPENCLAW_STATE_DIR: "/state" },
      envFile: "/private/previous.env",
    });
    expect(clearBindingMock).not.toHaveBeenCalled();
  });

  it("clears the monitor-owned selector binding after a successful uninstall", async () => {
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    service.isLoaded.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    service.uninstall.mockResolvedValueOnce(undefined);

    await runTelegramMonitorServiceUninstall({ json: true });

    expect(service.uninstall).toHaveBeenCalledOnce();
    expect(clearBindingMock).toHaveBeenCalledOnce();
    expect(clearBindingMock).toHaveBeenCalledWith(service.uninstall.mock.calls[0]?.[0]?.env);
  });

  it("preserves the selector binding when service uninstall fails", async () => {
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
    service.isLoaded.mockResolvedValueOnce(true);
    service.uninstall.mockRejectedValueOnce(new Error("uninstall broke"));

    await runTelegramMonitorServiceUninstall({ json: true });

    expect(clearBindingMock).not.toHaveBeenCalled();
  });

  it("preserves the selector binding when the service remains loaded after uninstall", async () => {
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
    service.isLoaded.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    service.uninstall.mockResolvedValueOnce(undefined);

    await runTelegramMonitorServiceUninstall({ json: true });

    expect(clearBindingMock).not.toHaveBeenCalled();
  });

  it("preserves the selector binding when service removal cannot be verified", async () => {
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
    service.isLoaded
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("status unavailable"));
    service.uninstall.mockResolvedValueOnce(undefined);

    await runTelegramMonitorServiceUninstall({ json: true });

    expect(clearBindingMock).not.toHaveBeenCalled();
  });

  it("renders status with profile-scoped runtime identity", async () => {
    const identity = resolveConsumerRuntimeIdentity({
      homeDir: "/Users/test",
      instanceId: "lane",
    });
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    service.isLoaded.mockResolvedValueOnce(false);
    service.readCommand.mockResolvedValueOnce({
      environment: {
        OPENCLAW_CONFIG_PATH: "/wrong/config.json",
        OPENCLAW_GATEWAY_PORT: "9999",
        OPENCLAW_GATEWAY_TOKEN: "secret-token",
        OPENCLAW_PROFILE: "wrong-lane",
        OPENCLAW_STATE_DIR: "/wrong/state",
      },
      programArguments: [
        "openclaw",
        "telegram-user",
        "monitor-poll",
        "--env-file",
        "/private/account.env",
        "--session",
        "/private/account.session",
      ],
    });
    service.readRuntime.mockResolvedValueOnce({ status: "unknown" });
    vi.stubEnv("HOME", "/Users/test");
    vi.stubEnv("OPENCLAW_PROFILE", "consumer-lane");

    await runTelegramMonitorServiceStatus({ json: true });

    const payload = readLoggedJson(log) as {
      service?: {
        acceptance?: {
          configured?: boolean;
          healthy?: boolean;
          ownership?: {
            config?: { configured?: boolean; matches?: boolean };
            profile?: { configured?: boolean; matches?: boolean };
            state?: { configured?: boolean; matches?: boolean };
            selectors?: { envFile?: boolean; session?: boolean };
          };
        };
        binding?: unknown;
        command?: { environment?: Record<string, string>; programArguments?: string[] };
        defaultHookUrl?: string;
      };
    };
    expect(payload.service?.defaultHookUrl).toBe(
      `http://127.0.0.1:${identity.gatewayPort}/hooks/telegram-user-monitor-event`,
    );
    expect(payload.service?.command?.environment).toEqual({
      OPENCLAW_CONFIG_PATH: "/wrong/config.json",
      OPENCLAW_GATEWAY_PORT: "9999",
      OPENCLAW_PROFILE: "wrong-lane",
      OPENCLAW_STATE_DIR: "/wrong/state",
    });
    expect(payload.service?.command?.programArguments).toContain("<configured>");
    expect(payload.service?.acceptance).toMatchObject({
      configured: true,
      healthy: false,
      ownership: {
        config: { configured: true, matches: false },
        profile: { configured: true, matches: false },
        state: { configured: true, matches: false },
        selectors: { envFile: true, session: true },
      },
    });
    expect(JSON.stringify(payload)).not.toContain("/private/account");
    expect(service.isLoaded).toHaveBeenCalledWith({
      env: expect.objectContaining({
        OPENCLAW_GATEWAY_PORT: String(identity.gatewayPort),
        OPENCLAW_PROFILE: "consumer-lane",
      }),
    });
  });

  it("renders the default hook URL from the configured gateway port", async () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    service.isLoaded.mockResolvedValueOnce(false);
    service.readCommand.mockResolvedValueOnce(null);
    service.readRuntime.mockResolvedValueOnce({ status: "unknown" });
    readConfigMock.mockResolvedValueOnce({ gateway: { port: 19999 } });
    resolveGatewayPortMock.mockReturnValueOnce(19999);
    vi.stubEnv("HOME", "/Users/test");

    await runTelegramMonitorServiceStatus({ json: true });

    const payload = readLoggedJson(log) as {
      service?: { defaultHookUrl?: string };
    };
    expect(resolveGatewayPortMock).toHaveBeenCalledWith(
      { gateway: { port: 19999 } },
      expect.objectContaining({ HOME: "/Users/test" }),
    );
    expect(payload.service?.defaultHookUrl).toBe(
      "http://127.0.0.1:19999/hooks/telegram-user-monitor-event",
    );
  });

  it("keeps status available when the binding metadata is unreadable", async () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    service.isLoaded.mockResolvedValueOnce(false);
    service.readCommand.mockResolvedValueOnce(null);
    service.readRuntime.mockResolvedValueOnce({ status: "unknown" });
    summarizeBindingMock.mockRejectedValueOnce(new Error("binding unreadable"));

    await runTelegramMonitorServiceStatus({ json: true });

    expect(readLoggedJson(log)).toMatchObject({
      service: {
        acceptance: { unavailable: { binding: true } },
        binding: {
          configured: false,
          source: "unavailable",
          envFile: { configured: false, present: false },
          session: { configured: false, present: false },
        },
      },
    });
  });

  it("distinguishes a healthy service from unavailable observations", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-health-status-"));
    const monitorStore = path.join(root, "monitors.json");
    await updateListenerHealth({
      check: "success",
      nowMs: Date.now(),
      owner: { pid: 1234, profile: "test", startedAtMs: Date.now() - 1_000 },
      pollIntervalMs: 1_000,
      service: "telegram-user",
      storePath: path.join(root, "listener-health.json"),
    });
    const healthyLog = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    service.isLoaded.mockResolvedValueOnce(true);
    service.readCommand.mockResolvedValueOnce({
      programArguments: [
        "openclaw",
        "telegram-user",
        "monitor-poll",
        "--hook-url",
        "https://[::1]:18789/hooks/telegram-user-monitor-event",
        "--monitor-store",
        monitorStore,
        "--poll-interval-ms",
        "1000",
      ],
    });
    service.readRuntime.mockResolvedValueOnce({ pid: 1234, status: "running" });

    await runTelegramMonitorServiceStatus({ json: true });

    expect(readLoggedJson(healthyLog)).toMatchObject({
      service: {
        acceptance: {
          configured: true,
          loaded: true,
          healthy: true,
          ownership: {
            hook: { configured: true, loopback: true },
            listener: { pidMatches: true },
          },
        },
      },
    });

    healthyLog.mockClear();
    service.isLoaded.mockRejectedValueOnce(new Error("load unavailable"));
    service.readCommand.mockRejectedValueOnce(new Error("command unavailable"));
    service.readRuntime.mockRejectedValueOnce(new Error("runtime unavailable"));

    await runTelegramMonitorServiceStatus({ json: true });

    expect(readLoggedJson(healthyLog)).toMatchObject({
      service: {
        acceptance: {
          healthy: false,
          unavailable: { configured: true, loaded: true, runtime: true },
        },
      },
    });
  });

  it("marks a running service unhealthy when its listener heartbeat is stale", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-health-status-"));
    const monitorStore = path.join(root, "monitors.json");
    await updateListenerHealth({
      check: "success",
      nowMs: Date.now() - 31_000,
      owner: { pid: 1234, profile: "test", startedAtMs: Date.now() - 10_000 },
      pollIntervalMs: 1_000,
      service: "telegram-user",
      storePath: path.join(root, "listener-health.json"),
    });
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    service.isLoaded.mockResolvedValueOnce(true);
    service.readCommand.mockResolvedValueOnce({
      programArguments: [
        "openclaw",
        "telegram-user",
        "monitor-poll",
        "--monitor-store",
        monitorStore,
        "--poll-interval-ms",
        "1000",
      ],
    });
    service.readRuntime.mockResolvedValueOnce({ status: "running" });

    await runTelegramMonitorServiceStatus({ json: true });

    expect(readLoggedJson(log)).toMatchObject({
      service: {
        acceptance: { healthy: false },
        listenerHealth: { state: "stale" },
      },
    });
  });

  it("renders bounded listener evidence in human status", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-health-human-"));
    const monitorStore = path.join(root, "monitors.json");
    const storePath = path.join(root, "listener-health.json");
    const owner = { pid: 1234, profile: "test", startedAtMs: Date.now() - 10_000 };
    await updateListenerHealth({
      check: "success",
      nowMs: Date.now() - 1_000,
      owner,
      pollIntervalMs: 1_000,
      routedEvent: true,
      service: "telegram-user",
      storePath,
    });
    await updateListenerHealth({
      check: "failure",
      error: "read_error: private text",
      owner,
      pollIntervalMs: 1_000,
      service: "telegram-user",
      storePath,
    });
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    service.isLoaded.mockResolvedValueOnce(true);
    service.readCommand.mockResolvedValueOnce({
      programArguments: ["openclaw", "--monitor-store", monitorStore],
    });
    service.readRuntime.mockResolvedValueOnce({ pid: 1234, status: "running" });

    await runTelegramMonitorServiceStatus();

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/Listener health:.*state=healthy/));
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(
        /ownerPid=1234.*pidMatch=true.*lastCheck=.*lastRouted=.*failures=1.*error=read_error/,
      ),
    );
  });

  it("rejects a recent heartbeat owned by a prior process", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-health-owner-"));
    const monitorStore = path.join(root, "monitors.json");
    await updateListenerHealth({
      check: "success",
      owner: { pid: 1234 },
      pollIntervalMs: 1_000,
      service: "telegram-user",
      storePath: path.join(root, "listener-health.json"),
    });
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    service.isLoaded.mockResolvedValueOnce(true);
    service.readCommand.mockResolvedValueOnce({
      programArguments: ["openclaw", "--monitor-store", monitorStore],
    });
    service.readRuntime.mockResolvedValueOnce({ pid: 5678, status: "running" });

    await runTelegramMonitorServiceStatus({ json: true });

    expect(readLoggedJson(log)).toMatchObject({
      service: {
        acceptance: {
          healthy: false,
          ownership: { listener: { pidMatches: false } },
        },
        listenerHealth: { state: "healthy" },
      },
    });
  });
});
