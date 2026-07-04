import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, ToolInputError, readStringParam } from "./common.js";

export const UPDATE_PLAN_TOOL_NAME = "update_plan";
export const UPDATE_PLAN_TOOL_SUMMARY = "Track a short session work plan";

const PLAN_STEP_STATUSES = ["pending", "in_progress", "completed"] as const;

type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number];

export type UpdatePlanStep = {
  step: string;
  status: PlanStepStatus;
};

export type UpdatePlanDetails = {
  status: "updated";
  explanation?: string;
  plan: UpdatePlanStep[];
};

const UpdatePlanToolSchema = Type.Object({
  explanation: Type.Optional(
    Type.String({
      description: "Short note about what changed in the plan.",
    }),
  ),
  plan: Type.Array(
    Type.Object(
      {
        step: Type.String({ description: "Short user-facing step." }),
        status: stringEnum(PLAN_STEP_STATUSES, {
          description: "Step state: pending, in_progress, or completed.",
        }),
      },
      { additionalProperties: true },
    ),
    {
      minItems: 1,
      description: "Ordered checklist steps. At most one step may be in_progress.",
    },
  ),
});

function isPlanStepStatus(value: string): value is PlanStepStatus {
  return PLAN_STEP_STATUSES.includes(value as PlanStepStatus);
}

function readPlanSteps(params: Record<string, unknown>): UpdatePlanStep[] {
  const rawPlan = params.plan;
  if (!Array.isArray(rawPlan) || rawPlan.length === 0) {
    throw new ToolInputError("plan required");
  }

  const plan = rawPlan.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ToolInputError(`plan[${index}] must be an object`);
    }

    const stepParams = entry as Record<string, unknown>;
    const step = readStringParam(stepParams, "step", {
      required: true,
      label: `plan[${index}].step`,
    });
    const status = readStringParam(stepParams, "status", {
      required: true,
      label: `plan[${index}].status`,
    });
    if (!isPlanStepStatus(status)) {
      throw new ToolInputError(
        `plan[${index}].status must be one of ${PLAN_STEP_STATUSES.join(", ")}`,
      );
    }

    return { step, status };
  });

  // The UI can render a single current step clearly. Multiple active steps make
  // "what is happening now?" ambiguous, so reject them at the tool boundary.
  const inProgressCount = plan.filter((entry) => entry.status === "in_progress").length;
  if (inProgressCount > 1) {
    throw new ToolInputError("plan can contain at most one in_progress step");
  }

  return plan;
}

export function formatUpdatePlanDetails(params: {
  explanation?: string;
  plan: UpdatePlanStep[];
}): UpdatePlanDetails {
  return {
    status: "updated",
    ...(params.explanation ? { explanation: params.explanation } : {}),
    plan: params.plan,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readUpdatePlanStep(value: unknown): UpdatePlanStep | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const step = typeof value.step === "string" ? value.step.trim() : "";
  const status = typeof value.status === "string" ? value.status.trim() : "";
  if (!step || !isPlanStepStatus(status)) {
    return undefined;
  }
  return { step, status };
}

export function readUpdatePlanDetails(value: unknown): UpdatePlanDetails | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const details = readUpdatePlanDetails(value.details);
  if (details) {
    return details;
  }
  const status = typeof value.status === "string" ? value.status.trim() : "";
  if (status !== "updated" || !Array.isArray(value.plan)) {
    return undefined;
  }
  const plan = value.plan.flatMap((entry) => {
    const step = readUpdatePlanStep(entry);
    return step ? [step] : [];
  });
  if (plan.length === 0) {
    return undefined;
  }
  const explanation = typeof value.explanation === "string" ? value.explanation.trim() : "";
  return {
    status: "updated",
    ...(explanation ? { explanation } : {}),
    plan,
  };
}

export function formatUpdatePlanText(details: UpdatePlanDetails): string {
  const lines = ["Plan updated"];
  if (details.explanation) {
    lines.push(details.explanation);
  }
  for (const entry of details.plan) {
    const marker =
      entry.status === "completed" ? "[x]" : entry.status === "in_progress" ? "[~]" : "[ ]";
    lines.push(`- ${marker} ${entry.step}`);
  }
  return lines.join("\n");
}

/** Creates the session-scoped planning tool. It only returns structured state; it never writes files. */
export function createUpdatePlanTool(): AnyAgentTool {
  return {
    label: "Update Plan",
    name: UPDATE_PLAN_TOOL_NAME,
    description:
      "Update the current run plan. Use for non-trivial multi-step work; keep it current while executing. Short steps; max one in_progress; skip for simple one-step work.",
    parameters: UpdatePlanToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const explanation = readStringParam(params, "explanation");
      const plan = readPlanSteps(params);
      return {
        content: [],
        details: formatUpdatePlanDetails({ explanation, plan }),
      };
    },
  };
}

export const __testing = {
  readPlanSteps,
} as const;
