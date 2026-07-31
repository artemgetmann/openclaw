import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConsumerRuntimeIdentity } from "../consumer/runtime-identity.js";
import { captureFullEnv } from "../test-utils/env.js";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());
const cleanStaleGatewayProcessesSyncMock = vi.hoisted(() => vi.fn());
const relaunchGatewayScheduledTaskMock = vi.hoisted(() => vi.fn());
const resolveOpenClawPackageRootSyncMock = vi.hoisted(() => vi.fn());
const isCurrentProcessLaunchdServiceLabelMock = vi.hoisted(() => vi.fn());
const scheduleDetachedLaunchdRestartHandoffMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
    spawn: (...args: unknown[]) => spawnMock(...args),
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

vi.mock("./openclaw-root.js", () => ({
  resolveOpenClawPackageRootSync: (...args: unknown[]) =>
    resolveOpenClawPackageRootSyncMock(...args),
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
  isSafeLocalRestartScriptAvailable,
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
  scheduleDetachedLaunchdRestartHandoffMock.mockReturnValue({ ok: true, pid: 31337 });
});

afterEach(() => {
  envSnapshot.restore();
  spawnSyncMock.mockReset();
  spawnMock.mockReset();
  cleanStaleGatewayProcessesSyncMock.mockReset();
  relaunchGatewayScheduledTaskMock.mockReset();
  resolveOpenClawPackageRootSyncMock.mockReset();
  resolveOpenClawPackageRootSyncMock.mockReturnValue(null);
  __testing.resetSigusr1State();
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
  vi.restoreAllMocks();
});

describe("triggerOpenClawRestart local script mode", () => {
  it.each(["ai.openclaw.gateway", "ai.jarvis.gateway"])(
    "prefers detached launchd handoff over the local script for managed service %s",
    async (expectedLabel) => {
      setPlatform("darwin");
      delete process.env.VITEST;
      delete process.env.NODE_ENV;
      process.env.OPENCLAW_LAUNCHD_LABEL = expectedLabel;

      const scriptDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restart-script-"));
      const scriptPath = path.join(scriptDir, "restart-local-gateway.sh");
      await fs.writeFile(scriptPath, "#!/usr/bin/env bash\nexit 0\n", "utf8");
      process.env.OPENCLAW_LOCAL_RESTART_SCRIPT = scriptPath;
      isCurrentProcessLaunchdServiceLabelMock.mockReturnValue(true);

      try {
        const result = triggerOpenClawRestart({ preferLocalScript: true });
        expect(result).toMatchObject({
          ok: true,
          method: "launchctl",
        });
        expect(result.detail).toContain(
          `scheduled detached launchd restart handoff for ${expectedLabel}`,
        );
        expect(result.tried).toContain(`launchd-handoff kickstart ${expectedLabel}`);
        expect(scheduleDetachedLaunchdRestartHandoffMock).toHaveBeenCalledWith({
          env: process.env,
          delayMs: 2000,
          mode: "kickstart",
        });
        expect(spawnMock).not.toHaveBeenCalled();
        expect(spawnSyncMock).not.toHaveBeenCalled();
      } finally {
        await fs.rm(scriptDir, { recursive: true, force: true });
      }
    },
  );

  it("prefers detached local restart script on macOS when requested", async () => {
    setPlatform("darwin");
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.consumer.test.gateway";

    const scriptDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restart-script-"));
    const scriptPath = path.join(scriptDir, "restart-local-gateway.sh");
    await fs.writeFile(scriptPath, "#!/usr/bin/env bash\nexit 0\n", "utf8");
    process.env.OPENCLAW_LOCAL_RESTART_SCRIPT = scriptPath;

    const unrefMock = vi.fn();
    spawnMock.mockReturnValue({ pid: 4242, unref: unrefMock });

    try {
      const result = triggerOpenClawRestart({ preferLocalScript: true });
      expect(result).toMatchObject({
        ok: true,
        method: "launchctl",
      });
      expect(result.detail).toContain("scheduled local restart script");
      expect(result.tried).toContain(
        `local-restart-script OPENCLAW_RESTART_DETACHED=1 /bin/bash ${scriptPath}`,
      );
      expect(cleanStaleGatewayProcessesSyncMock).toHaveBeenCalledOnce();
      expect(spawnMock).toHaveBeenCalledWith(
        "/bin/bash",
        [scriptPath],
        expect.objectContaining({
          detached: true,
          stdio: "ignore",
          env: expect.objectContaining({
            OPENCLAW_RESTART_DETACHED: "1",
          }),
        }),
      );
      expect(unrefMock).toHaveBeenCalledOnce();
      expect(spawnSyncMock).not.toHaveBeenCalled();
    } finally {
      await fs.rm(scriptDir, { recursive: true, force: true });
    }
  });

  it("falls back to launchctl when local script path is missing", () => {
    setPlatform("darwin");
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.consumer.test.gateway";
    process.env.OPENCLAW_LOCAL_RESTART_SCRIPT = "/tmp/definitely-missing-openclaw-restart.sh";

    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stdout: "",
      stderr: "",
    });

    const result = triggerOpenClawRestart({ preferLocalScript: true });
    expect(result).toMatchObject({
      ok: true,
      method: "launchctl",
    });
    expect(cleanStaleGatewayProcessesSyncMock).toHaveBeenCalledOnce();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "launchctl",
      expect.arrayContaining([
        "kickstart",
        "-k",
        expect.stringMatching(/^gui\/\d+\/ai\.openclaw\.consumer\.test\.gateway$/),
      ]),
      expect.objectContaining({
        encoding: "utf8",
        timeout: 2000,
      }),
    );
  });

  it("auto-detects the local restart script from the OpenClaw package root", async () => {
    setPlatform("darwin");
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    delete process.env.OPENCLAW_LOCAL_RESTART_SCRIPT;
    process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.consumer.test.gateway";

    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-root-"));
    const scriptDir = path.join(rootDir, "scripts");
    const scriptPath = path.join(scriptDir, "restart-local-gateway.sh");
    await fs.mkdir(scriptDir, { recursive: true });
    await fs.writeFile(scriptPath, "#!/usr/bin/env bash\nexit 0\n", "utf8");
    resolveOpenClawPackageRootSyncMock.mockReturnValue(rootDir);

    const unrefMock = vi.fn();
    spawnMock.mockReturnValue({ pid: 4243, unref: unrefMock });

    try {
      const result = triggerOpenClawRestart({ preferLocalScript: true });
      expect(result).toMatchObject({
        ok: true,
        method: "launchctl",
      });
      expect(result.detail).toContain("scheduled local restart script");
      expect(result.tried).toContain(
        `local-restart-script OPENCLAW_RESTART_DETACHED=1 /bin/bash ${scriptPath}`,
      );
      expect(spawnMock).toHaveBeenCalledWith(
        "/bin/bash",
        [scriptPath],
        expect.objectContaining({
          detached: true,
          stdio: "ignore",
        }),
      );
      expect(unrefMock).toHaveBeenCalledOnce();
      expect(spawnSyncMock).not.toHaveBeenCalled();
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("treats consumer lane profiles as safe lane-local launchd runtimes", async () => {
    setPlatform("darwin");
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    process.env.OPENCLAW_PROFILE = "consumer-main-durable-lane";

    const scriptDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restart-script-"));
    const scriptPath = path.join(scriptDir, "restart-local-gateway.sh");
    const identity = resolveConsumerRuntimeIdentity({
      instanceId: "main-durable-lane",
    });
    await fs.writeFile(scriptPath, "#!/usr/bin/env bash\nexit 0\n", "utf8");
    process.env.OPENCLAW_LOCAL_RESTART_SCRIPT = scriptPath;

    try {
      expect(isCanonicalSharedMainLaunchdRuntime()).toBe(false);
      expect(isSafeLocalRestartScriptAvailable()).toBe(true);

      spawnSyncMock.mockReturnValue({
        error: undefined,
        status: 0,
        stdout: "",
        stderr: "",
      });

      const result = triggerOpenClawRestart({ preferLocalScript: false });
      expect(result).toMatchObject({
        ok: true,
        method: "launchctl",
      });
      expect(spawnSyncMock).toHaveBeenCalledWith(
        "launchctl",
        expect.arrayContaining([
          "kickstart",
          "-k",
          expect.stringMatching(
            new RegExp(
              `^gui/\\d+/${identity.gatewayLaunchdLabel.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}$`,
            ),
          ),
        ]),
        expect.objectContaining({
          encoding: "utf8",
          timeout: 2000,
        }),
      );
    } finally {
      await fs.rm(scriptDir, { recursive: true, force: true });
    }
  });

  it.each(["ai.openclaw.gateway", "ai.jarvis.gateway"])(
    "treats shared managed launchd label %s as unsafe for the local restart helper",
    async (launchdLabel) => {
      setPlatform("darwin");
      delete process.env.VITEST;
      delete process.env.NODE_ENV;
      process.env.OPENCLAW_LAUNCHD_LABEL = launchdLabel;

      const scriptDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restart-script-"));
      const scriptPath = path.join(scriptDir, "restart-local-gateway.sh");
      await fs.writeFile(scriptPath, "#!/usr/bin/env bash\nexit 0\n", "utf8");
      process.env.OPENCLAW_LOCAL_RESTART_SCRIPT = scriptPath;

      try {
        expect(isCanonicalSharedMainLaunchdRuntime()).toBe(true);
        expect(isSafeLocalRestartScriptAvailable()).toBe(false);
      } finally {
        await fs.rm(scriptDir, { recursive: true, force: true });
      }
    },
  );

  it.each(["ai.openclaw.gateway", "ai.jarvis.gateway"])(
    "uses detached launchd handoff for shared managed label %s even without launchd markers",
    async (launchdLabel) => {
      setPlatform("darwin");
      delete process.env.VITEST;
      delete process.env.NODE_ENV;
      process.env.OPENCLAW_LAUNCHD_LABEL = launchdLabel;

      const scriptDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restart-script-"));
      const scriptPath = path.join(scriptDir, "restart-local-gateway.sh");
      await fs.writeFile(scriptPath, "#!/usr/bin/env bash\nexit 0\n", "utf8");
      process.env.OPENCLAW_LOCAL_RESTART_SCRIPT = scriptPath;

      try {
        const result = triggerOpenClawRestart({ preferLocalScript: true });
        expect(result).toMatchObject({
          ok: true,
          method: "launchctl",
        });
        expect(result.detail).toContain(
          `scheduled detached launchd restart handoff for ${launchdLabel}`,
        );
        expect(result.tried).toContain(`launchd-handoff kickstart ${launchdLabel}`);
        expect(scheduleDetachedLaunchdRestartHandoffMock).toHaveBeenCalledWith({
          env: process.env,
          delayMs: 2000,
          mode: "kickstart",
        });
        expect(spawnMock).not.toHaveBeenCalled();
        expect(spawnSyncMock).not.toHaveBeenCalled();
      } finally {
        await fs.rm(scriptDir, { recursive: true, force: true });
      }
    },
  );

  it("guards a shared managed restart even when no local-script preference was requested", () => {
    setPlatform("darwin");
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    process.env.OPENCLAW_LAUNCHD_LABEL = "ai.jarvis.gateway";

    const result = triggerOpenClawRestart();

    expect(result).toMatchObject({ ok: true, method: "launchctl" });
    expect(scheduleDetachedLaunchdRestartHandoffMock).toHaveBeenCalledWith({
      env: process.env,
      delayMs: 2000,
      mode: "kickstart",
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
      scheduleDetachedLaunchdRestartHandoffMock.mockReturnValue({
        ok: false,
        detail: "handoff unavailable",
      });

      const scriptDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restart-script-"));
      const scriptPath = path.join(scriptDir, "restart-local-gateway.sh");
      await fs.writeFile(scriptPath, "#!/usr/bin/env bash\nexit 0\n", "utf8");
      process.env.OPENCLAW_LOCAL_RESTART_SCRIPT = scriptPath;

      try {
        const result = triggerOpenClawRestart({ preferLocalScript: true });
        expect(result).toEqual({
          ok: false,
          method: "launchctl",
          detail: "handoff unavailable",
          tried: [`launchd-handoff kickstart ${launchdLabel}`],
        });
        expect(cleanStaleGatewayProcessesSyncMock).not.toHaveBeenCalled();
        expect(spawnMock).not.toHaveBeenCalled();
        expect(spawnSyncMock).not.toHaveBeenCalled();
      } finally {
        await fs.rm(scriptDir, { recursive: true, force: true });
      }
    },
  );

  it.each(["ai.openclaw.gateway", "ai.jarvis.gateway"])(
    "routes live-tool shared managed restart for %s through external launchd handoff",
    (launchdLabel) => {
      setPlatform("darwin");
      delete process.env.VITEST;
      delete process.env.NODE_ENV;
      process.env.OPENCLAW_LAUNCHD_LABEL = launchdLabel;

      const result = requestGatewayToolRestart({
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
      expect(spawnMock).not.toHaveBeenCalled();
      expect(spawnSyncMock).not.toHaveBeenCalled();
    },
  );
});
