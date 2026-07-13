import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConsumerRuntimeIdentity } from "../consumer/runtime-identity.js";

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
let defaultRuntime: typeof import("../runtime.js").defaultRuntime;

function readLoggedJson(log: ReturnType<typeof vi.spyOn>) {
  const logged = log.mock.calls[0]?.[0];
  expect(typeof logged).toBe("string");
  return JSON.parse(logged as string);
}

beforeAll(async () => {
  ({ runTelegramMonitorServiceInstall, runTelegramMonitorServiceStatus } =
    await import("./telegram-user-monitor-service.js"));
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
    service.isLoaded.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    service.install.mockRejectedValueOnce(new Error("forced install broke"));
    service.readCommand.mockResolvedValueOnce({
      programArguments: [
        "openclaw",
        "telegram-user",
        "monitor-poll",
        "--env-file",
        "/private/previous.env",
      ],
    });

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

  it("retains the new binding when a forced reinstall updated the loaded service command", async () => {
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
    readBindingMock.mockResolvedValueOnce({ envFile: "/private/previous.env" });
    service.isLoaded.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    service.install.mockRejectedValueOnce(new Error("install reported late failure"));
    service.readCommand.mockResolvedValueOnce({
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

    await runTelegramMonitorServiceInstall({
      force: true,
      json: true,
      envFile: "/private/account.env",
    });

    expect(writeBindingMock).toHaveBeenCalledOnce();
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
        OPENCLAW_GATEWAY_PORT: "9999",
        OPENCLAW_GATEWAY_TOKEN: "secret-token",
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
        binding?: unknown;
        command?: { environment?: Record<string, string>; programArguments?: string[] };
        defaultHookUrl?: string;
      };
    };
    expect(payload.service?.defaultHookUrl).toBe(
      `http://127.0.0.1:${identity.gatewayPort}/hooks/telegram-user-monitor-event`,
    );
    expect(payload.service?.command?.environment).toEqual({
      OPENCLAW_GATEWAY_PORT: "9999",
    });
    expect(payload.service?.command?.programArguments).toContain("<configured>");
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
});
