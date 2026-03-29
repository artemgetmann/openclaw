import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonStatus } from "./status.gather.js";

const runtime = vi.hoisted(() => ({
  log: vi.fn<(line: string) => void>(),
  error: vi.fn<(line: string) => void>(),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: runtime,
}));

vi.mock("../../terminal/theme.js", () => ({
  colorize: (_rich: boolean, _theme: unknown, text: string) => text,
}));

vi.mock("../../commands/onboard-helpers.js", () => ({
  resolveControlUiLinks: () => ({ httpUrl: "http://127.0.0.1:18789" }),
}));

const readMacLaunchAgentDisableMarker = vi.hoisted(() =>
  vi.fn<
    () => {
      path: string;
      metadata?: {
        source?: string;
        reason?: string;
      };
    } | null
  >(() => null),
);
const formatMacLaunchAgentDisableMarkerNote = vi.hoisted(() => vi.fn(() => ""));

vi.mock("../../commands/doctor-platform-notes.js", () => ({
  readMacLaunchAgentDisableMarker,
  formatMacLaunchAgentDisableMarkerNote,
}));

vi.mock("../../daemon/inspect.js", () => ({
  renderGatewayServiceCleanupHints: () => [],
}));

vi.mock("../../daemon/launchd.js", () => ({
  resolveGatewayLogPaths: () => ({
    stdoutPath: "/tmp/gateway.out.log",
    stderrPath: "/tmp/gateway.err.log",
  }),
}));

vi.mock("../../daemon/systemd-hints.js", () => ({
  isSystemdUnavailableDetail: () => false,
  renderSystemdUnavailableHints: () => [],
}));

vi.mock("../../infra/wsl.js", () => ({
  isWSLEnv: () => false,
}));

vi.mock("../../logging.js", () => ({
  getResolvedLoggerSettings: () => ({ file: "/tmp/openclaw.log" }),
}));

vi.mock("./shared.js", () => ({
  createCliStatusTextStyles: () => ({
    rich: false,
    label: (text: string) => text,
    accent: (text: string) => text,
    infoText: (text: string) => text,
    okText: (text: string) => text,
    warnText: (text: string) => text,
    errorText: (text: string) => text,
  }),
  filterDaemonEnv: () => ({}),
  formatRuntimeStatus: () => "running (pid 8000)",
  resolveRuntimeStatusColor: () => "",
  renderRuntimeHints: () => [],
  safeDaemonEnv: () => [],
}));

vi.mock("./status.gather.js", () => ({
  renderPortDiagnosticsForCli: () => [],
  resolvePortListeningAddresses: () => ["127.0.0.1:18789"],
}));

const { printDaemonStatus } = await import("./status.print.js");

