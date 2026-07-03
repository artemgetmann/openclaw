import type { CronDelivery, CronSchedule } from "../cron/types.js";

export type MonitorStatus = "active" | "degraded" | "stopped" | "completed" | "expired";

// `completed` is preserved for backward compatibility as a task-level hint
// from the agent, but only `stopped` and `expired` should end the monitor
// lifecycle in the generic monitor engine.
export function isTerminalMonitorStatus(status: MonitorStatus): boolean {
  return status === "stopped" || status === "expired";
}

export type MonitorActionPolicy = "notify_draft" | "notify_only" | "auto_send";

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

export type MonitorRecord = {
  monitorId: string;
  agentId: string;
  name?: string;
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
};

export type MonitorCreateInput = {
  monitorId?: string;
  agentId: string;
  name?: string;
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
    | "status"
    | "lastCheckpoint"
    | "lastWakeAtMs"
    | "lastWakeStatus"
  >
>;
