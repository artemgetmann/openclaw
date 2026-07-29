import type { SessionGoalAutonomy } from "../config/sessions/types.js";
import type { CronDelivery, CronSchedule } from "../cron/types.js";

export type MonitorStatus = "active" | "degraded" | "stopped" | "completed" | "expired";

// A completed monitor has satisfied its stop condition. It must stop waking
// instead of burning future cron turns on a task that already has evidence.
export function isTerminalMonitorStatus(status: MonitorStatus): boolean {
  return status === "stopped" || status === "expired" || status === "completed";
}

export type MonitorActionPolicy = "notify_draft" | "notify_only" | "auto_send";

export const CODEX_THREAD_UNARCHIVE_RESUME_ACTION = "codex.thread.unarchive_resume" as const;

export type MonitorAuthorityAction = {
  kind: typeof CODEX_THREAD_UNARCHIVE_RESUME_ACTION;
  /** Exact native thread covered by the grant. Wildcards are never accepted. */
  threadId: string;
  /** Exact bounded continuation prompt approved as part of the one-shot action. */
  prompt: string;
};

export type MonitorAuthorityAuditEvent = {
  event: "granted" | "revoked" | "consumed" | "completed" | "failed" | "denied";
  atMs: number;
  reason?: string;
};

export type MonitorAuthorityExecution = {
  status: "available" | "consumed" | "completed" | "failed";
  executions: number;
  consumedAtMs?: number;
  completedAtMs?: number;
  failedAtMs?: number;
  externalRef?: string;
  error?: string;
};

/**
 * A persisted grant is intentionally narrower than generic tool permission.
 * It authorizes one exact action against one exact target and is consumed
 * before the external mutation begins.
 */
export type MonitorAuthorityGrant = {
  schemaVersion: 1;
  grantId: string;
  goalId: string;
  purposeKey: string;
  action: MonitorAuthorityAction;
  idempotencyKey: string;
  expiresAt: string;
  stopCondition: string;
  maxExecutions: 1;
  grantedAtMs: number;
  revokedAtMs?: number;
  execution: MonitorAuthorityExecution;
  audit: MonitorAuthorityAuditEvent[];
};

export type MonitorAuthorityGrantInput = Pick<
  MonitorAuthorityGrant,
  "purposeKey" | "action" | "idempotencyKey" | "expiresAt" | "stopCondition"
>;

/**
 * Monitor instructions are replayed in every wake, so retain enough context
 * for a real task while keeping durable state and wake prompts bounded.
 */
export const MONITOR_INSTRUCTIONS_MAX_LENGTH = 16_000;

export type MonitorNotificationEvent =
  | "unchanged"
  | "material_change"
  | "completion"
  | "user_input"
  | "approval_required"
  | "deadline_passed"
  | "degraded";

export type MonitorNotificationPolicy = {
  mode: "change_aware";
  unchangedNoticeAfterChecks: number;
  unchangedReminderIntervalMs: number;
};

export type MonitorNotificationState = {
  consecutiveUnchangedChecks: number;
  lastEvent?: MonitorNotificationEvent;
  lastEventAtMs?: number;
  lastNotificationAtMs?: number;
  lastMaterialChangeAtMs?: number;
};

export type MonitorDisclosure = {
  purpose: string;
  source: { type: string; target: MonitorSourceTarget };
  checkCadence: CronSchedule;
  noChangeCadence: {
    noticeAfterChecks: number;
    reminderIntervalMs: number;
  };
  expiryAt: string | null;
  stopCondition: string | null;
  autonomy: SessionGoalAutonomy;
  actionPolicy: MonitorActionPolicy;
};

export type MonitorCheckpoint = Record<string, unknown>;

export type MonitorSourceTarget = Record<string, unknown>;

export type MonitorEventTriggerKind =
  | "webhook"
  | "local_listener"
  | "process_exit"
  | "browser_observer";

export type MonitorTriggerMatch = {
  sourceType?: string;
  sourceTarget?: MonitorSourceTarget;
  matchKeys?: string[];
  eventTypes?: string[];
};

