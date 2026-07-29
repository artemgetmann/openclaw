import { Type } from "@sinclair/typebox";
import { MONITOR_INSTRUCTIONS_MAX_LENGTH } from "../../../monitor/types.js";
import { CronDeliverySchema, CronScheduleSchema } from "./cron.js";
import { NonEmptyString } from "./primitives.js";

// A durable task contract is carried in every wake. Bound it at ingress so a
// monitor cannot turn its own persisted state into an unbounded prompt source.
const MonitorInstructionsSchema = Type.String({
  minLength: 1,
  maxLength: MONITOR_INSTRUCTIONS_MAX_LENGTH,
  pattern: "\\S",
});

const MonitorActionPolicySchema = Type.Union([
  Type.Literal("notify_draft"),
  Type.Literal("notify_only"),
  Type.Literal("auto_send"),
]);

const MonitorAutonomySchema = Type.Object(
  {
    level: Type.Union([Type.Literal("observe_only"), Type.Literal("act_within_scope")]),
    allowedActions: Type.Optional(Type.Array(Type.String(), { maxItems: 12 })),
    approvalRequired: Type.Optional(Type.Array(Type.String(), { maxItems: 12 })),
  },
  { additionalProperties: false },
);

const MonitorNotificationEventSchema = Type.Union([
  Type.Literal("unchanged"),
  Type.Literal("material_change"),
  Type.Literal("completion"),
  Type.Literal("user_input"),
  Type.Literal("approval_required"),
  Type.Literal("deadline_passed"),
  Type.Literal("degraded"),
]);

