import { describe, expect, it, vi } from "vitest";
import type { ProgressReporter } from "../../cli/progress.js";
import { appendStatusAllDiagnosis } from "./diagnosis.js";

vi.mock("../../daemon/launchd.js", () => ({
  resolveGatewayLogPaths: () => null,
}));

describe("appendStatusAllDiagnosis", () => {
  it("warns when launchagent writes are disabled", async () => {
    const lines: string[] = [];
    const progress: ProgressReporter = {
      setLabel: () => {},
      setPercent: () => {},
      tick: () => {},
      done: () => {},
    };

    await appendStatusAllDiagnosis({
      lines,
      progress,
      muted: (text: string) => text,
      ok: (text: string) => text,
      warn: (text: string) => text,
      fail: (text: string) => text,
      connectionDetailsForReport: "gateway target: ws://127.0.0.1:18789",
      snap: null,
      remoteUrlMissing: false,
      macLaunchAgentDisableMarkerPath: "/Users/user/.openclaw/disable-launchagent",
      sentinel: null,
      lastErr: null,
      port: 18789,
      portUsage: null,
      tailscaleMode: "off",
      tailscale: {
        backendState: null,
        dnsName: null,
        ips: [],
        error: null,
      },
      tailscaleHttpsUrl: null,
      skillStatus: null,
      channelsStatus: null,
      channelIssues: [],
      gatewayReachable: true,
      health: null,
    });

    const output = lines.join("\n");
    expect(output).toContain("LaunchAgent writes disabled");
    expect(output).toContain("disable-launchagent");
  });
});
