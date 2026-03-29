import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  formatMacLaunchAgentDisableMarkerNote,
  noteMacLaunchAgentOverrides,
  noteMacLaunchctlGatewayEnvOverrides,
  readMacLaunchAgentDisableMarker,
} from "./doctor-platform-notes.js";

describe("noteMacLaunchctlGatewayEnvOverrides", () => {
  it("prints clear unsetenv instructions for token override", async () => {
    const noteFn = vi.fn();
    const getenv = vi.fn(async (name: string) =>
      name === "OPENCLAW_GATEWAY_TOKEN" ? "launchctl-token" : undefined,
    );
    const cfg = {
      gateway: {
        auth: {
          token: "config-token",
        },
      },
    } as OpenClawConfig;

    await noteMacLaunchctlGatewayEnvOverrides(cfg, { platform: "darwin", getenv, noteFn });

    expect(noteFn).toHaveBeenCalledTimes(1);
    expect(getenv).toHaveBeenCalledTimes(4);

    const [message, title] = noteFn.mock.calls[0] ?? [];
    expect(title).toBe("Gateway (macOS)");
    expect(message).toContain("launchctl environment overrides detected");
    expect(message).toContain("OPENCLAW_GATEWAY_TOKEN");
    expect(message).toContain("launchctl unsetenv OPENCLAW_GATEWAY_TOKEN");
    expect(message).not.toContain("OPENCLAW_GATEWAY_PASSWORD");
  });

  it("does nothing when config has no gateway credentials", async () => {
    const noteFn = vi.fn();
    const getenv = vi.fn(async () => "launchctl-token");
    const cfg = {} as OpenClawConfig;

    await noteMacLaunchctlGatewayEnvOverrides(cfg, { platform: "darwin", getenv, noteFn });

    expect(getenv).not.toHaveBeenCalled();
    expect(noteFn).not.toHaveBeenCalled();
  });

  it("treats SecretRef-backed credentials as configured", async () => {
    const noteFn = vi.fn();
    const getenv = vi.fn(async (name: string) =>
      name === "OPENCLAW_GATEWAY_PASSWORD" ? "launchctl-password" : undefined,
    );
    const cfg = {
      gateway: {
        auth: {
          password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as OpenClawConfig;

    await noteMacLaunchctlGatewayEnvOverrides(cfg, { platform: "darwin", getenv, noteFn });

    expect(noteFn).toHaveBeenCalledTimes(1);
    const [message] = noteFn.mock.calls[0] ?? [];
    expect(message).toContain("OPENCLAW_GATEWAY_PASSWORD");
  });

  it("does nothing on non-darwin platforms", async () => {
    const noteFn = vi.fn();
    const getenv = vi.fn(async () => "launchctl-token");
    const cfg = {
      gateway: {
        auth: {
          token: "config-token",
        },
      },
    } as OpenClawConfig;

    await noteMacLaunchctlGatewayEnvOverrides(cfg, { platform: "linux", getenv, noteFn });

    expect(getenv).not.toHaveBeenCalled();
    expect(noteFn).not.toHaveBeenCalled();
  });

  it("warns when launchagent writes are disabled", async () => {
    const noteFn = vi.fn();
    const markerPath = "/tmp/openclaw-instance/.openclaw/disable-launchagent";
    const existsSync = vi.fn((candidate: string) => candidate === markerPath);
    const readFileSync = vi.fn(() =>
      JSON.stringify({
        source: "scripts/restart-mac.sh",
        reason: "unsigned-restart",
        disabledAt: "2026-03-29T10:18:00Z",
        stateDir: "/tmp/openclaw-instance/.openclaw",
        worktree: "/repo/.worktrees/restart-mac-isolation",
      }),
    );

    await noteMacLaunchAgentOverrides({
      platform: "darwin",
      env: { OPENCLAW_STATE_DIR: "/tmp/openclaw-instance/.openclaw" } as NodeJS.ProcessEnv,
      homeDir: "/Users/user",
      existsSync,
      readFileSync,
      noteFn,
    });

    expect(noteFn).toHaveBeenCalledTimes(1);
    const [message, title] = noteFn.mock.calls[0] ?? [];
    expect(title).toBe("Gateway (macOS)");
    expect(message).toContain("LaunchAgent writes are disabled");
    expect(message).toContain("scripts/restart-mac.sh");
    expect(message).toContain("unsigned-restart");
    expect(message).toContain("rm /tmp/openclaw-instance/.openclaw/disable-launchagent");
  });

  it("reads the disable marker from the active state dir", () => {
    const marker = readMacLaunchAgentDisableMarker({
      platform: "darwin",
      env: { OPENCLAW_STATE_DIR: "/tmp/lane/.openclaw" } as NodeJS.ProcessEnv,
      existsSync: (candidate) => candidate === "/tmp/lane/.openclaw/disable-launchagent",
      readFileSync: () => "",
    });

    expect(marker?.path).toBe("/tmp/lane/.openclaw/disable-launchagent");
  });

  it("formats marker provenance when metadata exists", () => {
    const message = formatMacLaunchAgentDisableMarkerNote({
      path: "/tmp/lane/.openclaw/disable-launchagent",
      metadata: {
        source: "apps/macos/MenuBar.swift",
        reason: "attach-only",
        disabledAt: "2026-03-29T10:18:00Z",
        stateDir: "/tmp/lane/.openclaw",
      },
    });

    expect(message).toContain("apps/macos/MenuBar.swift");
    expect(message).toContain("attach-only");
    expect(message).toContain("Scope: /tmp/lane/.openclaw.");
  });
});