const MonitorNotificationPolicySchema = Type.Object(
  {
    mode: Type.Literal("change_aware"),
    unchangedNoticeAfterChecks: Type.Integer({ minimum: 1 }),
    unchangedReminderIntervalMs: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

const MonitorNotificationStateSchema = Type.Object(
  {
    consecutiveUnchangedChecks: Type.Integer({ minimum: 0 }),
    lastEvent: Type.Optional(MonitorNotificationEventSchema),
    lastEventAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    lastNotificationAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    lastMaterialChangeAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

const MonitorStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("degraded"),
  Type.Literal("stopped"),
  Type.Literal("completed"),
  Type.Literal("expired"),
]);

const LooseObjectSchema = Type.Object({}, { additionalProperties: true });

const MonitorEventTriggerKindSchema = Type.Union([
  Type.Literal("webhook"),
  Type.Literal("local_listener"),
  Type.Literal("process_exit"),
  Type.Literal("browser_observer"),
]);

const MonitorTriggerMatchSchema = Type.Object(
  {
    sourceType: Type.Optional(Type.String()),
    sourceTarget: Type.Optional(LooseObjectSchema),
    matchKeys: Type.Optional(Type.Array(Type.String())),
    eventTypes: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

const MonitorTriggerSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("schedule"),
      cadence: Type.Optional(CronScheduleSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: MonitorEventTriggerKindSchema,
      match: Type.Optional(MonitorTriggerMatchSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("hybrid"),
      schedule: Type.Optional(
        Type.Object(
          { cadence: Type.Optional(CronScheduleSchema) },
          { additionalProperties: false },
        ),
      ),
      event: Type.Object(
        {
          kind: MonitorEventTriggerKindSchema,
          match: Type.Optional(MonitorTriggerMatchSchema),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
]);

const MonitorEventEnvelopeSchema = Type.Object(
  {
    triggerKind: MonitorEventTriggerKindSchema,
    sourceType: NonEmptyString,
    sourceTarget: LooseObjectSchema,
    eventType: Type.Optional(Type.String()),
    idempotencyKey: Type.Optional(Type.String()),
    receivedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    evidence: Type.Optional(LooseObjectSchema),
  },
  { additionalProperties: false },
);

const MonitorListenerEvidenceSchema = Type.Object(
  {
    sourceKind: Type.Literal("local_listener"),
    sourceType: Type.Union([Type.Literal("telegram-user"), Type.Literal("whatsapp")]),
    idempotencyKeyHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    receivedAtMs: Type.Integer({ minimum: 0 }),
    updatedAtMs: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const MonitorGoalSnapshotSchema = Type.Object(
  {
    id: NonEmptyString,
    objective: NonEmptyString,
    autonomy: Type.Optional(MonitorAutonomySchema),
  },
  { additionalProperties: false },
);

const MonitorAuthorityActionSchema = Type.Object(
  {
    kind: Type.Literal("codex.thread.unarchive_resume"),
    threadId: NonEmptyString,
    prompt: NonEmptyString,
  },
  { additionalProperties: false },
);

const MonitorAuthorityAuditEventSchema = Type.Object(
  {
    event: Type.Union([
      Type.Literal("granted"),
      Type.Literal("revoked"),
      Type.Literal("consumed"),
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("denied"),
    ]),
    atMs: Type.Integer({ minimum: 0 }),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const MonitorAuthorityExecutionSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal("available"),
      Type.Literal("consumed"),
      Type.Literal("completed"),
      Type.Literal("failed"),
    ]),
    executions: Type.Integer({ minimum: 0, maximum: 1 }),
    consumedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    completedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    failedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    externalRef: Type.Optional(Type.String()),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const MonitorAuthorityGrantInputSchema = Type.Object(
  {
    purposeKey: NonEmptyString,
    action: MonitorAuthorityActionSchema,
    idempotencyKey: NonEmptyString,
    expiresAt: NonEmptyString,
    stopCondition: NonEmptyString,
  },
  { additionalProperties: false },
);

const MonitorAuthorityGrantSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    grantId: NonEmptyString,
    goalId: NonEmptyString,
    purposeKey: NonEmptyString,
    action: MonitorAuthorityActionSchema,
    idempotencyKey: NonEmptyString,
    expiresAt: NonEmptyString,
    stopCondition: NonEmptyString,
    maxExecutions: Type.Literal(1),
    grantedAtMs: Type.Integer({ minimum: 0 }),
    revokedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    execution: MonitorAuthorityExecutionSchema,
    audit: Type.Array(MonitorAuthorityAuditEventSchema, { maxItems: 24 }),
  },
  { additionalProperties: false },
);

export const MonitorRecordSchema = Type.Object(
  {
    monitorId: NonEmptyString,
    agentId: NonEmptyString,
    name: Type.Optional(Type.String()),
    // Optional keeps monitor-store JSON written before this contract valid.
    instructions: Type.Optional(MonitorInstructionsSchema),
    originSessionKey: NonEmptyString,
    originDelivery: Type.Optional(CronDeliverySchema),
    watchDelivery: Type.Optional(CronDeliverySchema),
    monitorSessionKey: NonEmptyString,
    sourceType: NonEmptyString,
    sourceTarget: LooseObjectSchema,
    cadence: CronScheduleSchema,
    trigger: Type.Optional(MonitorTriggerSchema),
    expiryAt: Type.Optional(Type.String()),
    stopCondition: Type.Optional(Type.String()),
    actionPolicy: MonitorActionPolicySchema,
    goal: Type.Optional(MonitorGoalSnapshotSchema),
    authority: Type.Optional(MonitorAuthorityGrantSchema),
    notificationPolicy: Type.Optional(MonitorNotificationPolicySchema),
    notificationState: Type.Optional(MonitorNotificationStateSchema),
    listenerEvidence: Type.Optional(MonitorListenerEvidenceSchema),
    disclosure: Type.Optional(
      Type.Object(
        {
          purpose: NonEmptyString,
          source: Type.Object(
            { type: NonEmptyString, target: LooseObjectSchema },
            { additionalProperties: false },
          ),
          checkCadence: CronScheduleSchema,
          noChangeCadence: Type.Object(
            {
              noticeAfterChecks: Type.Integer({ minimum: 1 }),
              reminderIntervalMs: Type.Integer({ minimum: 1 }),
            },
            { additionalProperties: false },
          ),
          expiryAt: Type.Union([Type.String(), Type.Null()]),
          stopCondition: Type.Union([Type.String(), Type.Null()]),
          autonomy: MonitorAutonomySchema,
          actionPolicy: MonitorActionPolicySchema,
        },
        { additionalProperties: false },
      ),
    ),
    status: MonitorStatusSchema,
    lastCheckpoint: Type.Optional(LooseObjectSchema),
    cronJobId: NonEmptyString,
    createdAtMs: Type.Integer({ minimum: 0 }),
    updatedAtMs: Type.Integer({ minimum: 0 }),
    lastWakeAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    lastWakeStatus: Type.Optional(MonitorStatusSchema),
  },
  { additionalProperties: false },
);

export const MonitorListParamsSchema = Type.Object({}, { additionalProperties: false });

export const MonitorGetParamsSchema = Type.Object(
  { monitorId: NonEmptyString },
  { additionalProperties: false },
);

export const MonitorCreateParamsSchema = Type.Object(
  {
    instructions: MonitorInstructionsSchema,
    agentId: NonEmptyString,
    name: Type.Optional(Type.String()),
    originSessionKey: NonEmptyString,
    originDelivery: Type.Optional(CronDeliverySchema),
    watchDelivery: Type.Optional(CronDeliverySchema),
    sourceType: NonEmptyString,
    sourceTarget: LooseObjectSchema,
    cadence: CronScheduleSchema,
    trigger: Type.Optional(MonitorTriggerSchema),
    expiryAt: Type.Optional(Type.String()),
    stopCondition: Type.Optional(Type.String()),
    actionPolicy: Type.Optional(MonitorActionPolicySchema),
    goal: Type.Optional(MonitorGoalSnapshotSchema),
    authority: Type.Optional(MonitorAuthorityGrantInputSchema),
    notificationPolicy: Type.Optional(MonitorNotificationPolicySchema),
    lastCheckpoint: Type.Optional(LooseObjectSchema),
  },
  { additionalProperties: false },
);

export const MonitorUpdateParamsSchema = Type.Object(
  {
    monitorId: NonEmptyString,
    patch: Type.Object(
      {
        name: Type.Optional(Type.String()),
        originDelivery: Type.Optional(CronDeliverySchema),
        watchDelivery: Type.Optional(CronDeliverySchema),
        sourceTarget: Type.Optional(LooseObjectSchema),
        cadence: Type.Optional(CronScheduleSchema),
        trigger: Type.Optional(MonitorTriggerSchema),
        expiryAt: Type.Optional(Type.String()),
        stopCondition: Type.Optional(Type.String()),
        actionPolicy: Type.Optional(MonitorActionPolicySchema),
        goal: Type.Optional(MonitorGoalSnapshotSchema),
        notificationPolicy: Type.Optional(MonitorNotificationPolicySchema),
        notificationEvent: Type.Optional(MonitorNotificationEventSchema),
        status: Type.Optional(MonitorStatusSchema),
        lastCheckpoint: Type.Optional(LooseObjectSchema),
        lastWakeAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
        lastWakeStatus: Type.Optional(MonitorStatusSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const MonitorStopParamsSchema = Type.Object(
  { monitorId: NonEmptyString },
  { additionalProperties: false },
);

export const MonitorRouteEventParamsSchema = MonitorEventEnvelopeSchema;
