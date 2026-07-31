import {
  abortEmbeddedPiRun,
  getActiveEmbeddedRunCount,
  waitForActiveEmbeddedRuns,
} from "../../agents/pi-embedded-runner/runs.js";
import { formatGatewayStartupPreflightFailure } from "../../gateway/server-startup-preflight.js";
import type { startGatewayServer } from "../../gateway/server.js";
import { acquireGatewayLock } from "../../infra/gateway-lock.js";
import {
  restartGatewayProcessWithFreshPid,
  type GatewayRespawnResult,
} from "../../infra/process-respawn.js";
import {
  consumeGatewaySigusr1RestartAuthorization,
  isGatewaySigusr1RestartExternallyAllowed,
  markGatewaySigusr1RestartHandled,
  scheduleGatewaySigusr1Restart,
} from "../../infra/restart.js";
import { detectRespawnSupervisor } from "../../infra/supervisor-markers.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  cancelGatewayDraining,
  getActiveTaskCount,
  markGatewayDraining,
  resetAllLanes,
  waitForActiveTasks,
} from "../../process/command-queue.js";
import { createRestartIterationHook } from "../../process/restart-recovery.js";
import type { defaultRuntime } from "../../runtime.js";

const gatewayLog = createSubsystemLogger("gateway");

type GatewayRunSignalAction = "stop" | "restart";

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export type GatewayRestartPreparation<TPrepared> = {
  prepared: TPrepared;
  /**
   * Revalidate staged inputs immediately before cutover. Validators may return
   * a refreshed preparation when an input is too old to activate safely.
   */
  validate: () => Promise<TPrepared | void>;
};

