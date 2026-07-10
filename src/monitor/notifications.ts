import type {
  MonitorNotificationEvent,
  MonitorNotificationPolicy,
  MonitorNotificationState,
} from "./types.js";

export const DEFAULT_MONITOR_NOTIFICATION_POLICY: MonitorNotificationPolicy = {
  mode: "change_aware",
  unchangedNoticeAfterChecks: 3,
  unchangedReminderIntervalMs: 12 * 60 * 60 * 1000,
};

function normalizePositiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function resolveMonitorNotificationPolicy(
  policy: MonitorNotificationPolicy | undefined,
): MonitorNotificationPolicy {
  return {
    mode: "change_aware",
    unchangedNoticeAfterChecks: normalizePositiveInteger(
      policy?.unchangedNoticeAfterChecks ?? 0,
      DEFAULT_MONITOR_NOTIFICATION_POLICY.unchangedNoticeAfterChecks,
    ),
    unchangedReminderIntervalMs: normalizePositiveInteger(
      policy?.unchangedReminderIntervalMs ?? 0,
      DEFAULT_MONITOR_NOTIFICATION_POLICY.unchangedReminderIntervalMs,
    ),
  };
}

export type MonitorNotificationDecision = {
  shouldNotify: boolean;
  reason:
    | "suppressed_unchanged"
    | "unchanged_milestone"
    | "immediate_event"
    | "deadline_escalation";
  nextAction?: "escalate_within_scope" | "request_approval";
  state: MonitorNotificationState;
};

export function applyMonitorNotificationEvent(params: {
  policy?: MonitorNotificationPolicy;
  state?: MonitorNotificationState;
  event: MonitorNotificationEvent;
  nowMs: number;
  actionCapability?: "observe_only" | "act_within_scope";
}): MonitorNotificationDecision {
  const policy = resolveMonitorNotificationPolicy(params.policy);
  const previous = params.state;
  const nowMs = Math.max(0, Math.floor(params.nowMs));

  if (params.event === "deadline_passed") {
    // A missed SLA is an action decision, never another generic no-change tick.
    // The gateway derives capability from the bound goal rather than delivery policy.
    return {
      shouldNotify: true,
      reason: "deadline_escalation",
      nextAction:
        params.actionCapability === "act_within_scope"
          ? "escalate_within_scope"
          : "request_approval",
      state: {
        consecutiveUnchangedChecks: Math.max(0, previous?.consecutiveUnchangedChecks ?? 0),
        lastEvent: "deadline_passed",
        lastEventAtMs: nowMs,
        lastNotificationAtMs: nowMs,
        ...(previous?.lastMaterialChangeAtMs !== undefined
          ? { lastMaterialChangeAtMs: previous.lastMaterialChangeAtMs }
          : {}),
      },
    };
  }

  if (params.event !== "unchanged") {
    // Immediate events bypass quiet-tick throttling. A real state transition
    // starts a new unchanged sequence; degradation alone keeps its baseline.
    const resetsUnchanged = params.event === "material_change" || params.event === "completion";
    return {
      shouldNotify: true,
      reason: "immediate_event",
      state: {
        consecutiveUnchangedChecks: resetsUnchanged
          ? 0
          : Math.max(0, previous?.consecutiveUnchangedChecks ?? 0),
        lastEvent: params.event,
        lastEventAtMs: nowMs,
        lastNotificationAtMs: nowMs,
        ...(resetsUnchanged ? { lastMaterialChangeAtMs: nowMs } : {}),
      },
    };
  }

  // The exact count stops mattering after the first notice threshold. Keep the
  // persisted state bounded while preserving the later-reminder distinction.
  const consecutiveUnchangedChecks = Math.min(
    Math.max(0, previous?.consecutiveUnchangedChecks ?? 0) + 1,
    policy.unchangedNoticeAfterChecks + 1,
  );
  const reachedFirstNotice = consecutiveUnchangedChecks === policy.unchangedNoticeAfterChecks;
  const reminderDue =
    consecutiveUnchangedChecks > policy.unchangedNoticeAfterChecks &&
    (previous?.lastNotificationAtMs === undefined ||
      nowMs - previous.lastNotificationAtMs >= policy.unchangedReminderIntervalMs);
  const shouldNotify = reachedFirstNotice || reminderDue;
  return {
    shouldNotify,
    reason: shouldNotify ? "unchanged_milestone" : "suppressed_unchanged",
    state: {
      consecutiveUnchangedChecks,
      lastEvent: "unchanged",
      lastEventAtMs: nowMs,
      ...(previous?.lastMaterialChangeAtMs !== undefined
        ? { lastMaterialChangeAtMs: previous.lastMaterialChangeAtMs }
        : {}),
      ...(shouldNotify
        ? { lastNotificationAtMs: nowMs }
        : previous?.lastNotificationAtMs !== undefined
          ? { lastNotificationAtMs: previous.lastNotificationAtMs }
          : {}),
    },
  };
}
