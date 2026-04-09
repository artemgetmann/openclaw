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
  Type.Literal("stopped"),
  Type.Literal("completed"),
  Type.Literal("expired"),
]);

const LooseObjectSchema = Type.Object({}, { additionalProperties: true });

export const MonitorRecordSchema = Type.Object(
  {
    monitorId: NonEmptyString,
    agentId: NonEmptyString,
    name: Type.Optional(Type.String()),
    originSessionKey: NonEmptyString,
    originDelivery: Type.Optional(CronDeliverySchema),
    monitorSessionKey: NonEmptyString,
    sourceType: NonEmptyString,
    sourceTarget: LooseObjectSchema,
    cadence: CronScheduleSchema,
    expiryAt: Type.Optional(Type.String()),
    stopCondition: Type.Optional(Type.String()),
    actionPolicy: MonitorActionPolicySchema,
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
    sourceType: NonEmptyString,
    sourceTarget: LooseObjectSchema,
    cadence: CronScheduleSchema,
    expiryAt: Type.Optional(Type.String()),
    stopCondition: Type.Optional(Type.String()),
    actionPolicy: Type.Optional(MonitorActionPolicySchema),
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
        sourceTarget: Type.Optional(LooseObjectSchema),
        cadence: Type.Optional(CronScheduleSchema),
        expiryAt: Type.Optional(Type.String()),
        stopCondition: Type.Optional(Type.String()),
        actionPolicy: Type.Optional(MonitorActionPolicySchema),
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
