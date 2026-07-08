import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConsumerRuntimeIdentity } from "../consumer/runtime-identity.js";

const programArgsMock = vi.hoisted(() => vi.fn());
const runtimeInputsMock = vi.hoisted(() => vi.fn());
const runtimeWarningMock = vi.hoisted(() => vi.fn());
const readConfigMock = vi.hoisted(() => vi.fn());
const resolveGatewayPortMock = vi.hoisted(() => vi.fn());

vi.mock("../daemon/program-args.js", () => ({
  resolveTelegramMonitorProgramArguments: programArgsMock,
}));

vi.mock("./daemon-install-plan.shared.js", () => ({
  emitDaemonInstallRuntimeWarning: runtimeWarningMock,
  resolveDaemonInstallRuntimeInputs: runtimeInputsMock,
}));

vi.mock("../config/config.js", () => ({
  readBestEffortConfig: readConfigMock,
  resolveGatewayPort: resolveGatewayPortMock,
}));

const { buildTelegramMonitorServiceInstallPlan, resolveDefaultTelegramMonitorHookUrl } =
  await import("./telegram-monitor-service-install-helpers.js");

describe("telegram monitor service install helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeInputsMock.mockResolvedValue({ devMode: false, nodePath: "/usr/local/bin/node" });
    readConfigMock.mockResolvedValue({});
    resolveGatewayPortMock.mockImplementation(
      (_cfg: unknown, env: Record<string, string | undefined>) =>
        Number(env.OPENCLAW_GATEWAY_PORT?.trim()) || 18789,
    );
    programArgsMock.mockResolvedValue({
      programArguments: [
        "/usr/local/bin/node",
        "/repo/dist/index.js",
        "telegram-user",
        "monitor-poll",
      ],
      workingDirectory: "/repo",
    });
  });

  it("defaults the local hook URL from the gateway port", () => {
    expect(resolveDefaultTelegramMonitorHookUrl({ env: { OPENCLAW_GATEWAY_PORT: "18888" } })).toBe(
      "http://127.0.0.1:18888/hooks/telegram-user-monitor-event",
    );
  });

  it("uses the resolved gateway config port for the default hook URL", async () => {
    readConfigMock.mockResolvedValueOnce({ gateway: { port: 19999 } });
    resolveGatewayPortMock.mockReturnValueOnce(19999);

    await buildTelegramMonitorServiceInstallPlan({
      env: { HOME: "/Users/test" },
      intervalMs: 2500,
      runtime: "node",
    });

    expect(resolveGatewayPortMock).toHaveBeenCalledWith(
      { gateway: { port: 19999 } },
      expect.objectContaining({ HOME: "/Users/test" }),
    );
    expect(programArgsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hookUrl: "http://127.0.0.1:19999/hooks/telegram-user-monitor-event",
      }),
    );
  });

  it("rejects invalid hook URLs before building service arguments", async () => {
    await expect(
      buildTelegramMonitorServiceInstallPlan({
        env: { HOME: "/Users/test" },
        hookUrl: "https://example.com/hooks/telegram-user-monitor-event",
        intervalMs: 2500,
        runtime: "node",
      }),
    ).rejects.toThrow("--hook-url must point to the local gateway");
    expect(programArgsMock).not.toHaveBeenCalled();
  });

  it("builds a service plan without putting the hook token in process arguments", async () => {
    const plan = await buildTelegramMonitorServiceInstallPlan({
      cronStore: "/tmp/cron.json",
      cursorStore: "/tmp/cursors.json",
      env: {
        HOME: "/Users/test",
        OPENCLAW_GATEWAY_PORT: "18888",
        OPENCLAW_GATEWAY_TOKEN: " secret-token ",
      },
      envFile: "/tmp/tg.env",
      intervalMs: 2500,
      limit: 12,
      monitorStore: "/tmp/monitors.json",
      runtime: "node",
      session: "/tmp/userbot.session",
    });

    expect(programArgsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cronStore: "/tmp/cron.json",
        cursorStore: "/tmp/cursors.json",
        envFile: "/tmp/tg.env",
        hookUrl: "http://127.0.0.1:18888/hooks/telegram-user-monitor-event",
        intervalMs: 2500,
        limit: 12,
        monitorStore: "/tmp/monitors.json",
        nodePath: "/usr/local/bin/node",
        runtime: "node",
        session: "/tmp/userbot.session",
      }),
    );
    expect(plan.programArguments.join(" ")).not.toContain("secret-token");
    expect(plan.environment.OPENCLAW_GATEWAY_TOKEN).toBe("secret-token");
    expect(plan.environment.OPENCLAW_LAUNCHD_LABEL).toBe("ai.openclaw.telegram-monitor");
    expect(plan.environment.OPENCLAW_SYSTEMD_UNIT).toBe("openclaw-telegram-monitor");
    expect(plan.environment.OPENCLAW_SERVICE_KIND).toBe("telegram-monitor");
  });

  it("defaults the hook URL after resolving consumer runtime identity", async () => {
    const identity = resolveConsumerRuntimeIdentity({
      homeDir: "/Users/test",
      instanceId: "lane",
    });

    const plan = await buildTelegramMonitorServiceInstallPlan({
      env: {
        HOME: "/Users/test",
        OPENCLAW_PROFILE: "consumer-lane",
      },
      intervalMs: 2500,
      runtime: "node",
    });

    expect(programArgsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hookUrl: `http://127.0.0.1:${identity.gatewayPort}/hooks/telegram-user-monitor-event`,
      }),
    );
    expect(runtimeInputsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          OPENCLAW_GATEWAY_PORT: String(identity.gatewayPort),
        }),
      }),
    );
    expect(plan.environment.OPENCLAW_STATE_DIR).toBe(identity.stateDir);
    expect(plan.environment.OPENCLAW_LAUNCHD_LABEL).toBe(
      "ai.openclaw.consumer-lane.telegram-monitor",
    );
    expect(plan.environment.OPENCLAW_SYSTEMD_UNIT).toBe("openclaw-telegram-monitor-consumer-lane");
  });
});
