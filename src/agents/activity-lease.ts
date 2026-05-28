const DEFAULT_ACTIVITY_LEASE_MAX_MULTIPLIER = 5;

function normalizePositiveMs(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

export type AgentActivityLease = {
  readonly startedAtMs: number;
  readonly idleTimeoutMs: number;
  readonly maxWallClockMs: number;
  touch: (nowMs?: number) => void;
  nextDelayMs: (nowMs?: number) => number;
};

export function resolveAgentActivityLeaseMaxWallClockMs(params: {
  timeoutMs: number;
  maxWallClockMs?: number;
}): number {
  const timeoutMs = normalizePositiveMs(params.timeoutMs) ?? 1;
  const configured = normalizePositiveMs(params.maxWallClockMs);
  if (configured !== undefined) {
    return Math.max(timeoutMs, configured);
  }
  return timeoutMs * DEFAULT_ACTIVITY_LEASE_MAX_MULTIPLIER;
}

export function createAgentActivityLease(params: {
  timeoutMs: number;
  maxWallClockMs?: number;
  nowMs?: number;
}): AgentActivityLease {
  const startedAtMs = params.nowMs ?? Date.now();
  const idleTimeoutMs = normalizePositiveMs(params.timeoutMs) ?? 1;
  const maxWallClockMs = resolveAgentActivityLeaseMaxWallClockMs({
    timeoutMs: idleTimeoutMs,
    maxWallClockMs: params.maxWallClockMs,
  });
  let lastActivityAtMs = startedAtMs;

  return {
    startedAtMs,
    idleTimeoutMs,
    maxWallClockMs,
    touch: (nowMs = Date.now()) => {
      // Activity can arrive from async callbacks in quick succession. Keep the
      // lease monotonic so a delayed callback cannot shorten a fresher renewal.
      lastActivityAtMs = Math.max(lastActivityAtMs, nowMs);
    },
    nextDelayMs: (nowMs = Date.now()) => {
      const idleDeadlineMs = lastActivityAtMs + idleTimeoutMs;
      const hardDeadlineMs = startedAtMs + maxWallClockMs;
      return Math.max(0, Math.min(idleDeadlineMs, hardDeadlineMs) - nowMs);
    },
  };
}
