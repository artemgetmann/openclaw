// Model-facing goal tools scoped to the current chat/session.
import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import {
  createSessionGoal,
  getSessionGoal,
  updateSessionGoalStatus,
} from "../../config/sessions/goals.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveCronStorePath } from "../../cron/store.js";
import { loadMonitorStore, resolveMonitorStorePath } from "../../monitor/store.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { stringEnum } from "../schema/typebox.js";
import {
  type AnyAgentTool,
  ToolInputError,
  jsonResult,
  readNumberParam,
  readStringParam,
} from "./common.js";

type GoalToolOptions = {
  agentSessionKey?: string;
  sessionAgentId?: string;
  config?: OpenClawConfig;
};

type GoalSessionScope = {
  sessionKey: string;
  storePath: string;
  expectedGoalId?: string;
};

const GOAL_TOOL_STATUSES = ["complete", "blocked"] as const;

const CreateGoalToolSchema = Type.Object({
  objective: Type.String({
    description: "Concrete objective to pursue. Create only when explicitly requested.",
  }),
  token_budget: Type.Optional(
    Type.Number({
      description: "Optional positive token budget for this goal.",
    }),
  ),
});

const UpdateGoalToolSchema = Type.Object({
  status: stringEnum(GOAL_TOOL_STATUSES, {
    description: "complete | blocked.",
  }),
  note: Type.Optional(Type.String({ description: "Short status note." })),
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
  const cfg = resolveConfig(options);
  const monitorStorePath = resolveMonitorStorePath({
    cronStorePath: resolveCronStorePath(cfg.cron?.store),
  });
  const store = await loadMonitorStore(monitorStorePath);
  const monitor = store.monitors.find(
    (entry) => entry.monitorSessionKey === current.sessionKey && entry.goal,
  );
  if (!monitor?.goal) {
    return undefined;
  }
  return {
    sessionKey: monitor.originSessionKey,
    storePath: resolveStorePath(cfg.session?.store, { agentId: monitor.agentId }),
    expectedGoalId: monitor.goal.id,
  };
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
      return jsonResult(snapshot);
    },
  };
}

export function createCreateGoalTool(options: GoalToolOptions): AnyAgentTool {
  return {
    label: "Create Goal",
    name: "create_goal",
    description:
      "Create a goal only when explicitly requested by the user or system instructions. Fails if a goal already exists; do not silently replace an existing goal.",
    parameters: CreateGoalToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const objective = readStringParam(params, "objective", { required: true });
      const tokenBudget = readNumberParam(params, "token_budget", { integer: true });
      if (tokenBudget !== undefined && tokenBudget <= 0) {
        throw new ToolInputError("token_budget must be positive");
      }
      const goal = await createSessionGoal({
        ...resolveCurrentGoalSessionScope(options),
        objective,
        ...(tokenBudget !== undefined ? { tokenBudget } : {}),
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
      "Mark the current goal complete only when achieved, or blocked only when progress needs user input or an external-state change. Do not use blocked for ordinary difficulty.",
    parameters: UpdateGoalToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const status = readStringParam(params, "status", { required: true });
      if (!GOAL_TOOL_STATUSES.includes(status as (typeof GOAL_TOOL_STATUSES)[number])) {
        throw new ToolInputError(`status must be one of ${GOAL_TOOL_STATUSES.join(", ")}`);
      }
      const note = readStringParam(params, "note");
      const scope = await resolveGoalSessionScope(options, { allowMonitorOrigin: true });
      const goal = await updateSessionGoalStatus({
        ...scope,
        status: status as (typeof GOAL_TOOL_STATUSES)[number],
        ...(note ? { note } : {}),
        ...(scope.expectedGoalId ? { expectedGoalId: scope.expectedGoalId } : {}),
      });
      return jsonResult({ status: "updated", goal });
    },
  };
}
