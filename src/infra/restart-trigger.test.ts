import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConsumerRuntimeIdentity } from "../consumer/runtime-identity.js";
import { captureFullEnv } from "../test-utils/env.js";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const cleanStaleGatewayProcessesSyncMock = vi.hoisted(() => vi.fn());
const relaunchGatewayScheduledTaskMock = vi.hoisted(() => vi.fn());
const isCurrentProcessLaunchdServiceLabelMock = vi.hoisted(() => vi.fn());
const scheduleDetachedLaunchdRestartHandoffMock = vi.hoisted(() => vi.fn());
const ensureGatewayLifecycleLeaseForRestartMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
  };
});

vi.mock("./restart-stale-pids.js", () => ({
  cleanStaleGatewayProcessesSync: (...args: unknown[]) =>
    cleanStaleGatewayProcessesSyncMock(...args),
  findGatewayPidsOnPortSync: vi.fn(() => []),
}));

vi.mock("./windows-task-restart.js", () => ({
  relaunchGatewayScheduledTask: (...args: unknown[]) => relaunchGatewayScheduledTaskMock(...args),
}));

vi.mock("./gateway-lifecycle-lease.js", () => ({
  GATEWAY_LIFECYCLE_TEMPORARY_UNAVAILABLE_EXIT_CODE: 75,
  ensureGatewayLifecycleLeaseForRestart: (...args: unknown[]) =>
    ensureGatewayLifecycleLeaseForRestartMock(...args),
}));

vi.mock("../daemon/launchd-restart-handoff.js", () => ({
  isCurrentProcessLaunchdServiceLabel: (...args: unknown[]) =>
    isCurrentProcessLaunchdServiceLabelMock(...args),
  scheduleDetachedLaunchdRestartHandoff: (...args: unknown[]) =>
    scheduleDetachedLaunchdRestartHandoffMock(...args),
}));

import {
  __testing,
  isCanonicalSharedMainLaunchdRuntime,
  requestGatewayToolRestart,
  triggerOpenClawRestart,
} from "./restart.js";

const envSnapshot = captureFullEnv();
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: string) {
  if (!originalPlatformDescriptor) {
    return;
  }
  Object.defineProperty(process, "platform", {
    ...originalPlatformDescriptor,
    value: platform,
  });
}

beforeEach(() => {
  isCurrentProcessLaunchdServiceLabelMock.mockReset();
  isCurrentProcessLaunchdServiceLabelMock.mockReturnValue(false);
  scheduleDetachedLaunchdRestartHandoffMock.mockReset();
  scheduleDetachedLaunchdRestartHandoffMock.mockResolvedValue({ ok: true, pid: 31337 });
  ensureGatewayLifecycleLeaseForRestartMock.mockReset();
  ensureGatewayLifecycleLeaseForRestartMock.mockResolvedValue({ outcome: "held" });
});

afterEach(() => {
  envSnapshot.restore();
  spawnSyncMock.mockReset();
  cleanStaleGatewayProcessesSyncMock.mockReset();
  relaunchGatewayScheduledTaskMock.mockReset();
  __testing.resetSigusr1State();
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
  vi.restoreAllMocks();
});

