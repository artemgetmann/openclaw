// Model-facing goal tools scoped to the current chat/session.
import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import {
  createSessionGoal,
  getSessionGoal,
  requestSessionGoalEvaluation,
  resolveSessionGoalAutonomy,
  type SessionGoalSnapshot,
} from "../../config/sessions/goals.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import {
  SESSION_GOAL_CODEX_THREAD_UNARCHIVE_RESUME_ACTION,
  type SessionGoalAuthorityGrant,
  type SessionGoalAutonomy,
} from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveCronStorePath } from "../../cron/store.js";
import { loadMonitorStore, resolveMonitorStorePath } from "../../monitor/store.js";
import type { MonitorActionPolicy, MonitorRecord, MonitorStatus } from "../../monitor/types.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { stringEnum } from "../schema/typebox.js";
import {
  type AnyAgentTool,
  ToolInputError,
  jsonResult,
  readStringArrayParam,
  readStringParam,
} from "./common.js";

type GoalToolOptions = {
  agentSessionKey?: string;
  sessionAgentId?: string;
  config?: OpenClawConfig;
  runId?: string;
};

type GoalSessionScope = {
  sessionKey: string;
  storePath: string;
  expectedGoalId?: string;
};

type GoalWaitingMonitor = {
  monitorId: string;
  status: Extract<MonitorStatus, "active" | "degraded">;
  name?: string;
  sourceType: string;
  actionPolicy: MonitorActionPolicy;
  lastWakeStatus?: MonitorStatus;
  updatedAtMs: number;
  expiryAt?: string;
};

type GoalSnapshotWithWaitingMonitors = SessionGoalSnapshot & {
  waitingOnMonitors?: GoalWaitingMonitor[];
  continuationHealth?: {
    state: "unbound" | "observing" | "acting_within_scope" | "degraded";
    actionCapability: SessionGoalAutonomy["level"];
    activeMonitors: number;
    degradedMonitors: number;
  };
};

const GOAL_TOOL_STATUSES = ["complete", "blocked"] as const;
const WAITING_MONITOR_STATUSES = new Set<MonitorStatus>(["active", "degraded"]);

