import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { validateSessionId } from "../../config/sessions/paths.js";
import { normalizeAgentId } from "../../routing/session-key.js";

export const DURABLE_PLAN_FILE_POLICY_PROMPT =
  "Do not create a durable plan file for normal tasks. Use session/tool state only. " +
  "Create a durable plan file only after an explicit user request, or after asking and receiving approval for long, high-risk, or multi-day work. " +
  "Never store product plan state in /tmp.";

export type DurablePlanFileReason = "explicit_user_request" | "approved_long_running";

export type DurablePlanFileRequest =
  | {
      /**
       * The normal case is no durable file. This keeps update_plan as session-scoped
       * tool state unless the user explicitly changes the contract.
       */
      reason?: undefined;
      sessionId?: string;
      agentId?: string;
    }
  | {
      /**
       * explicit_user_request: the user asked for a durable plan artifact.
       * approved_long_running: Jarvis asked first and the user approved it.
       */
      reason: DurablePlanFileReason;
      sessionId: string;
      agentId?: string;
    };

export type DurablePlanFileDecision =
  | {
      enabled: false;
      reason: "not_requested";
    }
  | {
      enabled: true;
      reason: DurablePlanFileReason;
      agentId: string;
      sessionId: string;
      path: string;
    };

export type DurablePlanFilePolicyOptions = {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
};

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isTempPlanPath(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  // os.tmpdir() is not always /tmp on macOS, so check both the platform temp
  // root and literal /tmp. The product rule specifically calls out /tmp.
  return (
    resolved === path.resolve(os.tmpdir()) ||
    isPathInside(os.tmpdir(), resolved) ||
    resolved === path.resolve("/tmp") ||
    isPathInside("/tmp", resolved)
  );
}

function assertDurablePlanStateDirAllowed(stateDir: string): void {
  if (isTempPlanPath(stateDir)) {
    throw new Error("Durable plan files must not be stored in /tmp or a temp directory");
  }
}

export function resolveDurablePlanFilesDir(
  params: { agentId?: string } = {},
  options: DurablePlanFilePolicyOptions = {},
): string {
  const env = options.env ?? process.env;
  const stateDir = resolveStateDir(env, options.homedir);
  assertDurablePlanStateDirAllowed(stateDir);

  // Store durable plans next to the agent's session tree without mixing them
  // into transcripts. This keeps product state recoverable and agent-scoped.
  const agentId = normalizeAgentId(params.agentId);
  return path.join(stateDir, "agents", agentId, "plans");
}

export function resolveDurablePlanFilePath(
  params: { sessionId: string; agentId?: string },
  options: DurablePlanFilePolicyOptions = {},
): string {
  const safeSessionId = validateSessionId(params.sessionId);
  const plansDir = resolveDurablePlanFilesDir({ agentId: params.agentId }, options);
  const planPath = path.join(plansDir, `${safeSessionId}.plan.json`);
  if (isTempPlanPath(planPath)) {
    throw new Error("Durable plan files must not be stored in /tmp or a temp directory");
  }
  return planPath;
}

export function resolveDurablePlanFileDecision(
  request: DurablePlanFileRequest = {},
  options: DurablePlanFilePolicyOptions = {},
): DurablePlanFileDecision {
  if (!request.reason) {
    return { enabled: false, reason: "not_requested" };
  }

  const agentId = normalizeAgentId(request.agentId);
  const sessionId = validateSessionId(request.sessionId);
  return {
    enabled: true,
    reason: request.reason,
    agentId,
    sessionId,
    path: resolveDurablePlanFilePath({ agentId, sessionId }, options),
  };
}
