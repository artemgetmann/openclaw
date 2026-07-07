import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConsumerRuntimeIdentity } from "../consumer/runtime-identity.js";

const programArgsMock = vi.hoisted(() => vi.fn());
const runtimeInputsMock = vi.hoisted(() => vi.fn());
const runtimeWarningMock = vi.hoisted(() => vi.fn());
const readConfigMock = vi.hoisted(() => vi.fn());
const resolveGatewayPortMock = vi.hoisted(() => vi.fn());

vi.mock("../daemon/program-args.js", () => ({
  resolveWhatsAppMonitorProgramArguments: programArgsMock,
}));

vi.mock("./daemon-install-plan.shared.js", () => ({
  emitDaemonInstallRuntimeWarning: runtimeWarningMock,
  resolveDaemonInstallRuntimeInputs: runtimeInputsMock,
}));

vi.mock("../config/config.js", () => ({
  readBestEffortConfig: readConfigMock,
  resolveGatewayPort: resolveGatewayPortMock,
}));

const { buildWhatsAppMonitorServiceInstallPlan, resolveDefaultWhatsAppMonitorHookUrl } =
  await import("./whatsapp-monitor-service-install-helpers.js");

describe("whatsapp monitor service install helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeInputsMock.mockResolvedValue({ devMode: false, nodePath: "/usr/local/bin/node" });
    readConfigMock.mockResolvedValue({});
    resolveGatewayPortMock.mockImplementation(
      (_cfg: unknown, env: Record<string, string | undefined>) =>
        Number(env.OPENCLAW_GATEWAY_PORT?.trim()) || 18789,
    );
    programArgsMock.mockResolvedValue({
      programArguments: ["/usr/local/bin/node", "/repo/dist/index.js", "whatsapp-monitor", "poll"],
      workingDirectory: "/repo",
    });
  });

  it("defaults the local generic monitor hook URL from the gateway port", () => {
    expect(resolveDefaultWhatsAppMonitorHookUrl({ env: { OPENCLAW_GATEWAY_PORT: "18888" } })).toBe(
      "http://127.0.0.1:18888/hooks/monitor-event",
    );
  });

  it("uses the resolved gateway config port for the default hook URL", async () => {
    readConfigMock.mockResolvedValueOnce({ gateway: { port: 19999 } });
    resolveGatewayPortMock.mockReturnValueOnce(19999);

    await buildWhatsAppMonitorServiceInstallPlan({
      dbPath: "/tmp/wacli.db",
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
        hookUrl: "http://127.0.0.1:19999/hooks/monitor-event",
      }),
    );
  });

  it("rejects invalid hook URLs before building service arguments", async () => {
    await expect(
      buildWhatsAppMonitorServiceInstallPlan({
        dbPath: "/tmp/wacli.db",
        env: { HOME: "/Users/test" },
        hookUrl: "https://example.com/hooks/monitor-event",
        intervalMs: 2500,
        runtime: "node",
      }),
    ).rejects.toThrow("--hook-url must point to the local gateway");
    expect(programArgsMock).not.toHaveBeenCalled();
  });

  it("builds a service plan without putting the hook token in process arguments", async () => {
    const plan = await buildWhatsAppMonitorServiceInstallPlan({
      cronStore: "/tmp/cron.json",
      cursorStore: "/tmp/cursors.json",
      dbPath: "/tmp/wacli.db",
      env: {
        HOME: "/Users/test",
        OPENCLAW_GATEWAY_PORT: "18888",
        OPENCLAW_GATEWAY_TOKEN: " secret-token ",
      },
      intervalMs: 2500,
      maxRuns: 3,
      monitorStore: "/tmp/monitors.json",
      runtime: "node",
    });

    expect(programArgsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cronStore: "/tmp/cron.json",
        cursorStore: "/tmp/cursors.json",
        dbPath: "/tmp/wacli.db",
        hookUrl: "http://127.0.0.1:18888/hooks/monitor-event",
        intervalMs: 2500,
        maxRuns: 3,
        monitorStore: "/tmp/monitors.json",
        nodePath: "/usr/local/bin/node",
        runtime: "node",
      }),
    );
    expect(plan.programArguments.join(" ")).not.toContain("secret-token");
    expect(plan.environment.OPENCLAW_GATEWAY_TOKEN).toBe("secret-token");
    expect(plan.environment.OPENCLAW_LAUNCHD_LABEL).toBe("ai.openclaw.whatsapp-monitor");
    expect(plan.environment.OPENCLAW_SYSTEMD_UNIT).toBe("openclaw-whatsapp-monitor");
    expect(plan.environment.OPENCLAW_SERVICE_KIND).toBe("whatsapp-monitor");
  });

  it("defaults the hook URL after resolving consumer runtime identity", async () => {
    const identity = resolveConsumerRuntimeIdentity({
      homeDir: "/Users/test",
      instanceId: "lane",
    });

    const plan = await buildWhatsAppMonitorServiceInstallPlan({
      dbPath: "/tmp/wacli.db",
      env: {
        HOME: "/Users/test",
        OPENCLAW_PROFILE: "consumer-lane",
      },
      intervalMs: 2500,
      runtime: "node",
    });

    expect(programArgsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hookUrl: `http://127.0.0.1:${identity.gatewayPort}/hooks/monitor-event`,
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
      "ai.openclaw.consumer-lane.whatsapp-monitor",
    );
    expect(plan.environment.OPENCLAW_SYSTEMD_UNIT).toBe("openclaw-whatsapp-monitor-consumer-lane");
  });
});
