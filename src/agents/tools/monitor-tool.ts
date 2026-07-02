import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";
import { callGatewayTool, readGatewayCallOptions, type GatewayCallOptions } from "./gateway.js";
import { resolveAnnounceTarget } from "./sessions-announce-target.js";

const MONITOR_ACTIONS = ["list", "get", "create", "update", "stop"] as const;
const MONITOR_ACTION_POLICIES = ["notify_draft", "notify_only", "auto_send"] as const;
const MONITOR_STATUSES = ["active", "stopped", "completed", "expired"] as const;

function normalizeAnnounceDelivery(delivery: Record<string, unknown> | undefined) {
  if (!delivery) {
    return undefined;
  }
  if (typeof delivery.mode === "string") {
    return delivery;
  }
  const channel = typeof delivery.channel === "string" ? delivery.channel.trim() : "";
  const to = typeof delivery.to === "string" ? delivery.to.trim() : "";
  if (!channel || !to) {
    return delivery;
  }
  return {
    ...delivery,
    mode: "announce",
  };
}

const MonitorToolSchema = Type.Object(
  {
    action: stringEnum(MONITOR_ACTIONS),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    monitorId: Type.Optional(Type.String()),
    instructions: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
    sourceType: Type.Optional(Type.String()),
    sourceTarget: Type.Optional(Type.Object({}, { additionalProperties: true })),
    cadence: Type.Optional(Type.Object({}, { additionalProperties: true })),
    expiryAt: Type.Optional(Type.String()),
    stopCondition: Type.Optional(Type.String()),
    actionPolicy: Type.Optional(stringEnum(MONITOR_ACTION_POLICIES)),
    watchDelivery: Type.Optional(Type.Object({}, { additionalProperties: true })),
    patch: Type.Optional(Type.Object({}, { additionalProperties: true })),
    goal: Type.Optional(
      Type.Object({
        id: Type.String(),
        objective: Type.String(),
      }),
    ),
    status: Type.Optional(stringEnum(MONITOR_STATUSES)),
    checkpoint: Type.Optional(Type.Object({}, { additionalProperties: true })),
    originSessionKey: Type.Optional(Type.String()),
    originDelivery: Type.Optional(Type.Object({}, { additionalProperties: true })),
  },
  { additionalProperties: true },
);

export function createMonitorTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Monitor",
    name: "monitor",
    ownerOnly: true,
    description: `Manage durable agent-first monitors. Use this instead of hand-authoring ad hoc cron monitor jobs.

Key behavior:
- create: allocates a durable monitor session, stores generic monitor metadata, and schedules cron wakes.
- update: persist checkpoint/status changes after a successful source check.
- stop: stop a monitor cleanly.
- get/list: inspect current monitor state.

For monitor creation:
- instructions should capture the actual monitoring task in plain language.
- if there is an active goal, monitor.create will bind it automatically; pass goal only when carrying an explicit snapshot.
- sourceType/sourceTarget identify what is being checked.
- cadence is the cron schedule object for repeated wakes.
- default actionPolicy is notify_draft.
- default report route is the origin chat from the current session.

For monitor-related user replies/status:
- use the monitor-router skill for natural-language routing.
- use list/get to inspect candidate monitors before acting.
- act only when exactly one monitor is clear; if multiple active monitors could match, ask a short clarification.
- when drafting a reply, include the actual draft text in the origin-chat update before asking whether to send, edit, or stop watching.
- when only reporting status, summarize the status and next step without forcing send/edit language.
- use update to persist compact status/checkpoint; keep raw evidence behind ids, paths, or refs.`,
    parameters: MonitorToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const gatewayOpts: GatewayCallOptions = {
        ...readGatewayCallOptions(params),
        timeoutMs:
          typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
            ? params.timeoutMs
            : 60_000,
      };

      switch (action) {
        case "list":
          return jsonResult(await callGatewayTool("monitor.list", gatewayOpts, {}));
        case "get":
          return jsonResult(
            await callGatewayTool("monitor.get", gatewayOpts, {
              monitorId: readStringParam(params, "monitorId", { required: true }),
            }),
          );
        case "create": {
          const agentSessionKey =
            readStringParam(params, "originSessionKey") ?? opts?.agentSessionKey?.trim();
          if (!agentSessionKey) {
            throw new ToolInputError("originSessionKey required");
          }
          const cfg = loadConfig();
          const resolvedOriginDelivery = await resolveAnnounceTarget({
            sessionKey: agentSessionKey,
            displayKey: agentSessionKey,
          });
          const originDelivery =
            normalizeAnnounceDelivery(
              params.originDelivery as Record<string, unknown> | undefined,
            ) ?? normalizeAnnounceDelivery(resolvedOriginDelivery ?? undefined);
          const sourceTarget = params.sourceTarget;
          const cadence = params.cadence;
          if (!sourceTarget || typeof sourceTarget !== "object" || Array.isArray(sourceTarget)) {
            throw new ToolInputError("sourceTarget required");
          }
          if (!cadence || typeof cadence !== "object" || Array.isArray(cadence)) {
            throw new ToolInputError("cadence required");
          }
          return jsonResult(
            await callGatewayTool("monitor.create", gatewayOpts, {
              instructions: readStringParam(params, "instructions", { required: true }),
              agentId: resolveSessionAgentId({ sessionKey: agentSessionKey, config: cfg }),
              name: readStringParam(params, "name"),
              originSessionKey: agentSessionKey,
              originDelivery,
              sourceType: readStringParam(params, "sourceType", { required: true }),
              sourceTarget,
              cadence,
              expiryAt: readStringParam(params, "expiryAt"),
              stopCondition: readStringParam(params, "stopCondition"),
              actionPolicy:
                readStringParam(params, "actionPolicy") ??
                ("notify_draft" as (typeof MONITOR_ACTION_POLICIES)[number]),
              goal:
                params.goal && typeof params.goal === "object" && !Array.isArray(params.goal)
                  ? params.goal
                  : undefined,
              watchDelivery:
                params.watchDelivery &&
                typeof params.watchDelivery === "object" &&
                !Array.isArray(params.watchDelivery)
                  ? params.watchDelivery
                  : undefined,
              lastCheckpoint:
                params.checkpoint &&
                typeof params.checkpoint === "object" &&
                !Array.isArray(params.checkpoint)
                  ? params.checkpoint
                  : undefined,
            }),
          );
        }
        case "update": {
          const patch =
            params.patch && typeof params.patch === "object" && !Array.isArray(params.patch)
              ? { ...(params.patch as Record<string, unknown>) }
              : {};
          const status = readStringParam(params, "status");
          const checkpoint = params.checkpoint;
          if (status) {
            patch.status = status;
          }
          if (
            params.watchDelivery &&
            typeof params.watchDelivery === "object" &&
            !Array.isArray(params.watchDelivery)
          ) {
            patch.watchDelivery = params.watchDelivery;
          }
          if (checkpoint && typeof checkpoint === "object" && !Array.isArray(checkpoint)) {
            patch.lastCheckpoint = checkpoint;
          }
          return jsonResult(
            await callGatewayTool("monitor.update", gatewayOpts, {
              monitorId: readStringParam(params, "monitorId", { required: true }),
              patch,
            }),
          );
        }
        case "stop":
          return jsonResult(
            await callGatewayTool("monitor.stop", gatewayOpts, {
              monitorId: readStringParam(params, "monitorId", { required: true }),
            }),
          );
        default:
          throw new ToolInputError(`Unsupported action: ${action}`);
      }
    },
  };
}