export async function runGatewayLoop<TPrepared = never>(params: {
  start: (prepared?: TPrepared) => Promise<Awaited<ReturnType<typeof startGatewayServer>>>;
  prepareRestart?: () => Promise<GatewayRestartPreparation<TPrepared>>;
  runtime: typeof defaultRuntime;
  lockPort?: number;
}) {
  let lock = await acquireGatewayLock({ port: params.lockPort });
  let server: Awaited<ReturnType<typeof startGatewayServer>> | null = null;
  let shuttingDown = false;
  let restartResolver: (() => void) | null = null;
  let pendingPreparedRestart: TPrepared | undefined;
  let restartPreparationGeneration = 0;
  let activeRestartPreparationGeneration: number | null = null;
  let cancelActiveRestartValidation: (() => void) | null = null;
  let pendingStopSignal: string | null = null;

  const cleanupSignals = () => {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGUSR1", onSigusr1);
  };
  const exitProcess = (code: number) => {
    cleanupSignals();
    params.runtime.exit(code);
  };
  const releaseLockIfHeld = async (): Promise<boolean> => {
    if (!lock) {
      return false;
    }
    await lock.release();
    lock = null;
    return true;
  };
  const reacquireLockForInProcessRestart = async (): Promise<boolean> => {
    try {
      lock = await acquireGatewayLock({ port: params.lockPort });
      return true;
    } catch (err) {
      gatewayLog.error(`failed to reacquire gateway lock for in-process restart: ${String(err)}`);
      exitProcess(1);
      return false;
    }
  };
  const handleRestartAfterServerClose = async (preparedRespawn?: GatewayRespawnResult) => {
    const hadLock = await releaseLockIfHeld();
    // Unsupervised children still need the port lock released before spawn.
    // A launchd child was already admitted while the listener was healthy and
    // is holding the lifecycle lease until this exact process exits.
    const respawn = preparedRespawn ?? restartGatewayProcessWithFreshPid();
    if (respawn.mode === "spawned" || respawn.mode === "supervised") {
      const modeLabel =
        respawn.mode === "spawned"
          ? `spawned pid ${respawn.pid ?? "unknown"}`
          : "supervisor restart";
      gatewayLog.info(`restart mode: full process restart (${modeLabel})`);
      exitProcess(0);
      return;
    }
    if (respawn.mode === "failed") {
      gatewayLog.warn(
        `full process restart failed (${respawn.detail ?? "unknown error"}); falling back to in-process restart`,
      );
    } else {
      gatewayLog.info(
        `restart mode: in-process restart (${respawn.detail ?? "OPENCLAW_NO_RESPAWN"})`,
      );
    }
    if (hadLock && !(await reacquireLockForInProcessRestart())) {
      return;
    }
    shuttingDown = false;
    restartResolver?.();
  };
  const handleStopAfterServerClose = async () => {
    await releaseLockIfHeld();
    exitProcess(0);
  };

  const DRAIN_TIMEOUT_MS = 90_000;
  const FINAL_RESTART_VALIDATION_TIMEOUT_MS = 180_000;
  const SHUTDOWN_TIMEOUT_MS = 5_000;

  const request = (action: GatewayRunSignalAction, signal: string) => {
    if (shuttingDown) {
      if (action === "stop" && activeRestartPreparationGeneration !== null) {
        // A read-only restart preflight may wait indefinitely on an external
        // secret backend. Stop signals must invalidate that work and start
        // their own bounded shutdown immediately.
        restartPreparationGeneration += 1;
        activeRestartPreparationGeneration = null;
        shuttingDown = false;
        gatewayLog.info(`received ${signal} during restart preflight; cancelling restart`);
        request("stop", signal);
        return;
      }
      if (action === "stop" && cancelActiveRestartValidation) {
        // Final credential refresh is intentionally fallible and may wait on
        // an external provider. Interrupt its await immediately, then let the
        // restart coroutine reopen ingress before it begins bounded shutdown.
        pendingStopSignal = signal;
        cancelActiveRestartValidation();
        gatewayLog.info(`received ${signal} during restart validation; cancelling restart`);
        return;
      }
      if (action === "stop") {
        // Once listener close has begun it cannot be rolled back. Preserve the
        // explicit stop so the completion path exits instead of restarting.
        pendingStopSignal = signal;
        gatewayLog.info(`received ${signal} during restart cutover; stopping after close`);
        return;
      }
      gatewayLog.info(`received ${signal} during shutdown; ignoring`);
      return;
    }
    shuttingDown = true;
    const isRestart = action === "restart";
    gatewayLog.info(`received ${signal}; ${isRestart ? "restarting" : "shutting down"}`);

    // Allow extra time for draining active turns on restart.
    void (async () => {
      let restartPreparation: GatewayRestartPreparation<TPrepared> | undefined;
      let preparedRespawn: GatewayRespawnResult | undefined;
      if (isRestart && params.prepareRestart) {
        const preparationGeneration = ++restartPreparationGeneration;
        activeRestartPreparationGeneration = preparationGeneration;
        try {
          // Expensive read-only work runs while the old listener remains
          // available. A failed preflight aborts the restart before draining
          // or closing any live runtime.
          restartPreparation = await params.prepareRestart();
        } catch (err) {
          if (activeRestartPreparationGeneration !== preparationGeneration) {
            return;
          }
          activeRestartPreparationGeneration = null;
          const classified = formatGatewayStartupPreflightFailure(err);
          gatewayLog.error(
            classified
              ? `${classified}. Restart cancelled; current gateway remains running.`
              : `gateway restart preflight failed: ${String(err)}. Restart cancelled; current gateway remains running.`,
          );
          shuttingDown = false;
          return;
        }
        if (activeRestartPreparationGeneration !== preparationGeneration) {
          return;
        }
        activeRestartPreparationGeneration = null;
      }

      let forceExitTimer: NodeJS.Timeout | undefined;
      const armForceExit = (timeoutMs: number) => {
        forceExitTimer = setTimeout(() => {
          gatewayLog.error("shutdown timed out; exiting without full cleanup");
          // Exit non-zero on restart timeout so launchd/systemd treats it as a
          // failure and triggers a clean process restart instead of assuming the
          // shutdown was intentional. Stop-timeout stays at 0 (graceful). (#36822)
          // A stop signal may arrive after restart cutover begins. Consult the
          // live pending action so a slow close stops cleanly instead of
          // exiting as a restart failure and inviting supervisor relaunch.
          exitProcess(isRestart && !pendingStopSignal ? 1 : 0);
        }, timeoutMs);
      };
      // A staged restart keeps the serving listener open through its bounded
      // drain and final credential refresh. Arm the destructive shutdown timer
      // only after those safe-to-cancel phases have committed to cutover.
      if (!restartPreparation) {
        armForceExit(isRestart ? DRAIN_TIMEOUT_MS + SHUTDOWN_TIMEOUT_MS : SHUTDOWN_TIMEOUT_MS);
      }
      const continueWithPendingStop = (): boolean => {
        if (!pendingStopSignal) {
          return false;
        }
        const stopSignal = pendingStopSignal;
        pendingStopSignal = null;
        shuttingDown = false;
        // Finish this restart coroutine (including its finally block) before
        // starting a separate stop coroutine against the same server.
        queueMicrotask(() => request("stop", stopSignal));
        return true;
      };

      try {
        let drainTimedOut = false;
        // On restart, wait for in-flight agent turns to finish before
        // tearing down the server so buffered messages are delivered.
        if (isRestart) {
          // Reject new enqueues immediately during the drain window so
          // sessions get an explicit restart error instead of silent task loss.
          markGatewayDraining();
          const activeTasks = getActiveTaskCount();
          const activeRuns = getActiveEmbeddedRunCount();

          // Best-effort abort for compacting runs so long compaction operations
          // don't hold session write locks across restart boundaries.
          if (activeRuns > 0 && !restartPreparation) {
            abortEmbeddedPiRun(undefined, { mode: "compacting" });
          }

          if (activeTasks > 0 || activeRuns > 0) {
            gatewayLog.info(
              `draining ${activeTasks} active task(s) and ${activeRuns} active embedded run(s) before restart (timeout ${DRAIN_TIMEOUT_MS}ms)`,
            );
            const [tasksDrain, runsDrain] = await Promise.all([
              activeTasks > 0
                ? waitForActiveTasks(DRAIN_TIMEOUT_MS)
                : Promise.resolve({ drained: true }),
              activeRuns > 0
                ? waitForActiveEmbeddedRuns(DRAIN_TIMEOUT_MS)
                : Promise.resolve({ drained: true }),
            ]);
            if (tasksDrain.drained && runsDrain.drained) {
              gatewayLog.info("all active work drained");
            } else {
              gatewayLog.warn("drain timeout reached; proceeding with restart");
              drainTimedOut = true;
            }
          }
        }

        if (restartPreparation && pendingStopSignal) {
          cancelGatewayDraining();
          continueWithPendingStop();
          return;
        }

        if (restartPreparation) {
          try {
            // Re-read config after draining and immediately before close. This
            // rejects a staged context made stale during the preflight window.
            let cancelValidation!: () => void;
            const validationCancelled = new Promise<never>((_, reject) => {
              cancelValidation = () => reject(new Error("gateway restart validation cancelled"));
            });
            cancelActiveRestartValidation = cancelValidation;
            const refreshedPreparation = await withTimeout(
              Promise.race([restartPreparation.validate(), validationCancelled]),
              FINAL_RESTART_VALIDATION_TIMEOUT_MS,
              "gateway restart final validation",
            ).finally(() => {
              if (cancelActiveRestartValidation === cancelValidation) {
                cancelActiveRestartValidation = null;
              }
            });
            if (refreshedPreparation !== undefined) {
              restartPreparation.prepared = refreshedPreparation;
            }
          } catch (err) {
            // The old listener and any timed-out active tasks are still alive.
            // Re-open ingress without clearing their lane bookkeeping.
            cancelGatewayDraining();
            if (continueWithPendingStop()) {
              return;
            }
            const classified = formatGatewayStartupPreflightFailure(err);
            gatewayLog.error(
              classified
                ? `${classified}. Restart cancelled; current gateway remains running.`
                : `gateway restart preflight became stale: ${String(err)}. Restart cancelled; current gateway remains running.`,
            );
            shuttingDown = false;
            return;
          }
          pendingPreparedRestart = restartPreparation.prepared;
        }

        if (isRestart && detectRespawnSupervisor(process.env) === "launchd") {
          // Admit the detached launchd owner while the old listener is still
          // serving. If the machine-wide lease refuses this restart, reopen
          // ingress and leave the current process untouched instead of closing
          // first and falling back to an unguarded in-process restart.
          const respawn = restartGatewayProcessWithFreshPid();
          if (respawn.mode === "failed") {
            cancelGatewayDraining();
            gatewayLog.error(
              `gateway restart admission failed: ${respawn.detail ?? "launchd handoff refused"}. Restart cancelled; current gateway remains running.`,
            );
            shuttingDown = false;
            return;
          }
          if (respawn.mode === "supervised") {
            preparedRespawn = respawn;
          }
        }

        if (restartPreparation) {
          // Admission can legitimately wait while another lifecycle owner exits.
          // Start the shutdown deadline only after we have committed to cutover;
          // otherwise lock contention can consume the entire close budget while
          // the old listener is still intentionally serving.
          armForceExit(SHUTDOWN_TIMEOUT_MS);
        }

        if (drainTimedOut) {
          // Only terminate surviving work after the final freshness check has
          // committed this restart to cutover. A cancelled restart must leave
          // the old listener and its active work intact.
          abortEmbeddedPiRun(undefined, { mode: "all" });
        }

        await server?.close({
          reason: isRestart ? "gateway restarting" : "gateway stopping",
          restartExpectedMs: isRestart ? 1500 : null,
        });
      } catch (err) {
        gatewayLog.error(`shutdown error: ${String(err)}`);
      } finally {
        if (forceExitTimer) {
          clearTimeout(forceExitTimer);
        }
        if (shuttingDown) {
          server = null;
          if (isRestart && !pendingStopSignal) {
            await handleRestartAfterServerClose(preparedRespawn);
          } else {
            if (preparedRespawn?.cancel && !preparedRespawn.cancel()) {
              // Losing the cancellation receipt would make exit ambiguous: the
              // detached helper could relaunch after an explicit stop. Keep the
              // current process alive and reopen the listener fail-closed.
              gatewayLog.error(
                "could not cancel admitted launchd restart; preserving the current gateway instead of exiting",
              );
              pendingStopSignal = null;
              shuttingDown = false;
              restartResolver?.();
            } else {
              pendingStopSignal = null;
              await handleStopAfterServerClose();
            }
          }
        }
      }
    })();
  };

  const onSigterm = () => {
    gatewayLog.info("signal SIGTERM received");
    request("stop", "SIGTERM");
  };
  const onSigint = () => {
    gatewayLog.info("signal SIGINT received");
    request("stop", "SIGINT");
  };
  const onSigusr1 = () => {
    gatewayLog.info("signal SIGUSR1 received");
    const authorized = consumeGatewaySigusr1RestartAuthorization();
    if (!authorized) {
      if (!isGatewaySigusr1RestartExternallyAllowed()) {
        gatewayLog.warn(
          "SIGUSR1 restart ignored (not authorized; commands.restart=false or use gateway tool).",
        );
        return;
      }
      if (shuttingDown) {
        gatewayLog.info("received SIGUSR1 during shutdown; ignoring");
        return;
      }
      // External SIGUSR1 requests should still reuse the in-process restart
      // scheduler so idle drain and restart coalescing stay consistent.
      scheduleGatewaySigusr1Restart({ delayMs: 0, reason: "SIGUSR1" });
      return;
    }
    markGatewaySigusr1RestartHandled();
    request("restart", "SIGUSR1");
  };

  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  process.on("SIGUSR1", onSigusr1);

  try {
    const onIteration = createRestartIterationHook(() => {
      // After an in-process restart (SIGUSR1), reset command-queue lane state.
      // Interrupted tasks from the previous lifecycle may have left `active`
      // counts elevated (their finally blocks never ran), permanently blocking
      // new work from draining. This must happen here — at the restart
      // coordinator level — rather than inside individual subsystem init
      // functions, to avoid surprising cross-cutting side effects.
      resetAllLanes();
    });

    // Keep process alive; SIGUSR1 triggers an in-process restart (no supervisor required).
    // SIGTERM/SIGINT still exit after a graceful shutdown.
    let isFirstStart = true;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      onIteration();
      try {
        const preparedRestart = pendingPreparedRestart;
        pendingPreparedRestart = undefined;
        server = await params.start(preparedRestart);
        isFirstStart = false;
      } catch (err) {
        // On initial startup, let the error propagate so the outer handler
        // can report "Gateway failed to start" and exit non-zero. Only
        // swallow errors on subsequent in-process restarts to keep the
        // process alive (a crash would lose macOS TCC permissions). (#35862)
        if (isFirstStart) {
          throw err;
        }
        server = null;
        // Release the gateway lock so that `daemon restart/stop` (which
        // discovers PIDs via the gateway port) can still manage the process.
        // Without this, the process holds the lock but is not listening,
        // forcing manual cleanup. (#35862)
        await releaseLockIfHeld();
        const errMsg = err instanceof Error ? err.message : String(err);
        const errStack = err instanceof Error && err.stack ? `\n${err.stack}` : "";
        const startupPreflightFailure = formatGatewayStartupPreflightFailure(err);
        gatewayLog.error(
          startupPreflightFailure
            ? `${startupPreflightFailure}. Process will stay alive; fix the issue and restart.${errStack}`
            : `gateway startup failed: ${errMsg}. Process will stay alive; fix the issue and restart.${errStack}`,
        );
      }
      await new Promise<void>((resolve) => {
        restartResolver = resolve;
      });
    }
  } finally {
    await releaseLockIfHeld();
    cleanupSignals();
  }
}