describe("printDaemonStatus", () => {
  beforeEach(() => {
    runtime.log.mockReset();
    runtime.error.mockReset();
    readMacLaunchAgentDisableMarker.mockReset();
    readMacLaunchAgentDisableMarker.mockReturnValue(null);
    formatMacLaunchAgentDisableMarkerNote.mockReset();
    formatMacLaunchAgentDisableMarkerNote.mockReturnValue("");
  });

  it("prints stale gateway pid guidance when runtime does not own the listener", () => {
    printDaemonStatus(
      {
        service: {
          label: "LaunchAgent",
          loaded: true,
          loadedText: "loaded",
          notLoadedText: "not loaded",
          runtime: { status: "running", pid: 8000 },
        },
        gateway: {
          bindMode: "loopback",
          bindHost: "127.0.0.1",
          port: 18789,
          portSource: "env/config",
          probeUrl: "ws://127.0.0.1:18789",
        },
        port: {
          port: 18789,
          status: "busy",
          listeners: [{ pid: 9000, ppid: 8999, address: "127.0.0.1:18789" }],
          hints: [],
        },
        rpc: {
          ok: false,
          error: "gateway closed (1006 abnormal closure (no close frame))",
          url: "ws://127.0.0.1:18789",
        },
        health: {
          healthy: false,
          staleGatewayPids: [9000],
        },
        extraServices: [],
      },
      { json: false },
    );

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Gateway runtime PID does not own the listening port"),
    );
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("openclaw gateway restart"));
  });

  it("prints a loud lane-local port mismatch diagnosis", () => {
    printDaemonStatus(
      {
        service: {
          label: "LaunchAgent",
          loaded: true,
          loadedText: "loaded",
          notLoadedText: "not loaded",
        },
        gateway: {
          bindMode: "loopback",
          bindHost: "127.0.0.1",
          port: 35324,
          portSource: "service args",
          probeUrl: "ws://127.0.0.1:35324",
        },
        port: {
          port: 35324,
          status: "busy",
          listeners: [],
          hints: [],
        },
        portCli: {
          port: 35624,
          status: "free",
          listeners: [],
          hints: [],
        },
        portMismatch: {
          servicePort: 35324,
          servicePortSource: "service args",
          expectedPort: 35624,
          expectedPortStatus: "free",
          serviceStateDir: "/tmp/service-state",
          expectedStateDir: "/tmp/cli-state",
          serviceConfigPath: "/tmp/service-state/openclaw.json",
          expectedConfigPath: "/tmp/cli-state/openclaw.json",
          issues: ["service port=35324, cli port=35624"],
        },
        extraServices: [],
      },
      { json: false },
    );

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("does not match this lane's expected runtime ownership"),
    );
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("restart the gateway from this same lane"),
    );
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("openclaw gateway restart"));
  });

  it("prints the runtime fingerprint in text mode", () => {
    const status: DaemonStatus = {
      runtimeFingerprint: {
        branch: "main",
        worktree: "/repo",
        stateDir: "/state",
        configPath: "/state/openclaw.json",
        serviceLabel: "ai.openclaw.gateway",
      },
      service: {
        label: "LaunchAgent",
        loaded: true,
        loadedText: "loaded",
        notLoadedText: "not loaded",
      },
      extraServices: [],
    };

    printDaemonStatus(status, { json: false });

    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("Runtime ID:"));
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("branch=main"));
  });

  it("warns when launchagent writes are disabled on local macOS runtime", () => {
    readMacLaunchAgentDisableMarker.mockReturnValue({
      path: "/tmp/lane/.openclaw/disable-launchagent",
      metadata: { source: "scripts/restart-mac.sh", reason: "unsigned-restart" },
    });
    formatMacLaunchAgentDisableMarkerNote.mockReturnValue(
      [
        "- LaunchAgent writes are disabled via /tmp/lane/.openclaw/disable-launchagent.",
        "- Provenance: scripts/restart-mac.sh · unsigned-restart.",
        "  rm /tmp/lane/.openclaw/disable-launchagent",
      ].join("\n"),
    );

    printDaemonStatus(
      {
        service: {
          label: "LaunchAgent",
          loaded: true,
          loadedText: "loaded",
          notLoadedText: "not loaded",
        },
        config: {
          cli: {
            path: "/Users/user/.openclaw/openclaw.json",
            exists: true,
            valid: true,
          },
        },
        extraServices: [],
      },
      { json: false },
    );

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("LaunchAgent writes are disabled"),
    );
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("scripts/restart-mac.sh"));
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("rm /tmp/lane/.openclaw/disable-launchagent"),
    );
  });

  it("keeps the runtime fingerprint in json mode", () => {
    const status: DaemonStatus = {
      runtimeFingerprint: {
        branch: "main",
        worktree: "/repo",
        stateDir: "/state",
        configPath: "/state/openclaw.json",
        serviceLabel: "ai.openclaw.gateway",
      },
      service: {
        label: "LaunchAgent",
        loaded: true,
        loadedText: "loaded",
        notLoadedText: "not loaded",
      },
      extraServices: [],
    };

    printDaemonStatus(status, { json: true });

    const payload = runtime.log.mock.calls[0]?.[0] ?? "{}";
    const parsed = JSON.parse(payload) as { runtimeFingerprint?: { branch?: string } };
    expect(parsed.runtimeFingerprint?.branch).toBe("main");
  });
});
