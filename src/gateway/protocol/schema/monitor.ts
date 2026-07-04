import { Type } from "@sinclair/typebox";
import { CronDeliverySchema, CronScheduleSchema } from "./cron.js";
import { NonEmptyString } from "./primitives.js";

const MonitorActionPolicySchema = Type.Union([
  Type.Literal("notify_draft"),
  Type.Literal("notify_only"),
  Type.Literal("auto_send"),
]);

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

const MonitorGoalSnapshotSchema = Type.Object(
  {
    id: NonEmptyString,
    objective: NonEmptyString,
  },
  { additionalProperties: false },
);

export const MonitorRecordSchema = Type.Object(
  {
    monitorId: NonEmptyString,
    agentId: NonEmptyString,
    name: Type.Optional(Type.String()),
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
    instructions: NonEmptyString,
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
