import {
  abortEmbeddedPiRun,
  getActiveEmbeddedRunCount,
  waitForActiveEmbeddedRuns,
} from "../../agents/pi-embedded-runner/runs.js";
import { formatGatewayStartupPreflightFailure } from "../../gateway/server-startup-preflight.js";
import type { startGatewayServer } from "../../gateway/server.js";
import { acquireGatewayLock } from "../../infra/gateway-lock.js";
import { restartGatewayProcessWithFreshPid } from "../../infra/process-respawn.js";
import {
  consumeGatewaySigusr1RestartAuthorization,
  isGatewaySigusr1RestartExternallyAllowed,
  markGatewaySigusr1RestartHandled,
  scheduleGatewaySigusr1Restart,
} from "../../infra/restart.js";
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

export type GatewayRestartPreparation<TPrepared> = {
  prepared: TPrepared;
  validate: () => Promise<void>;
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
  const handleRestartAfterServerClose = async () => {
    const hadLock = await releaseLockIfHeld();
    // Release the lock BEFORE spawning so the child can acquire it immediately.
    const respawn = restartGatewayProcessWithFreshPid();
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
      gatewayLog.info(`received ${signal} during shutdown; ignoring`);
      return;
    }
    shuttingDown = true;
    const isRestart = action === "restart";
    gatewayLog.info(`received ${signal}; ${isRestart ? "restarting" : "shutting down"}`);

    // Allow extra time for draining active turns on restart.
    void (async () => {
      let restartPreparation: GatewayRestartPreparation<TPrepared> | undefined;
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

      const forceExitMs = isRestart ? DRAIN_TIMEOUT_MS + SHUTDOWN_TIMEOUT_MS : SHUTDOWN_TIMEOUT_MS;
      const forceExitTimer = setTimeout(() => {
        gatewayLog.error("shutdown timed out; exiting without full cleanup");
        // Exit non-zero on restart timeout so launchd/systemd treats it as a
        // failure and triggers a clean process restart instead of assuming the
        // shutdown was intentional. Stop-timeout stays at 0 (graceful). (#36822)
        exitProcess(isRestart ? 1 : 0);
      }, forceExitMs);

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

        if (restartPreparation) {
          try {
            // Re-read config after draining and immediately before close. This
            // rejects a staged context made stale during the preflight window.
            await restartPreparation.validate();
          } catch (err) {
            // The old listener and any timed-out active tasks are still alive.
            // Re-open ingress without clearing their lane bookkeeping.
            cancelGatewayDraining();
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
        clearTimeout(forceExitTimer);
        if (shuttingDown) {
          server = null;
          if (isRestart) {
            await handleRestartAfterServerClose();
          } else {
            await handleStopAfterServerClose();
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