export type MonitorTrigger =
  | {
      kind: "schedule";
      cadence?: CronSchedule;
    }
  | {
      kind: MonitorEventTriggerKind;
      match?: MonitorTriggerMatch;
    }
  | {
      kind: "hybrid";
      schedule?: { cadence?: CronSchedule };
      event: {
        kind: MonitorEventTriggerKind;
        match?: MonitorTriggerMatch;
      };
    };

export type MonitorEventEnvelope = {
  triggerKind: MonitorEventTriggerKind;
  sourceType: string;
  sourceTarget: MonitorSourceTarget;
  eventType?: string;
  idempotencyKey?: string;
  receivedAtMs?: number;
  evidence?: MonitorSourceTarget;
};

/** Bounded diagnostic receipt for a matched local-listener event. */
export type MonitorListenerEvidence = {
  sourceKind: "local_listener";
  sourceType: "telegram-user" | "whatsapp";
  /** Hash of the source's durable deduplication boundary; never routing authority. */
  idempotencyKeyHash: string;
  receivedAtMs: number;
  updatedAtMs: number;
};

export type MonitorGoalSnapshot = {
  id: string;
  objective: string;
  autonomy?: SessionGoalAutonomy;
};

export type MonitorRecord = {
  monitorId: string;
  agentId: string;
  name?: string;
  /**
   * Optional only for records written before durable task contracts existed.
   * New monitor.create calls always persist normalized instructions.
   */
  instructions?: string;
  originSessionKey: string;
  originDelivery?: CronDelivery;
  watchDelivery?: CronDelivery;
  monitorSessionKey: string;
  sourceType: string;
  sourceTarget: MonitorSourceTarget;
  cadence: CronSchedule;
  trigger?: MonitorTrigger;
  expiryAt?: string;
  stopCondition?: string;
  actionPolicy: MonitorActionPolicy;
  goal?: MonitorGoalSnapshot;
  /** Exact one-shot authority copied from the user-approved goal/monitor contract. */
  authority?: MonitorAuthorityGrant;
  /** Optional for legacy records; new records persist the normalized default. */
  notificationPolicy?: MonitorNotificationPolicy;
  /** Small bounded counter/timestamp state; never stores raw source evidence. */
  notificationState?: MonitorNotificationState;
  /** Optional for legacy records; monitor.create always returns it for new records. */
  disclosure?: MonitorDisclosure;
  /** Last matched local-listener receipt; never stores source targets or body content. */
  listenerEvidence?: MonitorListenerEvidence;
  status: MonitorStatus;
  lastCheckpoint?: MonitorCheckpoint;
  cronJobId: string;
  createdAtMs: number;
  updatedAtMs: number;
  lastWakeAtMs?: number;
  lastWakeStatus?: MonitorStatus;
};

export type MonitorStoreFile = {
  version: 1;
  monitors: MonitorRecord[];
  pendingEvents?: MonitorEventEnvelope[];
};

export type MonitorCreateInput = {
  monitorId?: string;
  agentId: string;
  name?: string;
  instructions: string;
  originSessionKey: string;
  originDelivery?: CronDelivery;
  watchDelivery?: CronDelivery;
  monitorSessionKey: string;
  sourceType: string;
  sourceTarget: MonitorSourceTarget;
  cadence: CronSchedule;
  trigger?: MonitorTrigger;
  expiryAt?: string;
  stopCondition?: string;
  actionPolicy?: MonitorActionPolicy;
  goal?: MonitorGoalSnapshot;
  authority?: MonitorAuthorityGrant;
  purpose?: string;
  notificationPolicy?: MonitorNotificationPolicy;
  lastCheckpoint?: MonitorCheckpoint;
  cronJobId: string;
};

export type MonitorUpdatePatch = Partial<
  Pick<
    MonitorRecord,
    | "name"
    | "originDelivery"
    | "watchDelivery"
    | "sourceTarget"
    | "cadence"
    | "trigger"
    | "expiryAt"
    | "stopCondition"
    | "actionPolicy"
    | "goal"
    | "authority"
    | "notificationPolicy"
    | "notificationState"
    | "disclosure"
    | "listenerEvidence"
    | "status"
    | "lastCheckpoint"
    | "lastWakeAtMs"
    | "lastWakeStatus"
  >
>;
