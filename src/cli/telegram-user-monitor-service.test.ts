import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConsumerRuntimeIdentity } from "../consumer/runtime-identity.js";

const readConfigMock = vi.hoisted(() => vi.fn());
const resolveGatewayPortMock = vi.hoisted(() => vi.fn());
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

let runTelegramMonitorServiceStatus: typeof import("./telegram-user-monitor-service.js").runTelegramMonitorServiceStatus;
let defaultRuntime: typeof import("../runtime.js").defaultRuntime;

function readLoggedJson(log: ReturnType<typeof vi.spyOn>) {
  const logged = log.mock.calls[0]?.[0];
  expect(typeof logged).toBe("string");
  return JSON.parse(logged as string);
}

beforeAll(async () => {
  ({ runTelegramMonitorServiceStatus } = await import("./telegram-user-monitor-service.js"));
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

describe("telegram-user monitor-service cli", () => {
  beforeEach(() => {
    readConfigMock.mockResolvedValue({});
    resolveGatewayPortMock.mockImplementation(
      (_cfg: unknown, env: Record<string, string | undefined>) =>
        Number(env.OPENCLAW_GATEWAY_PORT?.trim()) || 18789,
    );
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
      programArguments: ["openclaw", "telegram-user", "monitor-poll"],
    });
    service.readRuntime.mockResolvedValueOnce({ status: "unknown" });
    vi.stubEnv("HOME", "/Users/test");
    vi.stubEnv("OPENCLAW_PROFILE", "consumer-lane");

    await runTelegramMonitorServiceStatus({ json: true });

    const payload = readLoggedJson(log) as {
      service?: {
        command?: { environment?: Record<string, string> };
        defaultHookUrl?: string;
      };
    };
    expect(payload.service?.defaultHookUrl).toBe(
      `http://127.0.0.1:${identity.gatewayPort}/hooks/telegram-user-monitor-event`,
    );
    expect(payload.service?.command?.environment).toEqual({
      OPENCLAW_GATEWAY_PORT: "9999",
    });
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
