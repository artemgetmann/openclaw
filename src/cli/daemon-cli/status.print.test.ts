import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "../test-runtime-capture.js";
import type { DaemonStatus } from "./status.gather.js";

const { runtimeLogs, runtimeErrors, defaultRuntime, resetRuntimeCapture } =
  createCliRuntimeCapture();

vi.mock("../../runtime.js", () => ({
  defaultRuntime,
}));

vi.mock("../../terminal/theme.js", () => ({
  colorize: (_rich: boolean, _color: unknown, text: string) => text,
  isRich: () => false,
  theme: {
    accent: "accent",
    error: "error",
    info: "info",
    muted: "muted",
    success: "success",
    warn: "warn",
  },
}));

vi.mock("../../logging.js", () => ({
  getResolvedLoggerSettings: () => ({ file: "/tmp/openclaw.log" }),
}));

vi.mock("../../commands/onboard-helpers.js", () => ({
  resolveControlUiLinks: () => ({ httpUrl: "http://127.0.0.1:18789" }),
}));

const { printDaemonStatus } = await import("./status.print.js");

describe("printDaemonStatus", () => {
  beforeEach(() => {
    resetRuntimeCapture();
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

    expect(runtimeErrors).toHaveLength(0);
    expect(runtimeLogs.join("\n")).toContain(
      "Runtime ID: branch=main worktree=/repo stateDir=/state configPath=/state/openclaw.json serviceLabel=ai.openclaw.gateway",
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

    const parsed = JSON.parse(runtimeLogs.join("\n")) as {
      runtimeFingerprint?: { branch?: string };
    };
    expect(parsed.runtimeFingerprint?.branch).toBe("main");
  });
});