const CreateGoalToolSchema = Type.Object({
  objective: Type.String({
    description: "Concrete objective to pursue. Create only when explicitly requested.",
  }),
  autonomy: Type.Optional(
    Type.Object(
      {
        level: stringEnum(["observe_only", "act_within_scope"] as const, {
          description: "observe_only | act_within_scope.",
        }),
        allowedActions: Type.Optional(Type.Array(Type.String(), { maxItems: 12 })),
        approvalRequired: Type.Optional(Type.Array(Type.String(), { maxItems: 12 })),
        authorityGrants: Type.Optional(
          Type.Array(
            Type.Object(
              {
                purposeKey: Type.String({ minLength: 1, maxLength: 240 }),
                action: Type.Object(
                  {
                    kind: Type.Literal(SESSION_GOAL_CODEX_THREAD_UNARCHIVE_RESUME_ACTION),
                    threadId: Type.String({ minLength: 1, maxLength: 256 }),
                    prompt: Type.String({ minLength: 1, maxLength: 8_000 }),
                  },
                  { additionalProperties: false },
                ),
                idempotencyKey: Type.String({ minLength: 1, maxLength: 256 }),
                expiresAt: Type.String({ minLength: 1, maxLength: 80 }),
                stopCondition: Type.String({ minLength: 1, maxLength: 1_000 }),
                maxExecutions: Type.Literal(1),
              },
              { additionalProperties: false },
            ),
            { maxItems: 4 },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  ),
});

const UpdateGoalToolSchema = Type.Object({
  status: stringEnum(GOAL_TOOL_STATUSES, {
    description: "complete | blocked.",
  }),
  note: Type.Optional(Type.String({ description: "Short status note." })),
  blocker_key: Type.Optional(
    Type.String({
      description:
        "Stable dependency key required for blocked claims, such as awaiting_user_destination.",
    }),
  ),
});

function resolveConfig(options: GoalToolOptions): OpenClawConfig {
  return options.config ?? loadConfig();
}

function resolveCurrentGoalSessionScope(options: GoalToolOptions): GoalSessionScope {
  const sessionKey = options.agentSessionKey?.trim();
  if (!sessionKey) {
    throw new ToolInputError("session key required");
  }
  const cfg = resolveConfig(options);
  const parsedAgentId = parseAgentSessionKey(sessionKey)?.agentId;
  const agentId = normalizeAgentId(parsedAgentId ?? options.sessionAgentId);
  return {
    sessionKey,
    storePath: resolveStorePath(cfg.session?.store, { agentId }),
  };
}

async function resolveMonitorOriginGoalSessionScope(
  options: GoalToolOptions,
  current: GoalSessionScope,
): Promise<GoalSessionScope | undefined> {
  const monitor = await resolveCurrentSessionMonitor(options, current);
  if (!monitor?.goal) {
    return undefined;
  }
  return {
    sessionKey: monitor.originSessionKey,
    storePath: resolveStorePath(resolveConfig(options).session?.store, {
      agentId: monitor.agentId,
    }),
    expectedGoalId: monitor.goal.id,
  };
}

async function resolveCurrentSessionMonitor(
  options: GoalToolOptions,
  current: Pick<GoalSessionScope, "sessionKey">,
): Promise<MonitorRecord | undefined> {
  const cfg = resolveConfig(options);
  const monitorStorePath = resolveMonitorStorePath({
    cronStorePath: resolveCronStorePath(cfg.cron?.store),
  });
  const store = await loadMonitorStore(monitorStorePath);
  return store.monitors.find((entry) => entry.monitorSessionKey === current.sessionKey);
}

async function resolveGoalSessionScope(
  options: GoalToolOptions,
  scopeOptions?: { allowMonitorOrigin?: boolean },
): Promise<GoalSessionScope> {
  const current = resolveCurrentGoalSessionScope(options);
  if (!scopeOptions?.allowMonitorOrigin) {
    return current;
  }
  return (await resolveMonitorOriginGoalSessionScope(options, current)) ?? current;
}

function toGoalWaitingMonitor(monitor: MonitorRecord): GoalWaitingMonitor {
  return {
    monitorId: monitor.monitorId,
    status: monitor.status as Extract<MonitorStatus, "active" | "degraded">,
    ...(monitor.name ? { name: monitor.name } : {}),
    sourceType: monitor.sourceType,
    actionPolicy: monitor.actionPolicy,
    ...(monitor.lastWakeStatus ? { lastWakeStatus: monitor.lastWakeStatus } : {}),
    updatedAtMs: monitor.updatedAtMs,
    ...(monitor.expiryAt ? { expiryAt: monitor.expiryAt } : {}),
  };
}

async function resolveGoalWaitingMonitors(
  options: GoalToolOptions,
  scope: GoalSessionScope,
  snapshot: SessionGoalSnapshot,
): Promise<GoalWaitingMonitor[]> {
  if (snapshot.status !== "found" || !snapshot.goal) {
    return [];
  }

  const cfg = resolveConfig(options);
  const monitorStorePath = resolveMonitorStorePath({
    cronStorePath: resolveCronStorePath(cfg.cron?.store),
  });
  const store = await loadMonitorStore(monitorStorePath);
  // `get_goal` is the user-facing contract surface, so expose only the waits
  // bound to this exact goal and origin chat. Monitor internals stay in monitor tools.
  return store.monitors
    .filter(
      (monitor) =>
        monitor.goal?.id === snapshot.goal?.id &&
        monitor.originSessionKey === scope.sessionKey &&
        WAITING_MONITOR_STATUSES.has(monitor.status),
    )
    .map(toGoalWaitingMonitor);
}

function readExplicitAutonomy(params: Record<string, unknown>): SessionGoalAutonomy | undefined {
  const raw = params.autonomy;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const autonomy = raw as Record<string, unknown>;
  const level = readStringParam(autonomy, "level", { required: true });
  if (level !== "observe_only" && level !== "act_within_scope") {
    throw new ToolInputError("autonomy.level must be observe_only or act_within_scope");
  }
  const allowedActions = readStringArrayParam(autonomy, "allowedActions");
  const approvalRequired = readStringArrayParam(autonomy, "approvalRequired");
  const rawAuthorityGrants = autonomy.authorityGrants;
  const authorityGrants = Array.isArray(rawAuthorityGrants)
    ? rawAuthorityGrants.map((value) => value as SessionGoalAuthorityGrant)
    : undefined;
  if (level === "act_within_scope" && !allowedActions?.some((value) => value.trim())) {
    if (!authorityGrants?.length) {
      throw new ToolInputError(
        "act_within_scope requires at least one concise allowed action or exact authority grant",
      );
    }
  }
  return {
    level,
    ...(allowedActions ? { allowedActions } : {}),
    ...(approvalRequired ? { approvalRequired } : {}),
    ...(authorityGrants ? { authorityGrants } : {}),
  };
}

export function createGetGoalTool(options: GoalToolOptions): AnyAgentTool {
  return {
    label: "Get Goal",
    name: "get_goal",
    description: "Get the current goal for this session, including status and token usage.",
    parameters: Type.Object({}),
    execute: async () => {
      const scope = await resolveGoalSessionScope(options, { allowMonitorOrigin: true });
      const snapshot = await getSessionGoal({
        ...scope,
        persist: false,
      });
      const waitingOnMonitors = await resolveGoalWaitingMonitors(options, scope, snapshot);
      const autonomy =
        snapshot.status === "found" ? resolveSessionGoalAutonomy(snapshot.goal) : undefined;
      const activeMonitors = waitingOnMonitors.filter(
        (monitor) => monitor.status === "active",
      ).length;
      const degradedMonitors = waitingOnMonitors.length - activeMonitors;
      const details: GoalSnapshotWithWaitingMonitors = {
        ...snapshot,
        ...(snapshot.goal && autonomy ? { goal: { ...snapshot.goal, autonomy } } : {}),
        ...(waitingOnMonitors.length ? { waitingOnMonitors } : {}),
        ...(snapshot.goal?.status === "active" && autonomy
          ? {
              continuationHealth: {
                state:
                  waitingOnMonitors.length === 0
                    ? "unbound"
                    : degradedMonitors > 0
                      ? "degraded"
                      : autonomy.level === "act_within_scope"
                        ? "acting_within_scope"
                        : "observing",
                actionCapability: autonomy.level,
                activeMonitors,
                degradedMonitors,
              },
            }
          : {}),
      };
      return jsonResult(details);
    },
  };
}

export function createCreateGoalTool(options: GoalToolOptions): AnyAgentTool {
  return {
    label: "Create Goal",
    name: "create_goal",
    description:
      "Create a goal only when explicitly requested by the user or system instructions. Autonomy defaults to observe-only and must be omitted unless the user explicitly grants it. Use act_within_scope only with concise allowed actions and approval-required boundaries. Consequential durable actions require an exact authorityGrants entry containing the approved target, prompt, expiry, stop condition, and maxExecutions=1. Fails if a goal already exists; do not silently replace an existing goal.",
    parameters: CreateGoalToolSchema,
    execute: async (_toolCallId, args) => {
      const current = resolveCurrentGoalSessionScope(options);
      const monitor = await resolveCurrentSessionMonitor(options, current);
      if (monitor) {
        return jsonResult({
          status: "ignored",
          reason: "monitor sessions do not own user goals",
          monitorId: monitor.monitorId,
        });
      }
      const params = args as Record<string, unknown>;
      const objective = readStringParam(params, "objective", { required: true });
      const autonomy = readExplicitAutonomy(params);
      const goal = await createSessionGoal({
        ...current,
        objective,
        ...(autonomy ? { autonomy } : {}),
      });
      return jsonResult({ status: "created", goal });
    },
  };
}

export function createUpdateGoalTool(options: GoalToolOptions): AnyAgentTool {
  return {
    label: "Update Goal",
    name: "update_goal",
    description:
      "Request independent evaluation of a completion or blocked claim. This tool never completes or blocks the goal directly. Include a concrete note; blocked claims also require blocker_key for the exact user-input or external-state dependency.",
    parameters: UpdateGoalToolSchema,
    execute: async (toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const status = readStringParam(params, "status", { required: true });
      if (!GOAL_TOOL_STATUSES.includes(status as (typeof GOAL_TOOL_STATUSES)[number])) {
        throw new ToolInputError(`status must be one of ${GOAL_TOOL_STATUSES.join(", ")}`);
      }
      const current = resolveCurrentGoalSessionScope(options);
      const monitor = await resolveCurrentSessionMonitor(options, current);
      if (monitor && !monitor.goal) {
        return jsonResult({
          status: "ignored",
          reason: "monitor session has no bound goal",
          monitorId: monitor.monitorId,
        });
      }
      const note = readStringParam(params, "note", { required: true });
      const blockerKey = readStringParam(params, "blocker_key");
      const scope = monitor?.goal
        ? {
            sessionKey: monitor.originSessionKey,
            storePath: resolveStorePath(resolveConfig(options).session?.store, {
              agentId: monitor.agentId,
            }),
            expectedGoalId: monitor.goal.id,
          }
        : current;
      const goal = await requestSessionGoalEvaluation({
        ...scope,
        requestId: toolCallId,
        runId: options.runId ?? toolCallId,
        proposedStatus: status as (typeof GOAL_TOOL_STATUSES)[number],
        reason: note,
        ...(blockerKey ? { blockerKey } : {}),
        ...(scope.expectedGoalId ? { expectedGoalId: scope.expectedGoalId } : {}),
      });
      return jsonResult({
        status: "evaluation_requested",
        goal,
        message: "The goal remains active until the independent evaluator returns satisfied.",
      });
    },
  };
}
