import type { ChannelId } from "../channels/plugins/types.js";

export type ChannelHealthSnapshot = {
  running?: boolean;
  connected?: boolean;
  enabled?: boolean;
  configured?: boolean;
  restartPending?: boolean;
  busy?: boolean;
  activeRuns?: number;
  lastRunActivityAt?: number | null;
  lastTransportActivityAt?: number | null;
  lastEventAt?: number | null;
  transportActivity?: {
    mode?: string;
    active?: boolean;
    inFlight?: number;
    lastStartedAt?: number | null;
    lastCompletedAt?: number | null;
    lastOutcome?: string | null;
    lastError?: string | null;
    watchdog?: {
      escalation?: string | null;
    };
  };
  lastStartAt?: number | null;
  reconnectAttempts?: number;
  mode?: string;
  lastPollCompletedAt?: number | null;
  lastPollSuccessAt?: number | null;
  lastPollOutcome?: string | null;
  telegramRecovery?: {
    phase: "provider-restart" | "gateway-restart-requested" | "exhausted";
    providerRestartAttempts: number;
    reason?: string | null;
    updatedAt: number;
  };
};

export type ChannelHealthEvaluationReason =
  | "healthy"
  | "unmanaged"
  | "not-running"
  | "busy"
  | "stuck"
  | "startup-connect-grace"
  | "disconnected"
  | "stale-socket";

export type ChannelHealthEvaluation = {
  healthy: boolean;
  reason: ChannelHealthEvaluationReason;
};

export type ChannelHealthPolicy = {
  channelId: ChannelId;
  now: number;
  staleEventThresholdMs: number;
  channelConnectGraceMs: number;
  telegramPollingProofFreshnessMs?: number;
};

export type ChannelRestartReason =
  | "gave-up"
  | "stopped"
  | "stale-socket"
  | "stuck"
  | "disconnected";

function isManagedAccount(snapshot: ChannelHealthSnapshot): boolean {
  return snapshot.enabled !== false && snapshot.configured !== false;
}

const BUSY_ACTIVITY_STALE_THRESHOLD_MS = 25 * 60_000;
// Keep these shared between the background health monitor and on-demand readiness
// probes so both surfaces evaluate channel lifecycle windows consistently.
export const DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS = 30 * 60_000;
export const DEFAULT_CHANNEL_CONNECT_GRACE_MS = 120_000;
// Telegram's polling watchdog uses a 90s stall boundary. Recovery proof gets
// one additional boundary of tolerance without accepting a 30-minute-old poll.
export const DEFAULT_TELEGRAM_POLLING_PROOF_FRESHNESS_MS = 180_000;

/**
 * A generic connected/listening flag cannot prove Telegram long-poll health.
 * Recovery is cleared only by a successful getUpdates completion after the
 * incident began and within the dedicated polling-proof freshness window.
 */
export function hasRecentTelegramPollingProof(
  snapshot: ChannelHealthSnapshot,
  policy: Pick<ChannelHealthPolicy, "now" | "telegramPollingProofFreshnessMs">,
): boolean {
  // lastPollOutcome is intentionally not part of recovery proof. A healthy
  // long-poller begins the next request immediately, changing that diagnostic
  // to `in-flight` while the previous successful completion remains valid.
  const successAt = snapshot.lastPollSuccessAt;
  if (typeof successAt !== "number" || !Number.isFinite(successAt)) {
    return false;
  }
  if (snapshot.telegramRecovery && successAt <= snapshot.telegramRecovery.updatedAt) {
    return false;
  }
  const age = policy.now - successAt;
  const freshnessMs =
    typeof policy.telegramPollingProofFreshnessMs === "number"
      ? policy.telegramPollingProofFreshnessMs
      : DEFAULT_TELEGRAM_POLLING_PROOF_FRESHNESS_MS;
  return age >= 0 && age <= freshnessMs;
}

