import { describe, expect, it, vi } from "vitest";
import type { GatewayBonjourBeacon } from "../../infra/bonjour-discovery.js";
import { pickBeaconHost, pickGatewayPort } from "./discover.js";

const acquireGatewayLock = vi.fn(async (_opts?: { port?: number }) => ({
  release: vi.fn(async () => {}),
}));
const consumeGatewaySigusr1RestartAuthorization = vi.fn(() => true);
const isGatewaySigusr1RestartExternallyAllowed = vi.fn(() => false);
const markGatewaySigusr1RestartHandled = vi.fn();
const scheduleGatewaySigusr1Restart = vi.fn((_opts?: { delayMs?: number; reason?: string }) => ({
  ok: true,
  pid: process.pid,
  signal: "SIGUSR1" as const,
  delayMs: 0,
  mode: "emit" as const,
  coalesced: false,
  cooldownMsApplied: 0,
}));
const getActiveTaskCount = vi.fn(() => 0);
const markGatewayDraining = vi.fn();
const cancelGatewayDraining = vi.fn();
const waitForActiveTasks = vi.fn(async (_timeoutMs: number) => ({ drained: true }));
const resetAllLanes = vi.fn();
const restartGatewayProcessWithFreshPid = vi.fn<
  () => {
    mode: "spawned" | "supervised" | "disabled" | "failed";
    pid?: number;
    detail?: string;
    cancel?: () => boolean;
  }
>(() => ({ mode: "disabled" }));
const detectRespawnSupervisor = vi.fn<() => "launchd" | "systemd" | "schtasks" | undefined>(
  () => undefined,
);
const abortEmbeddedPiRun = vi.fn(
  (_sessionId?: string, _opts?: { mode?: "all" | "compacting" }) => false,
);
const getActiveEmbeddedRunCount = vi.fn(() => 0);
const waitForActiveEmbeddedRuns = vi.fn(async (_timeoutMs: number) => ({ drained: true }));
const DRAIN_TIMEOUT_LOG = "drain timeout reached; proceeding with restart";
const gatewayLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock("../../infra/gateway-lock.js", () => ({
  acquireGatewayLock: (opts?: { port?: number }) => acquireGatewayLock(opts),
}));

vi.mock("../../infra/restart.js", () => ({
  consumeGatewaySigusr1RestartAuthorization: () => consumeGatewaySigusr1RestartAuthorization(),
  isGatewaySigusr1RestartExternallyAllowed: () => isGatewaySigusr1RestartExternallyAllowed(),
  markGatewaySigusr1RestartHandled: () => markGatewaySigusr1RestartHandled(),
  scheduleGatewaySigusr1Restart: (opts?: { delayMs?: number; reason?: string }) =>
    scheduleGatewaySigusr1Restart(opts),
}));

vi.mock("../../infra/process-respawn.js", () => ({
  restartGatewayProcessWithFreshPid: () => restartGatewayProcessWithFreshPid(),
}));

vi.mock("../../infra/supervisor-markers.js", () => ({
  detectRespawnSupervisor: () => detectRespawnSupervisor(),
}));

vi.mock("../../process/command-queue.js", () => ({
  cancelGatewayDraining: () => cancelGatewayDraining(),
  getActiveTaskCount: () => getActiveTaskCount(),
  markGatewayDraining: () => markGatewayDraining(),
  waitForActiveTasks: (timeoutMs: number) => waitForActiveTasks(timeoutMs),
  resetAllLanes: () => resetAllLanes(),
}));

vi.mock("../../agents/pi-embedded-runner/runs.js", () => ({
  abortEmbeddedPiRun: (sessionId?: string, opts?: { mode?: "all" | "compacting" }) =>
    abortEmbeddedPiRun(sessionId, opts),
  getActiveEmbeddedRunCount: () => getActiveEmbeddedRunCount(),
  waitForActiveEmbeddedRuns: (timeoutMs: number) => waitForActiveEmbeddedRuns(timeoutMs),
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    ...gatewayLog,
    child: () => ({
      ...gatewayLog,
      child: () => ({
        ...gatewayLog,
      }),
    }),
  }),
}));

