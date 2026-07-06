import { isTerminalMonitorStatus, type MonitorEventEnvelope, type MonitorRecord } from "./types.js";

export type MonitorEventRoute = {
  monitorId: string;
  cronJobId: string;
  monitorSessionKey: string;
  originSessionKey: string;
  originDelivery?: MonitorRecord["originDelivery"];
  wakeReason: string;
};

function normalizeString(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function normalizeComparable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeComparable(entry));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .toSorted()
        .map((key) => [key, normalizeComparable(record[key])]),
    );
  }
  return value;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizeComparable(left)) === JSON.stringify(normalizeComparable(right));
}

function readPath(record: Record<string, unknown>, path: string): unknown {
  const parts = path
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
  let cursor: unknown = record;
  for (const part of parts) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function targetContainsExpected(
  eventTarget: Record<string, unknown>,
  expectedTarget: Record<string, unknown>,
): boolean {
  for (const key of Object.keys(expectedTarget)) {
    const expected = expectedTarget[key];
    if (!valuesEqual(readPath(eventTarget, key), expected)) {
      return false;
    }
  }
  return true;
}

function hasStringPath(record: Record<string, unknown>, path: string): boolean {
  const value = readPath(record, path);
  return typeof value === "string" && value.trim().length > 0;
}

function hasStringOrNumberPath(record: Record<string, unknown>, path: string): boolean {
  const value = readPath(record, path);
  return (
    (typeof value === "string" && value.trim().length > 0) ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function triggerSourceTargetIsAuthoritative(params: {
  sourceType: string;
  sourceTarget: Record<string, unknown>;
}): boolean {
  // A trigger sourceTarget can be a coarse prefilter or a canonical route key.
  // For Gmail, account + thread is the durable conversation boundary; account
  // or thread alone still needs the stored monitor sourceTarget fallback.
  if (normalizeString(params.sourceType) === "gmail") {
    const hasAccount =
      hasStringPath(params.sourceTarget, "account") ||
      hasStringPath(params.sourceTarget, "accountId") ||
      hasStringPath(params.sourceTarget, "emailAddress");
    const hasThread =
      hasStringPath(params.sourceTarget, "threadId") ||
      hasStringPath(params.sourceTarget, "gmailThreadId");
    return hasAccount && hasThread;
  }
  if (normalizeString(params.sourceType) === "telegram-user") {
    return (
      hasStringOrNumberPath(params.sourceTarget, "chat") ||
      hasStringOrNumberPath(params.sourceTarget, "chatId") ||
      hasStringOrNumberPath(params.sourceTarget, "target") ||
      hasStringOrNumberPath(params.sourceTarget, "to")
    );
  }
  return false;
}

function selectedTargetKeysMatch(params: {
  monitor: MonitorRecord;
  event: MonitorEventEnvelope;
  matchKeys: string[];
}): boolean {
  // The router is intentionally cheap and deterministic: dotted key paths are
  // compared against stored monitor metadata, and missing values are not a match.
  for (const key of params.matchKeys) {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      continue;
    }
    const expected = readPath(params.monitor.sourceTarget, normalizedKey);
    if (expected === undefined) {
      return false;
    }
    if (!valuesEqual(readPath(params.event.sourceTarget, normalizedKey), expected)) {
      return false;
    }
  }
  return true;
}

function eventTypeMatches(event: MonitorEventEnvelope, eventTypes: string[] | undefined): boolean {
  if (!eventTypes?.length) {
    return true;
  }
  const eventType = normalizeString(event.eventType);
  if (!eventType) {
    return false;
  }
  return eventTypes.some((candidate) => normalizeString(candidate) === eventType);
}

function monitorTriggerMatches(monitor: MonitorRecord, event: MonitorEventEnvelope): boolean {
  const trigger = monitor.trigger;

  if (!trigger) {
    // Backward compatibility for old monitor store records: an explicit event can
    // still wake a legacy monitor if it matches the stored watched source exactly.
    return (
      normalizeString(monitor.sourceType) === normalizeString(event.sourceType) &&
      targetContainsExpected(event.sourceTarget, monitor.sourceTarget)
    );
  }

  if (trigger.kind === "schedule") {
    return false;
  }

  const eventTrigger = trigger.kind === "hybrid" ? trigger.event : trigger;
  if (eventTrigger.kind !== event.triggerKind) {
    return false;
  }

  const match = eventTrigger.match;
  const expectedSourceType = match?.sourceType ?? monitor.sourceType;
  if (normalizeString(expectedSourceType) !== normalizeString(event.sourceType)) {
    return false;
  }
  if (!eventTypeMatches(event, match?.eventTypes)) {
    return false;
  }
  if (match?.sourceTarget) {
    if (!targetContainsExpected(event.sourceTarget, match.sourceTarget)) {
      return false;
    }
    if (
      !match.matchKeys?.length &&
      triggerSourceTargetIsAuthoritative({
        sourceType: expectedSourceType,
        sourceTarget: match.sourceTarget,
      })
    ) {
      return true;
    }
  }
  if (match?.matchKeys?.length) {
    return selectedTargetKeysMatch({ monitor, event, matchKeys: match.matchKeys });
  }
  return targetContainsExpected(event.sourceTarget, monitor.sourceTarget);
}

export function routeMonitorEvent(params: {
  monitors: MonitorRecord[];
  event: MonitorEventEnvelope;
}): MonitorEventRoute[] {
  return params.monitors
    .filter((monitor) => {
      if (!(monitor.status === "active" || monitor.status === "degraded")) {
        return false;
      }
      if (isTerminalMonitorStatus(monitor.status)) {
        return false;
      }
      return monitorTriggerMatches(monitor, params.event);
    })
    .map((monitor) => ({
      monitorId: monitor.monitorId,
      cronJobId: monitor.cronJobId,
      monitorSessionKey: monitor.monitorSessionKey,
      originSessionKey: monitor.originSessionKey,
      ...(monitor.originDelivery ? { originDelivery: monitor.originDelivery } : {}),
      wakeReason: `monitor-event:${params.event.triggerKind}:${monitor.monitorId}`,
    }));
}
