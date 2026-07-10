import { resolveSessionGoalAutonomy } from "../config/sessions/goals.js";
import { resolveMonitorNotificationPolicy } from "./notifications.js";
import type {
  MonitorGoalSnapshot,
  MonitorNotificationPolicy,
  MonitorNotificationState,
} from "./types.js";

export function buildMonitorAutonomyLines(goal: MonitorGoalSnapshot | undefined): string[] {
  if (!goal) {
    return [
      "No goal autonomy contract is bound. actionPolicy controls delivery only and does not grant broader authority.",
    ];
  }
  const autonomy = resolveSessionGoalAutonomy(goal);
  if (autonomy.level === "observe_only") {
    return [
      "Goal autonomy: observe_only.",
      "Inspect and report, but do not take external or consequential action unless the user explicitly approves it.",
    ];
  }
  return [
    "Goal autonomy: act_within_scope.",
    `Allowed actions: ${autonomy.allowedActions?.join("; ") || "none recorded"}`,
    `Approval required: ${autonomy.approvalRequired?.join("; ") || "anything outside the allowed actions"}`,
    "Use normal tools and skills to execute allowed in-scope actions. Ask the user only when an approval-required boundary is reached.",
  ];
}

export function buildMonitorNotificationLines(params: {
  policy?: MonitorNotificationPolicy;
  state?: MonitorNotificationState;
}): string[] {
  const policy = resolveMonitorNotificationPolicy(params.policy);
  const unchangedChecks = Math.max(0, params.state?.consecutiveUnchangedChecks ?? 0);
  return [
    "Poll cadence and notification cadence are independent.",
    `Notification state: ${unchangedChecks} consecutive successful unchanged checks; next unchanged check is ${unchangedChecks + 1}.`,
    `After inspection, call monitor.update with patch.notificationEvent set to unchanged, material_change, completion, user_input, approval_required, deadline_passed, or degraded. The gateway persists bounded quiet-tick state and returns notificationDecision.shouldNotify.`,
    `Successful unchanged checks before ${policy.unchangedNoticeAfterChecks} are silent; check ${policy.unchangedNoticeAfterChecks} produces one useful notice; later unchanged notices are limited to once per ${policy.unchangedReminderIntervalMs}ms until material change resets the sequence.`,
    "Material change, completion, user input, approval requirements, and degradation notify immediately.",
    "If notificationDecision.shouldNotify is false, return exactly NO_REPLY. If true, return only the useful user-facing update.",
    "If an SLA or response deadline has passed, report deadline_passed instead of unchanged and obey notificationDecision.nextAction: escalate_within_scope via normal tools/skills, or request_approval. Never turn it into another no-change report.",
  ];
}
