import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ensureGatewayLifecycleLease,
  ensureGatewayLifecycleLeaseForRestart,
  GATEWAY_LIFECYCLE_TEMPORARY_UNAVAILABLE_EXIT_CODE,
} from "./gateway-lifecycle-lease.js";

function createSpawnedChild(exitCode: number) {
  const child = new EventEmitter() as EventEmitter & { pid: number };
  child.pid = 4242;
  queueMicrotask(() => child.emit("exit", exitCode, null));
  return child;
}

describe("gateway lifecycle lease", () => {
  it("runs in the current process only when ancestry proves the inherited lifecycle lease", async () => {
    const spawnSync = vi.fn(() => ({ status: 0 }));
    const spawn = vi.fn();
    const lockFd = fs.openSync("/dev/null", "r");

    const result = await ensureGatewayLifecycleLease({
      platform: "darwin",
      cwd: process.cwd(),
      argv: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway", "restart"],
      execArgv: [],
      execPath: process.execPath,
      env: {
        ...process.env,
        OPENCLAW_HEAVY_LOCAL_SLOT_LEASE_TOKEN: "a".repeat(64),
        OPENCLAW_SHARED_RESOURCE_LOCK_FD: String(lockFd),
      },
      fileExists: () => true,
      spawnSync: spawnSync as never,
      spawn: spawn as never,
    });
    fs.closeSync(lockFd);

    expect(result).toEqual({ outcome: "held" });
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync).toHaveBeenCalledWith(
      "/bin/bash",
      expect.arrayContaining([
        expect.stringContaining(
          "openclaw_heavy_local_slot_inherited_lease_is_valid gateway-lifecycle",
        ),
      ]),
      expect.objectContaining({
        stdio: expect.objectContaining({ [lockFd]: lockFd }),
      }),
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not inherit closed, stdio, or malformed lock descriptor values", async () => {
    const spawnSync = vi.fn(() => ({ status: 1 }));

    await ensureGatewayLifecycleLease({
      platform: "darwin",
      cwd: process.cwd(),
      argv: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway", "restart"],
      execPath: process.execPath,
      env: {
        ...process.env,
        OPENCLAW_SHARED_RESOURCE_LOCK_FD: "2,9x,9007199254740992",
      },
      fileExists: () => true,
      spawnSync: spawnSync as never,
      spawn: vi.fn(() => createSpawnedChild(75)) as never,
    });

    const calls = spawnSync.mock.calls as unknown as Array<
      [string, string[], { stdio: Array<"ignore" | number> }]
    >;
    const options = calls[0][2];
    expect(options.stdio).toEqual(["ignore", "ignore", "ignore"]);
  });

  it("preserves a valid inherited lock descriptor above 256", async () => {
    const lockFd = 257;
    const spawnSync = vi.fn(() => ({ status: 0 }));

    const result = await ensureGatewayLifecycleLease({
      platform: "darwin",
      cwd: process.cwd(),
      argv: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway", "restart"],
      execPath: process.execPath,
      env: {
        ...process.env,
        OPENCLAW_SHARED_RESOURCE_LOCK_FD: String(lockFd),
      },
      fileExists: () => true,
      fileDescriptorIsOpen: (fd) => fd === lockFd,
      spawnSync: spawnSync as never,
      spawn: vi.fn() as never,
    });

    expect(result).toEqual({ outcome: "held" });
    const calls = spawnSync.mock.calls as unknown as Array<
      [string, string[], { stdio: Array<"ignore" | number> }]
    >;
    expect(calls[0][2].stdio[lockFd]).toBe(lockFd);
  });

  it("accepts an inherited canonical gateway resource lock", async () => {
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
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway",
        OPENCLAW_HEAVY_LOCAL_SLOT_LEASE_TOKEN: "b".repeat(64),
      },
      fileExists: () => true,
      spawnSync: spawnSync as never,
      spawn: spawn as never,
    });

    expect(result).toEqual({ outcome: "held" });
    expect(spawnSync).toHaveBeenCalledWith(
      "/bin/bash",
      expect.arrayContaining(["1"]),
      expect.any(Object),
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("requires the Jarvis-aware lifecycle owner for main Jarvis replacement", async () => {
    const spawnSync = vi.fn(() => ({ status: 1 }));
    const spawn = vi.fn(() => createSpawnedChild(75));

    const result = await ensureGatewayLifecycleLease({
      platform: "darwin",
      cwd: process.cwd(),
      argv: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway", "restart"],
      execPath: process.execPath,
      env: {
        ...process.env,
        OPENCLAW_LAUNCHD_LABEL: "ai.jarvis.gateway",
        OPENCLAW_HEAVY_LOCAL_SLOT_LEASE_TOKEN: "c".repeat(64),
      },
      fileExists: () => true,
      spawnSync: spawnSync as never,
      spawn: spawn as never,
    });

    expect(result).toEqual({ outcome: "reexecuted", exitCode: 75 });
    expect(spawnSync).toHaveBeenCalledWith(
      "/bin/bash",
      expect.arrayContaining(["0"]),
      expect.any(Object),
    );
    expect(spawn).toHaveBeenCalledTimes(1);
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
        ...argv.slice(1),
      ],
      expect.objectContaining({ cwd: process.cwd(), stdio: "inherit" }),
    );
    const [, guardedArgs] = spawn.mock.calls[0] as unknown as [string, string[]];
    expect(guardedArgs).not.toContain("--no-warnings");
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

  it("reexecutes a canonical restart instead of a programmatic caller's parent command", async () => {
    const spawnSync = vi.fn(() => ({ status: 1 }));
    const spawn = vi.fn(() => createSpawnedChild(75));

    const result = await ensureGatewayLifecycleLeaseForRestart(
      {
        json: true,
        refreshServiceEnv: {
          root: "/tmp/openclaw-updated-root",
          invocationCwd: "/tmp/openclaw-invocation",
        },
      },
      {
        platform: "darwin",
        cwd: process.cwd(),
        argv: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "update"],
        execPath: process.execPath,
        env: { ...process.env, OPENCLAW_LAUNCHD_LABEL: "ai.jarvis.gateway" },
        fileExists: () => true,
        spawnSync: spawnSync as never,
        spawn: spawn as never,
      },
    );

    expect(result).toEqual({ outcome: "reexecuted", exitCode: 75 });
    const [, guardedArgs] = spawn.mock.calls[0] as unknown as [string, string[]];
    expect(guardedArgs).toEqual(
      expect.arrayContaining([
        "cli",
        "--",
        process.execPath,
        path.join(process.cwd(), "openclaw.mjs"),
        "gateway",
        "restart",
        "--json",
        "--refresh-service-env",
        "--refresh-service-env-root",
        "/tmp/openclaw-updated-root",
        "--refresh-service-env-cwd",
        "/tmp/openclaw-invocation",
      ]),
    );
    expect(guardedArgs).not.toContain("update");
  });
});
