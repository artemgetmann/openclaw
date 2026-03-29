import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "../test-runtime-capture.js";
import type { DaemonStatus } from "./status.gather.js";

const gatherDaemonStatus = vi.fn(
  async (_opts?: unknown): Promise<DaemonStatus> => ({
    service: {
      label: "LaunchAgent",
      loaded: true,
      loadedText: "loaded",
      notLoadedText: "not loaded",
    },
    rpc: {
      ok: true,
      url: "ws://127.0.0.1:18789",
    },
    extraServices: [],
  }),
);
const printDaemonStatus = vi.fn();

const { runtimeErrors, defaultRuntime, resetRuntimeCapture } = createCliRuntimeCapture();

vi.mock("../../runtime.js", () => ({
  defaultRuntime,
}));

vi.mock("../../terminal/theme.js", () => ({
  colorize: (_rich: boolean, _color: unknown, text: string) => text,
  isRich: () => false,
  theme: { error: "error" },
}));

vi.mock("./status.gather.js", () => ({
  gatherDaemonStatus: (opts: unknown) => gatherDaemonStatus(opts),
}));

vi.mock("./status.print.js", () => ({
  printDaemonStatus: (...args: unknown[]) => printDaemonStatus(...args),
}));

const { runDaemonStatus } = await import("./status.js");

describe("runDaemonStatus", () => {
  beforeEach(() => {
    gatherDaemonStatus.mockClear();
    printDaemonStatus.mockClear();
    resetRuntimeCapture();
  });

  it("exits when require-rpc is set and the probe fails", async () => {
    gatherDaemonStatus.mockResolvedValueOnce({
      service: {
        label: "LaunchAgent",
        loaded: true,
        loadedText: "loaded",
        notLoadedText: "not loaded",
      },
      rpc: {
        ok: false,
        url: "ws://127.0.0.1:18789",
        error: "gateway closed",
      },
      extraServices: [],
    });

    await expect(
      runDaemonStatus({
        rpc: {},
        probe: true,
        requireRpc: true,
        json: false,
      }),
    ).rejects.toThrow("__exit__:1");

    expect(printDaemonStatus).toHaveBeenCalledTimes(1);
  });

  it("rejects require-rpc when probing is disabled", async () => {
    await expect(
      runDaemonStatus({
        rpc: {},
        probe: false,
        requireRpc: true,
        json: false,
      }),
    ).rejects.toThrow("__exit__:1");

    expect(gatherDaemonStatus).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("--require-rpc cannot be used with --no-probe");
  });

  it("exits when status detects a lane-local port mismatch", async () => {
    gatherDaemonStatus.mockResolvedValueOnce({
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
    });

    await expect(
      runDaemonStatus({
        rpc: {},
        probe: true,
        requireRpc: false,
        json: false,
      }),
    ).rejects.toThrow("__exit__:1");

    expect(printDaemonStatus).toHaveBeenCalledTimes(1);
  });
});
