import { EventEmitter } from "node:events";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ensureGatewayLifecycleLease,
  GATEWAY_LIFECYCLE_TEMPORARY_UNAVAILABLE_EXIT_CODE,
} from "./gateway-lifecycle-lease.js";

function createSpawnedChild(exitCode: number) {
  const child = new EventEmitter() as EventEmitter & { pid: number };
  child.pid = 4242;
  queueMicrotask(() => child.emit("exit", exitCode, null));
  return child;
}

describe("gateway lifecycle lease", () => {
  it("runs in the current process only when ancestry proves the inherited lease", async () => {
    const spawnSync = vi.fn(() => ({ status: 0 }));
    const spawn = vi.fn();

    const result = await ensureGatewayLifecycleLease({
      platform: "darwin",
      cwd: process.cwd(),
      argv: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway", "restart"],
      execArgv: [],
      execPath: process.execPath,
      env: {
        ...process.env,
        OPENCLAW_HEAVY_LOCAL_SLOT_LEASE_TOKEN: "a".repeat(64),
      },
      fileExists: () => true,
      spawnSync: spawnSync as never,
      spawn: spawn as never,
    });

    expect(result).toEqual({ outcome: "held" });
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reexecutes the exact gateway restart argv and preserves contention exit 75", async () => {
    const spawnSync = vi.fn(() => ({ status: 1 }));
    const spawn = vi.fn(() => createSpawnedChild(75));
    const argv = [
      process.execPath,
      path.join(process.cwd(), "openclaw.mjs"),
      "gateway",
      "restart",
      "--json",
    ];

    const result = await ensureGatewayLifecycleLease({
      platform: "darwin",
      cwd: process.cwd(),
      argv,
      execArgv: ["--no-warnings"],
      execPath: process.execPath,
      env: { ...process.env, OPENCLAW_LAUNCHD_LABEL: "ai.jarvis.gateway" },
      fileExists: () => true,
      spawnSync: spawnSync as never,
      spawn: spawn as never,
    });

    expect(result).toEqual({ outcome: "reexecuted", exitCode: 75 });
    expect(spawn).toHaveBeenCalledWith(
      expect.stringMatching(/scripts\/with-heavy-local-slot\.sh$/),
      [
        "--policy",
        "gateway-lifecycle",
        "--label",
        "gateway-restart:ai.jarvis.gateway",
        "--",
        expect.stringMatching(/scripts\/gateway-lifecycle-command\.sh$/),
        "cli",
        "--",
        process.execPath,
        "--no-warnings",
        ...argv.slice(1),
      ],
      expect.objectContaining({ cwd: process.cwd(), stdio: "inherit" }),
    );
  });

  it("fails closed when a packaged runtime omits the lease helpers", async () => {
    const result = await ensureGatewayLifecycleLease({
      platform: "darwin",
      cwd: process.cwd(),
      argv: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway", "restart"],
      fileExists: () => false,
    });

    expect(result).toEqual({
      outcome: "reexecuted",
      exitCode: GATEWAY_LIFECYCLE_TEMPORARY_UNAVAILABLE_EXIT_CODE,
    });
  });
});
