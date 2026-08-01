import type { ChannelId } from "../channels/plugins/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  DEFAULT_CHANNEL_CONNECT_GRACE_MS,
  DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
  DEFAULT_TELEGRAM_POLLING_PROOF_FRESHNESS_MS,
  evaluateChannelHealth,
  hasRecentTelegramPollingProof,
  resolveChannelRestartReason,
  type ChannelHealthPolicy,
} from "./channel-health-policy.js";
import type { ChannelManager } from "./server-channels.js";
import {
  createTelegramRecoveryStateStore,
  type TelegramRecoveryIncident,
  type TelegramRecoveryStateStore,
} from "./telegram-recovery-state.js";

const log = createSubsystemLogger("gateway/health-monitor");

const DEFAULT_CHECK_INTERVAL_MS = 5 * 60_000;
const DEFAULT_MONITOR_STARTUP_GRACE_MS = 60_000;
const DEFAULT_COOLDOWN_CYCLES = 2;
const DEFAULT_MAX_RESTARTS_PER_HOUR = 10;
const DEFAULT_RESTART_STOP_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_TELEGRAM_PROVIDER_RESTARTS = 2;
const DEFAULT_GATEWAY_RESTART_VERIFICATION_TIMEOUT_MS = 60_000;
const ONE_HOUR_MS = 60 * 60_000;

/**
 * How long a connected channel can go without receiving any event before
 * the health monitor treats it as a "stale socket" and triggers a restart.
 * This catches the half-dead WebSocket scenario where the connection appears
 * alive (health checks pass) but Slack silently stops delivering events.
 */
export type ChannelHealthTimingPolicy = {
  monitorStartupGraceMs: number;
  channelConnectGraceMs: number;
  staleEventThresholdMs: number;
  telegramPollingProofFreshnessMs: number;
};

export type GatewayRestartRequestResult = { ok: boolean };

export type ChannelHealthMonitorDeps = {
  channelManager: ChannelManager;
  checkIntervalMs?: number;
  /** @deprecated use timing.monitorStartupGraceMs */
  startupGraceMs?: number;
  /** @deprecated use timing.channelConnectGraceMs */
  channelStartupGraceMs?: number;
  /** @deprecated use timing.staleEventThresholdMs */
  staleEventThresholdMs?: number;
  timing?: Partial<ChannelHealthTimingPolicy>;
  cooldownCycles?: number;
  maxRestartsPerHour?: number;
  /** Provider restarts allowed before one process-level Telegram escalation. */
  maxTelegramProviderRestarts?: number;
  restartStopTimeoutMs?: number;
  /** Time the old process may remain alive after accepting a gateway restart request. */
  gatewayRestartVerificationTimeoutMs?: number;
  requestGatewayRestart?: (
    reason: string,
  ) => void | GatewayRestartRequestResult | Promise<void | GatewayRestartRequestResult>;
  telegramRecoveryStore?: TelegramRecoveryStateStore;
  abortSignal?: AbortSignal;
};

export type ChannelHealthMonitor = {
  stop: () => void;
};

type RestartRecord = {
  lastRestartAt: number;
  restartsThisHour: { at: number }[];
};

function resolveTimingPolicy(
  deps: Pick<
    ChannelHealthMonitorDeps,
    "startupGraceMs" | "channelStartupGraceMs" | "staleEventThresholdMs" | "timing"
  >,
): ChannelHealthTimingPolicy {
  return {
    monitorStartupGraceMs:
      deps.timing?.monitorStartupGraceMs ?? deps.startupGraceMs ?? DEFAULT_MONITOR_STARTUP_GRACE_MS,
    channelConnectGraceMs:
      deps.timing?.channelConnectGraceMs ??
      deps.channelStartupGraceMs ??
      DEFAULT_CHANNEL_CONNECT_GRACE_MS,
    staleEventThresholdMs:
      deps.timing?.staleEventThresholdMs ??
      deps.staleEventThresholdMs ??
      DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
    telegramPollingProofFreshnessMs:
      deps.timing?.telegramPollingProofFreshnessMs ?? DEFAULT_TELEGRAM_POLLING_PROOF_FRESHNESS_MS,
  };
}