const LOOP_SIGNALS = ["SIGTERM", "SIGINT", "SIGUSR1"] as const;
type LoopSignal = (typeof LOOP_SIGNALS)[number];

function removeNewSignalListeners(signal: LoopSignal, existing: Set<(...args: unknown[]) => void>) {
  for (const listener of process.listeners(signal)) {
    const fn = listener as (...args: unknown[]) => void;
    if (!existing.has(fn)) {
      process.removeListener(signal, fn);
    }
  }
}

function addedSignalListener(
  signal: LoopSignal,
  existing: Set<(...args: unknown[]) => void>,
): (() => void) | null {
  const listeners = process.listeners(signal) as Array<(...args: unknown[]) => void>;
  for (let i = listeners.length - 1; i >= 0; i -= 1) {
    const listener = listeners[i];
    if (listener && !existing.has(listener)) {
      return listener as () => void;
    }
  }
  return null;
}

async function withIsolatedSignals(
  run: (helpers: { captureSignal: (signal: LoopSignal) => () => void }) => Promise<void>,
) {
  const existingListeners = Object.fromEntries(
    LOOP_SIGNALS.map((signal) => [
      signal,
      new Set(process.listeners(signal) as Array<(...args: unknown[]) => void>),
    ]),
  ) as Record<LoopSignal, Set<(...args: unknown[]) => void>>;
  const captureSignal = (signal: LoopSignal) => {
    const listener = addedSignalListener(signal, existingListeners[signal]);
    if (!listener) {
      throw new Error(`expected new ${signal} listener`);
    }
    return () => listener();
  };
  try {
    await run({ captureSignal });
  } finally {
    for (const signal of LOOP_SIGNALS) {
      removeNewSignalListeners(signal, existingListeners[signal]);
    }
  }
}

function createRuntimeWithExitSignal(exitCallOrder?: string[]) {
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      exitCallOrder?.push("exit");
      resolveExit(code);
    }),
  };
  return { runtime, exited };
}

type GatewayCloseFn = (...args: unknown[]) => Promise<void>;
type LoopRuntime = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => void;
};

function createSignaledStart(close: GatewayCloseFn) {
  let resolveStarted: (() => void) | null = null;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const start = vi.fn(async () => {
    resolveStarted?.();
    return { close };
  });
  return { start, started };
}

async function runLoopWithStart(params: {
  start: ReturnType<typeof vi.fn>;
  runtime: LoopRuntime;
  lockPort?: number;
}) {
  vi.resetModules();
  const { runGatewayLoop } = await import("./run-loop.js");
  const loopPromise = runGatewayLoop({
    start: params.start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
    runtime: params.runtime,
    lockPort: params.lockPort,
  });
  return { loopPromise };
}