export function evaluateChannelHealth(
  snapshot: ChannelHealthSnapshot,
  policy: ChannelHealthPolicy,
): ChannelHealthEvaluation {
  if (!isManagedAccount(snapshot)) {
    return { healthy: true, reason: "unmanaged" };
  }
  if (!snapshot.running) {
    return { healthy: false, reason: "not-running" };
  }
  const activeRuns =
    typeof snapshot.activeRuns === "number" && Number.isFinite(snapshot.activeRuns)
      ? Math.max(0, Math.trunc(snapshot.activeRuns))
      : 0;
  const isBusy = snapshot.busy === true || activeRuns > 0;
  const lastStartAt =
    typeof snapshot.lastStartAt === "number" && Number.isFinite(snapshot.lastStartAt)
      ? snapshot.lastStartAt
      : null;
  const lastRunActivityAt =
    typeof snapshot.lastRunActivityAt === "number" && Number.isFinite(snapshot.lastRunActivityAt)
      ? snapshot.lastRunActivityAt
      : null;
  const busyStateInitializedForLifecycle =
    lastStartAt == null || (lastRunActivityAt != null && lastRunActivityAt >= lastStartAt);

  // Runtime snapshots are patch-merged, so a restarted lifecycle can temporarily
  // inherit stale busy fields from the previous instance. Ignore busy short-circuit
  // until run activity is known to belong to the current lifecycle.
  if (isBusy) {
    if (!busyStateInitializedForLifecycle) {
      // Fall through to normal startup/disconnect checks below.
    } else {
      const runActivityAge =
        lastRunActivityAt == null
          ? Number.POSITIVE_INFINITY
          : Math.max(0, policy.now - lastRunActivityAt);
      if (runActivityAge < BUSY_ACTIVITY_STALE_THRESHOLD_MS) {
        return { healthy: true, reason: "busy" };
      }
      return { healthy: false, reason: "stuck" };
    }
  }

  const hasExplicitTelegramPollingFailure =
    policy.channelId === "telegram" &&
    snapshot.mode === "polling" &&
    (snapshot.lastPollOutcome === "stalled" ||
      snapshot.lastPollOutcome === "unhealthy" ||
      Boolean(snapshot.transportActivity?.watchdog?.escalation));
  if (hasExplicitTelegramPollingFailure) {
    // Polling sessions may internally rebuild after a stall and refresh
    // lastStartAt. Once the poller itself reports an authoritative failure,
    // that lifecycle churn is not genuine provider startup and must not renew
    // connect grace forever. Keep `started` and `in-flight` outside this set so
    // a newly launched provider still receives the normal startup window.
    return { healthy: false, reason: "stuck" };
  }

  if (snapshot.lastStartAt != null) {
    const upDuration = policy.now - snapshot.lastStartAt;
    if (upDuration < policy.channelConnectGraceMs) {
      return { healthy: true, reason: "startup-connect-grace" };
    }
  }
  if (snapshot.connected === false) {
    return { healthy: false, reason: "disconnected" };
  }
  if (policy.channelId === "telegram" && snapshot.mode === "polling" && snapshot.telegramRecovery) {
    return hasRecentTelegramPollingProof(snapshot, policy)
      ? { healthy: true, reason: "healthy" }
      : { healthy: false, reason: "stuck" };
  }
  // Skip stale-socket check for Telegram (long-polling mode) and any channel
  // explicitly operating in webhook mode. In these cases, there is no persistent
  // outgoing socket that can go half-dead, so the lack of incoming events
  // does not necessarily indicate a connection failure.
  if (
    policy.channelId !== "telegram" &&
    snapshot.mode !== "webhook" &&
    snapshot.connected === true &&
    snapshot.lastEventAt != null
  ) {
    if (lastStartAt != null && snapshot.lastEventAt < lastStartAt) {
      const lifecycleEventGap = Math.max(0, policy.now - lastStartAt);
      if (lifecycleEventGap <= policy.staleEventThresholdMs) {
        return { healthy: true, reason: "healthy" };
      }
      return { healthy: false, reason: "stale-socket" };
    }
    const eventAge = policy.now - snapshot.lastEventAt;
    if (eventAge > policy.staleEventThresholdMs) {
      return { healthy: false, reason: "stale-socket" };
    }
  }
  return { healthy: true, reason: "healthy" };
}

export function resolveChannelRestartReason(
  snapshot: ChannelHealthSnapshot,
  evaluation: ChannelHealthEvaluation,
): ChannelRestartReason {
  if (evaluation.reason === "stale-socket") {
    return "stale-socket";
  }
  if (evaluation.reason === "not-running") {
    return snapshot.reconnectAttempts && snapshot.reconnectAttempts >= 10 ? "gave-up" : "stopped";
  }
  if (evaluation.reason === "disconnected") {
    return "disconnected";
  }
  return "stuck";
}
