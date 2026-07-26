import { randomUUID } from "node:crypto";
import { requestExecApprovalDecision } from "../agents/bash-tools.exec-approval-request.js";
import type { GuiApprovalScope } from "./policy.js";

export type GuiApprovalOrigin = {
  agentId?: string;
  sessionKey?: string;
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

type ApprovalDecisionRequester = typeof requestExecApprovalDecision;

/**
 * Request one exact, foreground GUI mutation approval through the gateway.
 *
 * The scope is generated from freshly observed UI and never accepted from the
 * model. Only allow-once is honored because a standing approval is too broad
 * for credentials, purchases, software installs, and other sensitive surfaces.
 */
export async function requestGuiSensitiveApproval(params: {
  scope: GuiApprovalScope;
  reason: string;
  origin?: GuiApprovalOrigin;
  cwd?: string;
  requestDecision?: ApprovalDecisionRequester;
}): Promise<"allow-once" | "deny"> {
  const requestDecision = params.requestDecision ?? requestExecApprovalDecision;
  const scope = params.scope;
  const summary = [
    "gui-control sensitive action",
    `action=${scope.actionType}`,
    `runtime=${scope.runtimeName}`,
    `app=${JSON.stringify(scope.appName)}`,
    `window=${JSON.stringify(scope.windowTitle)}`,
    `control=${JSON.stringify(scope.selectedControl.join(" | ") || "(app-scoped)")}`,
    `risk=${JSON.stringify(scope.sensitiveTerms.join(", "))}`,
    `task=${JSON.stringify(scope.taskPolicyId)}`,
    `parameters=${JSON.stringify(scope.actionParameters)}`,
    `details=${JSON.stringify(scope.visibleTransactionDetails)}`,
    `context=${JSON.stringify(scope.visibleContextSummary)}`,
  ].join(" ");
  const decision = await requestDecision({
    id: randomUUID(),
    command: summary,
    commandArgv: ["gui-control", "sensitive-action", scope.actionType],
    cwd: params.cwd ?? process.cwd(),
    host: "gateway",
    security: "full",
    ask: "always",
    agentId: params.origin?.agentId,
    sessionKey: params.origin?.sessionKey,
    turnSourceChannel: params.origin?.channel,
    turnSourceTo: params.origin?.to,
    turnSourceAccountId: params.origin?.accountId,
    turnSourceThreadId: params.origin?.threadId,
    allowedDecisions: ["allow-once", "deny"],
  });
  return decision === "allow-once" ? "allow-once" : "deny";
}
