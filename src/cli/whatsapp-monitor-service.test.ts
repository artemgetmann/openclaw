import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConsumerRuntimeIdentity } from "../consumer/runtime-identity.js";

const readConfigMock = vi.hoisted(() => vi.fn());
const resolveGatewayPortMock = vi.hoisted(() => vi.fn());
const buildInstallPlanMock = vi.hoisted(() => vi.fn());
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

vi.mock("../daemon/whatsapp-monitor-service.js", () => ({
  resolveWhatsAppMonitorService: () => service,
}));

vi.mock("../config/config.js", () => ({
  readBestEffortConfig: readConfigMock,
  resolveGatewayPort: resolveGatewayPortMock,
}));

vi.mock("../commands/whatsapp-monitor-service-install-helpers.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../commands/whatsapp-monitor-service-install-helpers.js")
    >();
  return { ...actual, buildWhatsAppMonitorServiceInstallPlan: buildInstallPlanMock };
});

let runWhatsAppMonitorServiceStatus: typeof import("./whatsapp-monitor-service.js").runWhatsAppMonitorServiceStatus;
let runWhatsAppMonitorServiceInstall: typeof import("./whatsapp-monitor-service.js").runWhatsAppMonitorServiceInstall;
let runWhatsAppMonitorServiceUninstall: typeof import("./whatsapp-monitor-service.js").runWhatsAppMonitorServiceUninstall;
let defaultRuntime: typeof import("../runtime.js").defaultRuntime;

function readLoggedJson(log: ReturnType<typeof vi.spyOn>) {
  const logged = log.mock.calls[0]?.[0];
  expect(typeof logged).toBe("string");
  return JSON.parse(logged as string);
}