async function waitForStart(started: Promise<void>) {
  await started;
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function createSignaledLoopHarness(exitCallOrder?: string[]) {
  const close = vi.fn(async () => {});
  const { start, started } = createSignaledStart(close);
  const { runtime, exited } = createRuntimeWithExitSignal(exitCallOrder);
  const { loopPromise } = await runLoopWithStart({ start, runtime });
  await waitForStart(started);
  return { close, start, runtime, exited, loopPromise };
}

describe("runGatewayLoop", () => {
  it("exits 0 on SIGTERM after graceful close", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, runtime, exited } = await createSignaledLoopHarness();
      const sigterm = captureSignal("SIGTERM");

      sigterm();

      await expect(exited).resolves.toBe(0);
      expect(close).toHaveBeenCalledWith({
        reason: "gateway stopping",
        restartExpectedMs: null,
      });
      expect(runtime.exit).toHaveBeenCalledWith(0);
    });
  });

  it("keeps the old server open until restart preflight and freshness validation finish", async () => {
    vi.clearAllMocks();
    restartGatewayProcessWithFreshPid.mockReturnValue({ mode: "disabled" });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const order: string[] = [];
      let resolvePreflight!: () => void;
      const preflightBlocked = new Promise<void>((resolve) => {
        resolvePreflight = resolve;
      });
      const prepared = { id: "prepared-restart" };
      const refreshedPrepared = { id: "refreshed-prepared-restart" };
      const prepareRestart = vi.fn(async () => {
        order.push("prepare");
        await preflightBlocked;
        return {
          prepared,
          validate: async () => {
            order.push("validate");
            return refreshedPrepared;
          },
        };
      });
      const closeFirst = vi.fn(async () => {
        order.push("close");
      });
      const closeSecond = vi.fn(async () => {});
      const start = vi
        .fn()
        .mockResolvedValueOnce({ close: closeFirst })
        .mockImplementationOnce(async (receivedPrepared) => {
          order.push("start");
          expect(receivedPrepared).toBe(refreshedPrepared);
          return { close: closeSecond };
        });
      const { runtime, exited } = createRuntimeWithExitSignal();
      vi.resetModules();
      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        prepareRestart,
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      const sigusr1 = captureSignal("SIGUSR1");
      const sigterm = captureSignal("SIGTERM");
      sigusr1();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(prepareRestart).toHaveBeenCalledTimes(1);
      expect(closeFirst).not.toHaveBeenCalled();
      expect(start).toHaveBeenCalledTimes(1);

      resolvePreflight();
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
      expect(order).toEqual(["prepare", "validate", "close", "start"]);
      expect(prepareRestart).toHaveBeenCalledTimes(1);

      sigterm();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("lets SIGTERM preempt a blocked restart preflight and prevents the later restart", async () => {
    vi.clearAllMocks();
    restartGatewayProcessWithFreshPid.mockReturnValue({ mode: "disabled" });

    await withIsolatedSignals(async ({ captureSignal }) => {
      let resolvePreflight!: () => void;
      const preflightBlocked = new Promise<void>((resolve) => {
        resolvePreflight = resolve;
      });
      const prepareRestart = vi.fn(async () => {
        await preflightBlocked;
        return {
          prepared: { id: "too-late" },
          validate: vi.fn(async () => {}),
        };
      });
      const close = vi.fn(async () => {});
      const { start, started } = createSignaledStart(close);
      const { runtime, exited } = createRuntimeWithExitSignal();
      vi.resetModules();
      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        prepareRestart,
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
      });
      await waitForStart(started);

      const sigusr1 = captureSignal("SIGUSR1");
      const sigterm = captureSignal("SIGTERM");
      sigusr1();
      await vi.waitFor(() => expect(prepareRestart).toHaveBeenCalledTimes(1));
      sigterm();

      await expect(exited).resolves.toBe(0);
      expect(close).toHaveBeenCalledWith({
        reason: "gateway stopping",
        restartExpectedMs: null,
      });

      resolvePreflight();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(start).toHaveBeenCalledTimes(1);
      expect(restartGatewayProcessWithFreshPid).not.toHaveBeenCalled();
    });
  });

  it("preserves SIGTERM during blocked final validation and stops the serving gateway", async () => {
    vi.clearAllMocks();
    restartGatewayProcessWithFreshPid.mockReturnValue({ mode: "disabled" });

    await withIsolatedSignals(async ({ captureSignal }) => {
      let resolveValidation!: () => void;
      const validationBlocked = new Promise<void>((resolve) => {
        resolveValidation = resolve;
      });
      const validate = vi.fn(async () => {
        await validationBlocked;
      });
      const prepareRestart = vi.fn(async () => ({
        prepared: { id: "prepared" },
        validate,
      }));
      const close = vi.fn(async () => {});
      const { start, started } = createSignaledStart(close);
      const { runtime, exited } = createRuntimeWithExitSignal();
      vi.resetModules();
      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        prepareRestart,
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
      });
      await waitForStart(started);

      const sigusr1 = captureSignal("SIGUSR1");
      const sigterm = captureSignal("SIGTERM");
      sigusr1();
      await vi.waitFor(() => expect(validate).toHaveBeenCalledTimes(1));
      sigterm();

      await expect(exited).resolves.toBe(0);
      expect(close).toHaveBeenCalledWith({
        reason: "gateway stopping",
        restartExpectedMs: null,
      });
      expect(start).toHaveBeenCalledTimes(1);
      expect(restartGatewayProcessWithFreshPid).not.toHaveBeenCalled();

      // A late provider result must not resurrect the cancelled restart.
      resolveValidation();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(start).toHaveBeenCalledTimes(1);
    });
  });

  it("cancels a failed restart preflight without closing the serving gateway", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      const close = vi.fn(async () => {});
      const { start, started } = createSignaledStart(close);
      const { runtime, exited } = createRuntimeWithExitSignal();
      const prepareRestart = vi.fn(async () => {
        throw new Error("secret backend unavailable");
      });
      vi.resetModules();
      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        prepareRestart,
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
      });
      await waitForStart(started);

      const sigusr1 = captureSignal("SIGUSR1");
      const sigterm = captureSignal("SIGTERM");
      sigusr1();
      await vi.waitFor(() => expect(prepareRestart).toHaveBeenCalledTimes(1));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(close).not.toHaveBeenCalled();
      expect(start).toHaveBeenCalledTimes(1);
      expect(gatewayLog.error).toHaveBeenCalledWith(
        expect.stringContaining("Restart cancelled; current gateway remains running"),
      );

      sigterm();
      await expect(exited).resolves.toBe(0);
      expect(close).toHaveBeenCalledTimes(1);
    });
  });

  it("reopens ingress without resetting active lanes when restart freshness validation fails", async () => {
    vi.clearAllMocks();
    getActiveEmbeddedRunCount.mockReturnValueOnce(1);
    waitForActiveEmbeddedRuns.mockResolvedValueOnce({ drained: false });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const close = vi.fn(async () => {});
      const { start, started } = createSignaledStart(close);
      const { runtime, exited } = createRuntimeWithExitSignal();
      const prepareRestart = vi.fn(async () => ({
        prepared: { id: "stale" },
        validate: vi.fn(async () => {
          throw new Error("config changed");
        }),
      }));
      vi.resetModules();
      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        prepareRestart,
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
      });
      await waitForStart(started);

      const sigusr1 = captureSignal("SIGUSR1");
      const sigterm = captureSignal("SIGTERM");
      sigusr1();
      await vi.waitFor(() => expect(cancelGatewayDraining).toHaveBeenCalledTimes(1));

      expect(resetAllLanes).not.toHaveBeenCalled();
      expect(abortEmbeddedPiRun).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(start).toHaveBeenCalledTimes(1);

      sigterm();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("restarts after SIGUSR1 even when drain times out, and resets lanes for the new iteration", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      getActiveTaskCount.mockReturnValueOnce(2).mockReturnValueOnce(0);
      getActiveEmbeddedRunCount.mockReturnValueOnce(1).mockReturnValueOnce(0);
      waitForActiveTasks.mockResolvedValueOnce({ drained: false });
      waitForActiveEmbeddedRuns.mockResolvedValueOnce({ drained: true });

      type StartServer = () => Promise<{
        close: (opts: { reason: string; restartExpectedMs: number | null }) => Promise<void>;
      }>;

      const closeFirst = vi.fn(async () => {});
      const closeSecond = vi.fn(async () => {});
      const closeThird = vi.fn(async () => {});
      const { runtime, exited } = createRuntimeWithExitSignal();

      const start = vi.fn<StartServer>();
      let resolveFirst: (() => void) | null = null;
      const startedFirst = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      start.mockImplementationOnce(async () => {
        resolveFirst?.();
        return { close: closeFirst };
      });

      let resolveSecond: (() => void) | null = null;
      const startedSecond = new Promise<void>((resolve) => {
        resolveSecond = resolve;
      });
      start.mockImplementationOnce(async () => {
        resolveSecond?.();
        return { close: closeSecond };
      });

      let resolveThird: (() => void) | null = null;
      const startedThird = new Promise<void>((resolve) => {
        resolveThird = resolve;
      });
      start.mockImplementationOnce(async () => {
        resolveThird?.();
        return { close: closeThird };
      });

      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
      });

      await startedFirst;
      const sigusr1 = captureSignal("SIGUSR1");
      const sigterm = captureSignal("SIGTERM");
      expect(start).toHaveBeenCalledTimes(1);
      await new Promise<void>((resolve) => setImmediate(resolve));

      sigusr1();

      await startedSecond;
      expect(start).toHaveBeenCalledTimes(2);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(abortEmbeddedPiRun).toHaveBeenCalledWith(undefined, { mode: "compacting" });
      expect(waitForActiveTasks).toHaveBeenCalledWith(90_000);
      expect(waitForActiveEmbeddedRuns).toHaveBeenCalledWith(90_000);
      expect(abortEmbeddedPiRun).toHaveBeenCalledWith(undefined, { mode: "all" });
      expect(markGatewayDraining).toHaveBeenCalledTimes(1);
      expect(gatewayLog.warn).toHaveBeenCalledWith(DRAIN_TIMEOUT_LOG);
      expect(closeFirst).toHaveBeenCalledWith({
        reason: "gateway restarting",
        restartExpectedMs: 1500,
      });
      expect(markGatewaySigusr1RestartHandled).toHaveBeenCalledTimes(1);
      expect(resetAllLanes).toHaveBeenCalledTimes(1);

      sigusr1();

      await startedThird;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closeSecond).toHaveBeenCalledWith({
        reason: "gateway restarting",
        restartExpectedMs: 1500,
      });
      expect(markGatewaySigusr1RestartHandled).toHaveBeenCalledTimes(2);
      expect(markGatewayDraining).toHaveBeenCalledTimes(2);
      expect(resetAllLanes).toHaveBeenCalledTimes(2);
      expect(acquireGatewayLock).toHaveBeenCalledTimes(3);

      sigterm();
      await expect(exited).resolves.toBe(0);
      expect(closeThird).toHaveBeenCalledWith({
        reason: "gateway stopping",
        restartExpectedMs: null,
      });
    });
  });

  it("routes external SIGUSR1 through the restart scheduler before draining", async () => {
    vi.clearAllMocks();
    consumeGatewaySigusr1RestartAuthorization.mockReturnValueOnce(false);
    isGatewaySigusr1RestartExternallyAllowed.mockReturnValueOnce(true);

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start } = await createSignaledLoopHarness();
      const sigusr1 = captureSignal("SIGUSR1");

      sigusr1();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(scheduleGatewaySigusr1Restart).toHaveBeenCalledWith({
        delayMs: 0,
        reason: "SIGUSR1",
      });
      expect(close).not.toHaveBeenCalled();
      expect(start).toHaveBeenCalledTimes(1);
      expect(markGatewaySigusr1RestartHandled).not.toHaveBeenCalled();
    });
  });

  it("releases the lock before exiting on spawned restart", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      const lockRelease = vi.fn(async () => {});
      acquireGatewayLock.mockResolvedValueOnce({
        release: lockRelease,
      });

      // Override process-respawn to return "spawned" mode
      restartGatewayProcessWithFreshPid.mockReturnValueOnce({
        mode: "spawned",
        pid: 9999,
      });

      const exitCallOrder: string[] = [];
      const { runtime, exited } = await createSignaledLoopHarness(exitCallOrder);
      const sigusr1 = captureSignal("SIGUSR1");
      lockRelease.mockImplementation(async () => {
        exitCallOrder.push("lockRelease");
      });

      sigusr1();

      await exited;
      expect(lockRelease).toHaveBeenCalled();
      expect(runtime.exit).toHaveBeenCalledWith(0);
      expect(exitCallOrder).toEqual(["lockRelease", "exit"]);
    });
  });

  it("keeps the launchd gateway serving when lifecycle admission is refused", async () => {
    vi.clearAllMocks();
    detectRespawnSupervisor.mockReturnValueOnce("launchd");
    restartGatewayProcessWithFreshPid.mockReturnValueOnce({
      mode: "failed",
      detail: "machine-wide lifecycle lease unavailable",
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start, exited } = await createSignaledLoopHarness();
      const sigusr1 = captureSignal("SIGUSR1");
      const sigterm = captureSignal("SIGTERM");

      sigusr1();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(restartGatewayProcessWithFreshPid).toHaveBeenCalledTimes(1);
      expect(close).not.toHaveBeenCalled();
      expect(start).toHaveBeenCalledTimes(1);
      expect(cancelGatewayDraining).toHaveBeenCalled();
      expect(gatewayLog.error).toHaveBeenCalledWith(
        expect.stringContaining("Restart cancelled; current gateway remains running"),
      );

      sigterm();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("starts the shutdown deadline only after launchd lifecycle admission", async () => {
    vi.clearAllMocks();
    detectRespawnSupervisor.mockReturnValueOnce("launchd");
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    restartGatewayProcessWithFreshPid.mockImplementationOnce(() => {
      // Final restart validation has its own timeout. The 5-second shutdown
      // deadline must not exist until the machine-wide lifecycle admission has
      // completed, because admission may legitimately wait longer than that.
      expect(timeoutSpy.mock.calls.some(([, delay]) => delay === 5_000)).toBe(false);
      return { mode: "supervised", pid: 4242 };
    });

    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const close = vi.fn(async () => {
          expect(timeoutSpy.mock.calls.some(([, delay]) => delay === 5_000)).toBe(true);
        });
        const { start, started } = createSignaledStart(close);
        const { runtime, exited } = createRuntimeWithExitSignal();
        const prepareRestart = vi.fn(async () => ({
          prepared: { id: "prepared" },
          validate: vi.fn(async () => {}),
        }));
        vi.resetModules();
        const { runGatewayLoop } = await import("./run-loop.js");
        void runGatewayLoop({
          prepareRestart,
          start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
          runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
        });
        await waitForStart(started);

        captureSignal("SIGUSR1")();

        await expect(exited).resolves.toBe(0);
        expect(close).toHaveBeenCalledTimes(1);
      });
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("cancels an admitted launchd handoff when stop supersedes restart during close", async () => {
    vi.clearAllMocks();
    detectRespawnSupervisor.mockReturnValueOnce("launchd");
    const cancel = vi.fn(() => true);
    restartGatewayProcessWithFreshPid.mockReturnValueOnce({
      mode: "supervised",
      pid: 4242,
      cancel,
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      let finishClose!: () => void;
      const closeBlocked = new Promise<void>((resolve) => {
        finishClose = resolve;
      });
      const close = vi.fn(async () => await closeBlocked);
      const { start, started } = createSignaledStart(close);
      const { runtime, exited } = createRuntimeWithExitSignal();
      await runLoopWithStart({ start, runtime });
      await waitForStart(started);
      const sigusr1 = captureSignal("SIGUSR1");
      const sigterm = captureSignal("SIGTERM");

      sigusr1();
      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
      sigterm();
      finishClose();

      await expect(exited).resolves.toBe(0);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(runtime.exit).toHaveBeenCalledWith(0);
    });
  });

  it("forwards lockPort to initial and restart lock acquisitions", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      const closeFirst = vi.fn(async () => {});
      const closeSecond = vi.fn(async () => {});
      const closeThird = vi.fn(async () => {});
      const { runtime, exited } = createRuntimeWithExitSignal();

      const start = vi
        .fn()
        .mockResolvedValueOnce({ close: closeFirst })
        .mockResolvedValueOnce({ close: closeSecond })
        .mockResolvedValueOnce({ close: closeThird });
      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
        lockPort: 18789,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const sigusr1 = captureSignal("SIGUSR1");
      const sigterm = captureSignal("SIGTERM");

      sigusr1();
      await new Promise<void>((resolve) => setImmediate(resolve));
      sigusr1();

      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(acquireGatewayLock).toHaveBeenNthCalledWith(1, { port: 18789 });
      expect(acquireGatewayLock).toHaveBeenNthCalledWith(2, { port: 18789 });
      expect(acquireGatewayLock).toHaveBeenNthCalledWith(3, { port: 18789 });

      sigterm();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("exits when lock reacquire fails during in-process restart fallback", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      const lockRelease = vi.fn(async () => {});
      acquireGatewayLock
        .mockResolvedValueOnce({
          release: lockRelease,
        })
        .mockRejectedValueOnce(new Error("lock timeout"));

      restartGatewayProcessWithFreshPid.mockReturnValueOnce({
        mode: "disabled",
      });

      const { start, exited } = await createSignaledLoopHarness();
      const sigusr1 = captureSignal("SIGUSR1");
      sigusr1();

      await expect(exited).resolves.toBe(1);
      expect(acquireGatewayLock).toHaveBeenCalledTimes(2);
      expect(start).toHaveBeenCalledTimes(1);
      expect(gatewayLog.error).toHaveBeenCalledWith(
        expect.stringContaining("failed to reacquire gateway lock for in-process restart"),
      );
    });
  });

  it("keeps process alive and logs phase-classified startup failures after restart", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      const closeFirst = vi.fn(async () => {});
      const start = vi.fn().mockResolvedValueOnce({ close: closeFirst }).mockRejectedValueOnce({
        name: "GatewayStartupPreflightError",
        phase: "config_validation",
        message: "Invalid config at /tmp/openclaw.json",
      });
      const { runtime, exited } = createRuntimeWithExitSignal();
      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      const sigusr1 = captureSignal("SIGUSR1");
      const sigterm = captureSignal("SIGTERM");
      sigusr1();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(gatewayLog.error).toHaveBeenCalledWith(
        expect.stringContaining(
          "Gateway startup phase failed (config_validation): Invalid config at /tmp/openclaw.json.",
        ),
      );
      expect(start).toHaveBeenCalledTimes(2);

      sigterm();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("keeps process alive and logs generic startup failures after restart", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      const closeFirst = vi.fn(async () => {});
      const start = vi
        .fn()
        .mockResolvedValueOnce({ close: closeFirst })
        .mockRejectedValueOnce(new Error("boom"));
      const { runtime, exited } = createRuntimeWithExitSignal();
      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      const sigusr1 = captureSignal("SIGUSR1");
      const sigterm = captureSignal("SIGTERM");
      sigusr1();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(gatewayLog.error).toHaveBeenCalledWith(
        expect.stringContaining("gateway startup failed: boom. Process will stay alive"),
      );

      sigterm();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("rethrows startup failures on first start", async () => {
    vi.clearAllMocks();
    const { runtime } = createRuntimeWithExitSignal();
    const { runGatewayLoop } = await import("./run-loop.js");

    await expect(
      runGatewayLoop({
        start: vi.fn(async () => {
          throw new Error("init failed");
        }),
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
      }),
    ).rejects.toThrow("init failed");
  });
});

describe("gateway discover routing helpers", () => {
  it("prefers resolved service host over TXT hints", () => {
    const beacon: GatewayBonjourBeacon = {
      instanceName: "Test",
      host: "10.0.0.2",
      lanHost: "evil.example.com",
      tailnetDns: "evil.example.com",
    };
    expect(pickBeaconHost(beacon)).toBe("10.0.0.2");
  });

  it("prefers resolved service port over TXT gatewayPort", () => {
    const beacon: GatewayBonjourBeacon = {
      instanceName: "Test",
      host: "10.0.0.2",
      port: 18789,
      gatewayPort: 12345,
    };
    expect(pickGatewayPort(beacon)).toBe(18789);
  });

  it("falls back to TXT host/port when resolve data is missing", () => {
    const beacon: GatewayBonjourBeacon = {
      instanceName: "Test",
      lanHost: "test-host.local",
      gatewayPort: 18789,
    };
    expect(pickBeaconHost(beacon)).toBe("test-host.local");
    expect(pickGatewayPort(beacon)).toBe(18789);
  });
});