describe("triggerOpenClawRestart lifecycle admission", () => {
  it.each(["ai.openclaw.gateway", "ai.jarvis.gateway"])(
    "uses the detached guarded handoff for current managed service %s",
    async (expectedLabel) => {
      setPlatform("darwin");
      delete process.env.VITEST;
      delete process.env.NODE_ENV;
      process.env.OPENCLAW_LAUNCHD_LABEL = expectedLabel;
      isCurrentProcessLaunchdServiceLabelMock.mockReturnValue(true);

      const result = await triggerOpenClawRestart();

      expect(result).toMatchObject({ ok: true, method: "launchctl" });
      expect(result.detail).toContain(
        `scheduled detached launchd restart handoff for ${expectedLabel}`,
      );
      expect(scheduleDetachedLaunchdRestartHandoffMock).toHaveBeenCalledWith({
        env: process.env,
        delayMs: 2000,
        mode: "kickstart",
      });
      expect(ensureGatewayLifecycleLeaseForRestartMock).not.toHaveBeenCalled();
      expect(cleanStaleGatewayProcessesSyncMock).not.toHaveBeenCalled();
      expect(spawnSyncMock).not.toHaveBeenCalled();
    },
  );

  it.each(["ai.openclaw.gateway", "ai.jarvis.gateway"])(
    "uses the detached guarded handoff for shared label %s without process markers",
    async (launchdLabel) => {
      setPlatform("darwin");
      delete process.env.VITEST;
      delete process.env.NODE_ENV;
      process.env.OPENCLAW_LAUNCHD_LABEL = launchdLabel;

      expect(isCanonicalSharedMainLaunchdRuntime()).toBe(true);
      const result = await triggerOpenClawRestart();

      expect(result).toMatchObject({ ok: true, method: "launchctl" });
      expect(result.tried).toContain(`launchd-handoff kickstart ${launchdLabel}`);
      expect(ensureGatewayLifecycleLeaseForRestartMock).not.toHaveBeenCalled();
      expect(cleanStaleGatewayProcessesSyncMock).not.toHaveBeenCalled();
      expect(spawnSyncMock).not.toHaveBeenCalled();
    },
  );

  it("mutates a consumer lane only after inherited lifecycle admission", async () => {
    setPlatform("darwin");
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    process.env.OPENCLAW_PROFILE = "consumer-main-durable-lane";
    const identity = resolveConsumerRuntimeIdentity({ instanceId: "main-durable-lane" });
    spawnSyncMock.mockReturnValue({ error: undefined, status: 0, stdout: "", stderr: "" });

    const result = await triggerOpenClawRestart();

    expect(result).toMatchObject({ ok: true, method: "launchctl" });
    expect(ensureGatewayLifecycleLeaseForRestartMock).toHaveBeenCalledOnce();
    expect(cleanStaleGatewayProcessesSyncMock).toHaveBeenCalledOnce();
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "launchctl",
      expect.arrayContaining([
        "kickstart",
        "-k",
        expect.stringMatching(
          new RegExp(
            `^gui/\\d+/${identity.gatewayLaunchdLabel.replace(/[.*+?^${}()|[\]\\\\]/g, "\\$&")}$`,
          ),
        ),
      ]),
      expect.objectContaining({ encoding: "utf8", timeout: 2000 }),
    );
  });

  it.each([75, 1])(
    "returns a failed guarded result before lane signals or launchctl on child exit %s",
    async (exitCode) => {
      setPlatform("darwin");
      delete process.env.VITEST;
      delete process.env.NODE_ENV;
      process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.consumer.test.gateway";
      ensureGatewayLifecycleLeaseForRestartMock.mockResolvedValue({
        outcome: "reexecuted",
        exitCode,
      });

      const result = await triggerOpenClawRestart();

      expect(result).toMatchObject({
        ok: false,
        method: "launchctl",
        detail: `gateway restart temporarily unavailable (exit ${exitCode})`,
      });
      expect(cleanStaleGatewayProcessesSyncMock).not.toHaveBeenCalled();
      expect(spawnSyncMock).not.toHaveBeenCalled();
    },
  );

  it("returns success without a second mutation when the guarded child completes", async () => {
    setPlatform("darwin");
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.consumer.test.gateway";
    ensureGatewayLifecycleLeaseForRestartMock.mockResolvedValue({
      outcome: "reexecuted",
      exitCode: 0,
    });

    const result = await triggerOpenClawRestart();

    expect(result).toMatchObject({
      ok: true,
      method: "launchctl",
      detail: "completed guarded gateway restart",
    });
    expect(cleanStaleGatewayProcessesSyncMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it.each(["ai.openclaw.gateway", "ai.jarvis.gateway"])(
    "does not downgrade shared managed label %s when detached handoff fails",
    async (launchdLabel) => {
      setPlatform("darwin");
      delete process.env.VITEST;
      delete process.env.NODE_ENV;
      process.env.OPENCLAW_LAUNCHD_LABEL = launchdLabel;
      scheduleDetachedLaunchdRestartHandoffMock.mockResolvedValue({
        ok: false,
        detail: "handoff unavailable",
      });

      const result = await triggerOpenClawRestart();

      expect(result).toEqual({
        ok: false,
        method: "launchctl",
        detail: "handoff unavailable",
        tried: [`launchd-handoff kickstart ${launchdLabel}`],
      });
      expect(ensureGatewayLifecycleLeaseForRestartMock).not.toHaveBeenCalled();
      expect(cleanStaleGatewayProcessesSyncMock).not.toHaveBeenCalled();
      expect(spawnSyncMock).not.toHaveBeenCalled();
    },
  );

  it.each(["ai.openclaw.gateway", "ai.jarvis.gateway"])(
    "routes live-tool shared managed restart for %s through external launchd handoff",
    async (launchdLabel) => {
      setPlatform("darwin");
      delete process.env.VITEST;
      delete process.env.NODE_ENV;
      process.env.OPENCLAW_LAUNCHD_LABEL = launchdLabel;

      const result = await requestGatewayToolRestart({
        delayMs: 25,
        reason: "live chat restart",
      });

      expect(result).toMatchObject({
        ok: true,
        method: "launchd-handoff",
        restartMode: "external-supervised",
        delayMs: 25,
        reason: "live chat restart",
        verified: false,
      });
      expect(scheduleDetachedLaunchdRestartHandoffMock).toHaveBeenCalledWith({
        env: process.env,
        mode: "kickstart",
        delayMs: 25,
      });
      expect(spawnSyncMock).not.toHaveBeenCalled();
    },
  );
});