export function startChannelHealthMonitor(deps: ChannelHealthMonitorDeps): ChannelHealthMonitor {
  const {
    channelManager,
    checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
    cooldownCycles = DEFAULT_COOLDOWN_CYCLES,
    maxRestartsPerHour = DEFAULT_MAX_RESTARTS_PER_HOUR,
    maxTelegramProviderRestarts = DEFAULT_MAX_TELEGRAM_PROVIDER_RESTARTS,
    restartStopTimeoutMs = DEFAULT_RESTART_STOP_TIMEOUT_MS,
    gatewayRestartVerificationTimeoutMs = DEFAULT_GATEWAY_RESTART_VERIFICATION_TIMEOUT_MS,
    requestGatewayRestart,
    telegramRecoveryStore = createTelegramRecoveryStateStore(),
    abortSignal,
  } = deps;
  const timing = resolveTimingPolicy(deps);

  const cooldownMs = cooldownCycles * checkIntervalMs;
  const restartRecords = new Map<string, RestartRecord>();
  const startedAt = Date.now();
  let stopped = false;
  let checkInFlight = false;
  // A stop timeout means the old channel task may still be alive. From that
  // point on, the only safe recovery is a process restart; starting any channel
  // in the same process risks duplicate long-pollers for shared credentials.
  let gatewayRestartRequested = false;
  let gatewayRestartVerificationTimer: ReturnType<typeof setTimeout> | null = null;
  let telegramRecoveryHydrated = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const rKey = (channelId: string, accountId: string) => `${channelId}:${accountId}`;

  function pruneOldRestarts(record: RestartRecord, now: number) {
    record.restartsThisHour = record.restartsThisHour.filter((r) => now - r.at < ONE_HOUR_MS);
  }

  async function patchTelegramRecovery(
    accountId: string,
    phase: "provider-restart" | "gateway-restart-requested" | "exhausted",
    providerRestartAttempts: number,
    reason: string,
    now: number,
  ): Promise<boolean> {
    const incident: TelegramRecoveryIncident = {
      phase,
      providerRestartAttempts,
      reason,
      updatedAt: now,
    };
    try {
      // Persistence owns restart authority. Publish it before touching provider
      // lifecycle so a gateway replacement cannot reset an already-spent budget.
      await telegramRecoveryStore.set(accountId, incident);
    } catch (err) {
      log.error?.(
        `[telegram:${accountId}] health-monitor: durable recovery write failed; automatic recovery disabled (${String(err)})`,
      );
      channelManager.patchChannelStatus("telegram", accountId, {
        telegramRecovery: {
          phase: "exhausted",
          providerRestartAttempts,
          reason: `${reason}; durable recovery state unavailable`,
          updatedAt: now,
        },
      });
      return false;
    }
    channelManager.patchChannelStatus("telegram", accountId, {
      telegramRecovery: incident,
    });
    return true;
  }

  async function clearTelegramRecovery(accountId: string): Promise<boolean> {
    try {
      // Delete the durable authority first. If deletion fails, retaining the
      // in-memory incident safely retries cleanup on the next fresh poll proof.
      await telegramRecoveryStore.clear(accountId);
    } catch (err) {
      log.error?.(
        `[telegram:${accountId}] health-monitor: durable recovery cleanup failed (${String(err)})`,
      );
      return false;
    }
    channelManager.patchChannelStatus("telegram", accountId, {
      telegramRecovery: undefined,
    });
    return true;
  }

  async function hydrateTelegramRecovery(
    snapshot: ReturnType<ChannelManager["getRuntimeSnapshot"]>,
    now: number,
  ): Promise<boolean> {
    if (telegramRecoveryHydrated) {
      return false;
    }
    telegramRecoveryHydrated = true;

    let loaded;
    try {
      loaded = await telegramRecoveryStore.load(now);
    } catch (err) {
      log.error?.(`health-monitor: durable Telegram recovery load failed (${String(err)})`);
      loaded = {
        incidents: new Map<string, TelegramRecoveryIncident>(),
        hasUnattributedCorruption: true,
      };
    }

    let changed = false;
    const telegramAccounts = snapshot.channelAccounts.telegram ?? {};
    for (const [accountId, incident] of loaded.incidents) {
      const current = telegramAccounts[accountId]?.telegramRecovery;
      // Hot reload keeps the ChannelManager. Do not replace its richer reason or
      // a newer transition with the secret-free durable projection.
      if (current && current.updatedAt >= incident.updatedAt) {
        continue;
      }
      channelManager.patchChannelStatus("telegram", accountId, { telegramRecovery: incident });
      changed = true;
    }

    if (loaded.hasUnattributedCorruption) {
      for (const [accountId, status] of Object.entries(telegramAccounts)) {
        if (status?.mode !== "polling" || status.telegramRecovery) {
          continue;
        }
        const incident: TelegramRecoveryIncident = {
          phase: "exhausted",
          providerRestartAttempts: 0,
          reason: "Telegram recovery state was unreadable; manual intervention required",
          updatedAt: now,
        };
        // Best effort repairs the account-keyed authority. Even if storage is
        // unavailable, the current lifecycle remains terminal rather than looping.
        await telegramRecoveryStore.set(accountId, incident).catch(() => undefined);
        channelManager.patchChannelStatus("telegram", accountId, { telegramRecovery: incident });
        changed = true;
      }
    }
    return changed;
  }

  function scheduleTelegramGatewayRestartVerification(params: {
    accountId: string;
    providerRestartAttempts: number;
    reason: string;
    requestedAt: number;
  }) {
    // A config reload creates a replacement monitor with no in-memory timer.
    // Rebuild the verification deadline from the durable incident timestamp so
    // reloads cannot leave recovery permanently latched or extend its window.
    gatewayRestartRequested = true;
    if (gatewayRestartVerificationTimer) {
      clearTimeout(gatewayRestartVerificationTimer);
    }
    const deadline = params.requestedAt + Math.max(0, gatewayRestartVerificationTimeoutMs);
    gatewayRestartVerificationTimer = setTimeout(
      () => {
        void (async () => {
          if (stopped) {
            return;
          }

          const now = Date.now();
          const status =
            channelManager.getRuntimeSnapshot().channelAccounts.telegram?.[params.accountId];
          const healthPolicy: Pick<ChannelHealthPolicy, "now" | "telegramPollingProofFreshnessMs"> =
            {
              now,
              telegramPollingProofFreshnessMs: timing.telegramPollingProofFreshnessMs,
            };

          // The old PID surviving does not prove failure when the poller has
          // already completed a fresh getUpdates call after this incident.
          if (status && hasRecentTelegramPollingProof(status, healthPolicy)) {
            await clearTelegramRecovery(params.accountId);
          } else {
            await patchTelegramRecovery(
              params.accountId,
              "exhausted",
              params.providerRestartAttempts,
              `${params.reason}; gateway restart could not be verified`,
              now,
            );
          }
          gatewayRestartRequested = false;
          gatewayRestartVerificationTimer = null;
        })().catch((err) => {
          log.error?.(
            `[telegram:${params.accountId}] health-monitor: restart verification failed (${String(err)})`,
          );
          gatewayRestartRequested = false;
          gatewayRestartVerificationTimer = null;
        });
      },
      Math.max(0, deadline - Date.now()),
    );
    gatewayRestartVerificationTimer.unref?.();
  }

  async function requestTelegramGatewayRestart(params: {
    accountId: string;
    providerRestartAttempts: number;
    reason: string;
    now: number;
  }): Promise<boolean> {
    if (!requestGatewayRestart) {
      await patchTelegramRecovery(
        params.accountId,
        "exhausted",
        params.providerRestartAttempts,
        `${params.reason}; gateway restart unavailable`,
        params.now,
      );
      return false;
    }

    const persisted = await patchTelegramRecovery(
      params.accountId,
      "gateway-restart-requested",
      params.providerRestartAttempts,
      params.reason,
      params.now,
    );
    if (!persisted) {
      return false;
    }

    try {
      // Invoke only after the durable record exists: restart implementations may
      // synchronously tear down this server and recreate its ChannelManager.
      const result = await requestGatewayRestart(params.reason);
      // `undefined` remains accepted for legacy callbacks. New callers can
      // return `{ok:false}` so failure becomes visible instead of optimistic.
      if (result && !result.ok) {
        await patchTelegramRecovery(
          params.accountId,
          "exhausted",
          params.providerRestartAttempts,
          `${params.reason}; gateway restart rejected`,
          params.now,
        );
        return false;
      }
      // An accepted restart request is still unverified. A successful external
      // restart ends this process before the timer can fire; survival past the
      // deadline is the bounded evidence that automatic recovery could not be
      // proven. Transition to terminal/manual authority without requesting a
      // second restart and creating a storm.
      scheduleTelegramGatewayRestartVerification({
        ...params,
        requestedAt: params.now,
      });
      return true;
    } catch (err) {
      await patchTelegramRecovery(
        params.accountId,
        "exhausted",
        params.providerRestartAttempts,
        `${params.reason}; gateway restart failed: ${String(err)}`,
        params.now,
      );
      return false;
    }
  }

  async function stopChannelWithTimeout(
    channelId: ChannelId,
    accountId: string,
  ): Promise<"stopped" | "timed-out"> {
    const stopPromise = channelManager
      .stopChannel(channelId, accountId)
      .then(() => "stopped" as const);
    void stopPromise.catch(() => {
      // The caller awaits the same promise while it is racing the timeout. If
      // the timeout wins first, keep a rejection from becoming unhandled while
      // the process is on its way to a full gateway restart.
    });

    if (restartStopTimeoutMs <= 0) {
      return await stopPromise;
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        stopPromise,
        new Promise<"timed-out">((resolve) => {
          timeout = setTimeout(() => resolve("timed-out"), restartStopTimeoutMs);
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  async function runCheck() {
    if (stopped || checkInFlight || gatewayRestartRequested) {
      return;
    }
    checkInFlight = true;

    try {
      const now = Date.now();
      if (now - startedAt < timing.monitorStartupGraceMs) {
        return;
      }

      let snapshot = channelManager.getRuntimeSnapshot();
      if (await hydrateTelegramRecovery(snapshot, now)) {
        snapshot = channelManager.getRuntimeSnapshot();
      }

      for (const [channelId, accounts] of Object.entries(snapshot.channelAccounts)) {
        if (!accounts) {
          continue;
        }
        for (const [accountId, status] of Object.entries(accounts)) {
          if (!status) {
            continue;
          }
          if (!channelManager.isHealthMonitorEnabled(channelId as ChannelId, accountId)) {
            continue;
          }
          if (channelManager.isManuallyStopped(channelId as ChannelId, accountId)) {
            continue;
          }
          const healthPolicy: ChannelHealthPolicy = {
            channelId,
            now,
            staleEventThresholdMs: timing.staleEventThresholdMs,
            channelConnectGraceMs: timing.channelConnectGraceMs,
            telegramPollingProofFreshnessMs: timing.telegramPollingProofFreshnessMs,
          };
          const health = evaluateChannelHealth(status, healthPolicy);
          if (health.healthy) {
            if (
              channelId === "telegram" &&
              status.telegramRecovery &&
              hasRecentTelegramPollingProof(status, healthPolicy)
            ) {
              await clearTelegramRecovery(accountId);
            }
            continue;
          }

          const isTelegramPolling = channelId === "telegram" && status.mode === "polling";
          const providerRestartAttempts = status.telegramRecovery?.providerRestartAttempts ?? 0;
          if (isTelegramPolling && status.telegramRecovery?.phase === "exhausted") {
            // Exhaustion is terminal for this incident. Only fresh provider
            // polling proof above can clear it; duplicate checks do no work.
            continue;
          }
          if (isTelegramPolling && status.telegramRecovery?.phase === "gateway-restart-requested") {
            // Recovery state outlives this monitor instance, while verification
            // timers do not. Re-arm the original bounded deadline after config
            // hot reload without sending a duplicate gateway restart request.
            scheduleTelegramGatewayRestartVerification({
              accountId,
              providerRestartAttempts,
              reason:
                status.telegramRecovery.reason ??
                `${channelId}:${accountId} gateway restart requested`,
              requestedAt: status.telegramRecovery.updatedAt,
            });
            return;
          }

          if (isTelegramPolling && providerRestartAttempts >= maxTelegramProviderRestarts) {
            const restartReason = `${channelId}:${accountId} remained unhealthy after ${providerRestartAttempts} provider restart attempt${providerRestartAttempts === 1 ? "" : "s"}`;
            await requestTelegramGatewayRestart({
              accountId,
              providerRestartAttempts,
              reason: restartReason,
              now,
            });
            return;
          }

          const key = rKey(channelId, accountId);
          const record = restartRecords.get(key) ?? {
            lastRestartAt: 0,
            restartsThisHour: [],
          };

          if (now - record.lastRestartAt <= cooldownMs) {
            continue;
          }

          pruneOldRestarts(record, now);
          if (record.restartsThisHour.length >= maxRestartsPerHour) {
            log.warn?.(
              `[${channelId}:${accountId}] health-monitor: hit ${maxRestartsPerHour} restarts/hour limit, skipping`,
            );
            if (isTelegramPolling) {
              await patchTelegramRecovery(
                accountId,
                "exhausted",
                providerRestartAttempts,
                `telegram:${accountId} provider restart rate limit exhausted`,
                now,
              );
            }
            continue;
          }

          const reason = resolveChannelRestartReason(status, health);

          log.info?.(`[${channelId}:${accountId}] health-monitor: restarting (reason: ${reason})`);

          try {
            const nextProviderRestartAttempts = isTelegramPolling
              ? providerRestartAttempts + 1
              : providerRestartAttempts;
            if (isTelegramPolling) {
              // Publish before stop: a hung stop is still an attempted provider
              // recovery and must never be followed by a duplicate poller.
              const persisted = await patchTelegramRecovery(
                accountId,
                "provider-restart",
                nextProviderRestartAttempts,
                reason,
                now,
              );
              if (!persisted) {
                continue;
              }
            }
            if (status.running) {
              const stopResult = await stopChannelWithTimeout(channelId as ChannelId, accountId);
              if (stopResult === "timed-out") {
                const restartReason = `${channelId}:${accountId} health-monitor stop timed out`;
                log.error?.(
                  `[${channelId}:${accountId}] health-monitor: stop timed out after ${Math.round(restartStopTimeoutMs / 1000)}s; requesting gateway restart`,
                );
                if (isTelegramPolling) {
                  await requestTelegramGatewayRestart({
                    accountId,
                    providerRestartAttempts: nextProviderRestartAttempts,
                    reason: restartReason,
                    now,
                  });
                } else {
                  gatewayRestartRequested = true;
                  await requestGatewayRestart?.(restartReason);
                }
                return;
              }
            }
            channelManager.resetRestartAttempts(channelId as ChannelId, accountId);
            await channelManager.startChannel(channelId as ChannelId, accountId);
            record.lastRestartAt = now;
            record.restartsThisHour.push({ at: now });
            restartRecords.set(key, record);
          } catch (err) {
            log.error?.(
              `[${channelId}:${accountId}] health-monitor: restart failed: ${String(err)}`,
            );
          }
        }
      }
    } finally {
      checkInFlight = false;
    }
  }

  function stop() {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (gatewayRestartVerificationTimer) {
      clearTimeout(gatewayRestartVerificationTimer);
      gatewayRestartVerificationTimer = null;
    }
  }

  if (abortSignal?.aborted) {
    stopped = true;
  } else {
    abortSignal?.addEventListener("abort", stop, { once: true });
    timer = setInterval(() => void runCheck(), checkIntervalMs);
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
    log.info?.(
      `started (interval: ${Math.round(checkIntervalMs / 1000)}s, startup-grace: ${Math.round(timing.monitorStartupGraceMs / 1000)}s, channel-connect-grace: ${Math.round(timing.channelConnectGraceMs / 1000)}s)`,
    );
  }

  return { stop };
}