beforeAll(async () => {
  ({
    runWhatsAppMonitorServiceInstall,
    runWhatsAppMonitorServiceStatus,
    runWhatsAppMonitorServiceUninstall,
  } = await import("./whatsapp-monitor-service.js"));
  ({ defaultRuntime } = await import("../runtime.js"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  readConfigMock.mockResolvedValue({});
  resolveGatewayPortMock.mockImplementation(
    (_cfg: unknown, env: Record<string, string | undefined>) =>
      Number(env.OPENCLAW_GATEWAY_PORT?.trim()) || 18789,
  );
});

describe("whatsapp-monitor monitor-service cli", () => {
  beforeEach(() => {
    readConfigMock.mockResolvedValue({});
    resolveGatewayPortMock.mockImplementation(
      (_cfg: unknown, env: Record<string, string | undefined>) =>
        Number(env.OPENCLAW_GATEWAY_PORT?.trim()) || 18789,
    );
    buildInstallPlanMock.mockResolvedValue({
      description: "WhatsApp monitor",
      environment: { OPENCLAW_STATE_DIR: "/state" },
      programArguments: [
        "openclaw",
        "whatsapp-monitor",
        "poll",
        "--db-path",
        "/private/wacli.db",
        "--hook-url",
        "http://127.0.0.1:18789/hooks/monitor-event",
      ],
    });
    service.readCommand.mockResolvedValue(null);
  });

  it("restores a stopped prior durable command after a failed forced replacement", async () => {
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
    const previousCommand = {
      environment: { OPENCLAW_STATE_DIR: "/previous-state" },
      programArguments: ["openclaw", "whatsapp-monitor", "poll", "--db-path", "/previous/wacli.db"],
      workingDirectory: "/previous/repo",
    };
    service.isLoaded.mockResolvedValueOnce(false);
    service.readCommand.mockResolvedValueOnce(previousCommand);
    service.install
      .mockRejectedValueOnce(new Error("replacement failed"))
      .mockResolvedValueOnce(undefined);

    await runWhatsAppMonitorServiceInstall({
      dbPath: "/private/wacli.db",
      force: true,
      json: true,
    });

    expect(service.install).toHaveBeenCalledTimes(2);
    expect(service.install).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        environment: previousCommand.environment,
        programArguments: previousCommand.programArguments,
        workingDirectory: previousCommand.workingDirectory,
      }),
    );
  });

  it("refuses forced replacement when EnvironmentFile values cannot be restored", async () => {
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
    service.isLoaded.mockResolvedValueOnce(true);
    service.readCommand.mockResolvedValueOnce({
      environment: { OPENCLAW_GATEWAY_TOKEN: "resolved-secret" },
      environmentValueSources: { OPENCLAW_GATEWAY_TOKEN: "file" },
      programArguments: ["openclaw", "whatsapp-monitor", "poll"],
    });

    await runWhatsAppMonitorServiceInstall({
      dbPath: "/private/wacli.db",
      force: true,
      json: true,
    });

    expect(buildInstallPlanMock).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
  });

  it("refuses forced replacement when an empty EnvironmentFile directive is installed", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-whatsapp-unit-"));
    const sourcePath = path.join(tempDir, "whatsapp-monitor.service");
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
        programArguments: ["openclaw", "whatsapp-monitor", "poll"],
        sourcePath,
      });

      await runWhatsAppMonitorServiceInstall({
        dbPath: "/private/wacli.db",
        force: true,
        json: true,
      });

      expect(buildInstallPlanMock).not.toHaveBeenCalled();
      expect(service.install).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });

  it("verifies removal before reporting uninstall success", async () => {
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    service.isLoaded.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    service.uninstall.mockResolvedValueOnce(undefined);

    await runWhatsAppMonitorServiceUninstall({ json: true });

    expect(service.isLoaded).toHaveBeenCalledTimes(2);
  });

  it("renders status with profile-scoped runtime identity and redacted environment", async () => {
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
        "whatsapp-monitor",
        "poll",
        "--db-path",
        "/private/wacli.db",
        "--hook-url",
        "http://127.0.0.1:9999/hooks/monitor-event",
        "--watch",
      ],
    });
    service.readRuntime.mockResolvedValueOnce({ status: "unknown" });
    vi.stubEnv("HOME", "/Users/test");
    vi.stubEnv("OPENCLAW_PROFILE", "consumer-lane");

    await runWhatsAppMonitorServiceStatus({ json: true });

    const payload = readLoggedJson(log) as {
      service?: {
        acceptance?: {
          configured?: boolean;
          healthy?: boolean;
          ownership?: {
            config?: { configured?: boolean; matches?: boolean };
            hook?: { loopback?: boolean };
            profile?: { configured?: boolean; matches?: boolean };
            state?: { configured?: boolean; matches?: boolean };
          };
        };
        command?: { environment?: Record<string, string>; programArguments?: string[] };
        defaultHookUrl?: string;
      };
    };
    expect(payload.service?.defaultHookUrl).toBe(
      `http://127.0.0.1:${identity.gatewayPort}/hooks/monitor-event`,
    );
    expect(payload.service?.command?.environment).toEqual({
      OPENCLAW_CONFIG_PATH: "/wrong/config.json",
      OPENCLAW_GATEWAY_PORT: "9999",
      OPENCLAW_PROFILE: "wrong-lane",
      OPENCLAW_STATE_DIR: "/wrong/state",
    });
    expect(payload.service?.acceptance).toMatchObject({
      configured: true,
      healthy: false,
      ownership: {
        config: { configured: true, matches: false },
        hook: { loopback: true },
        profile: { configured: true, matches: false },
        state: { configured: true, matches: false },
      },
    });
    expect(payload.service?.command?.programArguments).toContain("<configured>");
    expect(JSON.stringify(payload)).not.toContain("/private/wacli.db");
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

    await runWhatsAppMonitorServiceStatus({ json: true });

    const payload = readLoggedJson(log) as {
      service?: { defaultHookUrl?: string };
    };
    expect(resolveGatewayPortMock).toHaveBeenCalledWith(
      { gateway: { port: 19999 } },
      expect.objectContaining({ HOME: "/Users/test" }),
    );
    expect(payload.service?.defaultHookUrl).toBe("http://127.0.0.1:19999/hooks/monitor-event");
  });

  it("distinguishes a healthy service from unavailable observations", async () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    service.isLoaded.mockResolvedValueOnce(true);
    service.readCommand.mockResolvedValueOnce({
      programArguments: [
        "openclaw",
        "whatsapp-monitor",
        "poll",
        "--db-path",
        "/private/wacli.db",
        "--hook-url",
        "https://[::1]:18789/hooks/monitor-event",
      ],
    });
    service.readRuntime.mockResolvedValueOnce({ status: "running" });

    await runWhatsAppMonitorServiceStatus({ json: true });

    expect(readLoggedJson(log)).toMatchObject({
      service: {
        acceptance: {
          configured: true,
          loaded: true,
          healthy: true,
          ownership: { hook: { configured: true, loopback: true } },
        },
      },
    });

    log.mockClear();
    service.isLoaded.mockRejectedValueOnce(new Error("load unavailable"));
    service.readCommand.mockRejectedValueOnce(new Error("command unavailable"));
    service.readRuntime.mockRejectedValueOnce(new Error("runtime unavailable"));

    await runWhatsAppMonitorServiceStatus({ json: true });

    expect(readLoggedJson(log)).toMatchObject({
      service: {
        acceptance: {
          healthy: false,
          unavailable: { configured: true, loaded: true, runtime: true },
        },
      },
    });
  });
});
