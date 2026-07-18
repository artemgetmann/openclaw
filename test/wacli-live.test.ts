import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLiveOwnerHelperTimeoutMs } from "../skills/wacli/scripts/wacli-health.ts";
import {
  commandLooksLikeExpectedOwner,
  ensureOwner,
  type EnsureOwnerDeps,
  type Flags,
  type LiveStatus,
} from "../skills/wacli/scripts/wacli-live.ts";

const tempRoots: string[] = [];

function makeFlags(storeDir: string): Flags {
  return {
    command: "ensure",
    json: true,
    storeDir,
    settleMs: 1_000,
    graceMs: 1_000,
    timeoutMs: 1_000,
    tailLines: 40,
  };
}

function makeStatus(overrides: Partial<LiveStatus> = {}): LiveStatus {
  return {
    ok: true,
    action: "ensure",
    storeDir: "/tmp/wacli-test",
    pidFile: "/tmp/wacli-test/openclaw-sync-owner.json",
    logFile: "/tmp/wacli-test/openclaw-sync.log",
    ownerRunning: true,
    ownerPid: 101,
    ownerStartedAt: new Date(0).toISOString(),
    ownerAgeMs: 60_000,
    ownerCommandMatches: true,
    lockHeldByOwner: true,
    lastLifecycleEvent: "connected",
    connected: true,
    logTail: [],
    message: "test",
    ...overrides,
  };
}

async function createStore(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wacli-live-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => await fs.rm(root, { recursive: true, force: true })),
  );
});

describe("wacli live owner ensure", () => {
  it("recognizes the store-aware command spawned by the owner helper", () => {
    expect(
      commandLooksLikeExpectedOwner(
        "/opt/homebrew/bin/wacli --store /tmp/wacli-test sync --follow --json",
        "/tmp/wacli-test",
      ),
    ).toBe(true);
    expect(
      commandLooksLikeExpectedOwner(
        "/opt/homebrew/bin/wacli --store /tmp/other-store sync --follow --json",
        "/tmp/wacli-test",
      ),
    ).toBe(false);
    expect(
      commandLooksLikeExpectedOwner(
        "node helper.js --note wacli --store /tmp/wacli-test sync --follow --json trailing",
        "/tmp/wacli-test",
      ),
    ).toBe(false);
  });

  it("budgets the health wrapper for reconnect, stop, and replacement settle", () => {
    expect(resolveLiveOwnerHelperTimeoutMs(15_000, "ensure")).toBe(45_000);
    expect(resolveLiveOwnerHelperTimeoutMs(15_000, "status")).toBe(15_000);
  });

  it("reuses a healthy matching owner without restart churn", async () => {
    const storeDir = await createStore();
    const initial = makeStatus();
    const deps: EnsureOwnerDeps = {
      collectStatus: vi.fn(async () => initial),
      now: () => 0,
      sleep: vi.fn(async () => undefined),
      startOwner: vi.fn(async () => undefined),
      stopOwner: vi.fn(async () => makeStatus({ connected: false })),
    };

    const result = await ensureOwner(makeFlags(storeDir), deps);

    expect(result).toBe(initial);
    expect(deps.stopOwner).not.toHaveBeenCalled();
    expect(deps.startOwner).not.toHaveBeenCalled();
  });

  it("restarts one established matching owner that stays disconnected", async () => {
    const storeDir = await createStore();
    let now = 0;
    let ownerStarted = false;
    const unhealthy = makeStatus({
      connected: false,
      lastLifecycleEvent: "reconnecting",
      message: "reconnecting",
    });
    const deps: EnsureOwnerDeps = {
      collectStatus: vi.fn(async () =>
        ownerStarted ? makeStatus({ ownerPid: 202, message: "replacement connected" }) : unhealthy,
      ),
      now: () => now,
      sleep: vi.fn(async (ms: number) => {
        now += ms;
      }),
      startOwner: vi.fn(async () => {
        ownerStarted = true;
      }),
      stopOwner: vi.fn(async () =>
        makeStatus({
          ownerRunning: false,
          ownerCommandMatches: false,
          lockHeldByOwner: false,
          connected: false,
          lastLifecycleEvent: "reconnecting",
          stopReason: "stopped",
        }),
      ),
    };

    const result = await ensureOwner(makeFlags(storeDir), deps);

    expect(deps.stopOwner).toHaveBeenCalledTimes(1);
    expect(deps.startOwner).toHaveBeenCalledTimes(1);
    expect(result.connected).toBe(true);
    expect(result.ownerPid).toBe(202);
  });

  it("does not restart an owner that is reconnecting during startup", async () => {
    const storeDir = await createStore();
    const recentOwner = makeStatus({
      ownerAgeMs: 5_000,
      connected: false,
      lastLifecycleEvent: "reconnecting",
    });
    const deps: EnsureOwnerDeps = {
      collectStatus: vi.fn(async () => recentOwner),
      now: () => 0,
      sleep: vi.fn(async () => undefined),
      startOwner: vi.fn(async () => undefined),
      stopOwner: vi.fn(async () => makeStatus({ connected: false })),
    };

    const result = await ensureOwner(makeFlags(storeDir), deps);

    expect(result.message).toContain("startup grace");
    expect(deps.stopOwner).not.toHaveBeenCalled();
    expect(deps.startOwner).not.toHaveBeenCalled();
  });

  it("never sends a mismatched recorded PID through the restart stop path", async () => {
    const storeDir = await createStore();
    let ownerStarted = false;
    const mismatched = makeStatus({
      ownerCommandMatches: false,
      connected: false,
      lastLifecycleEvent: "disconnected",
      message: "PID belongs to another process",
    });
    const deps: EnsureOwnerDeps = {
      collectStatus: vi.fn(async () =>
        ownerStarted ? makeStatus({ ownerPid: 303, message: "replacement connected" }) : mismatched,
      ),
      now: () => 0,
      sleep: vi.fn(async () => undefined),
      startOwner: vi.fn(async () => {
        ownerStarted = true;
      }),
      stopOwner: vi.fn(async () => {
        throw new Error("mismatched PID must not be signaled");
      }),
    };

    const result = await ensureOwner(makeFlags(storeDir), deps);

    expect(deps.stopOwner).not.toHaveBeenCalled();
    expect(deps.startOwner).toHaveBeenCalledTimes(1);
    expect(result.connected).toBe(true);
  });
});
