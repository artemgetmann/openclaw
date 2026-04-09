import type { MonitorRecord } from "./types.js";

export function isMonitorExpired(monitor: MonitorRecord, nowMs: number): boolean {
  if (!monitor.expiryAt?.trim()) {
    return false;
  }
  const parsed = Date.parse(monitor.expiryAt);
  return Number.isFinite(parsed) && nowMs >= parsed;
}

export function buildMonitorWakeMessage(params: {
  monitor: MonitorRecord;
  nowIso: string;
  wakeReason: string;
}) {
  const { monitor } = params;
  const lines = [
    `Monitor wake for ${monitor.monitorId}.`,
    "Resume the same monitor session and continue the same task.",
    `wakeReason: ${params.wakeReason}`,
    `wakeAt: ${params.nowIso}`,
    `sourceType: ${monitor.sourceType}`,
    `sourceTarget: ${JSON.stringify(monitor.sourceTarget)}`,
    `actionPolicy: ${monitor.actionPolicy}`,
    `status: ${monitor.status}`,
    ...(monitor.stopCondition?.trim() ? [`stopCondition: ${monitor.stopCondition.trim()}`] : []),
    ...(monitor.expiryAt?.trim() ? [`expiryAt: ${monitor.expiryAt.trim()}`] : []),
    ...(monitor.lastCheckpoint
      ? [`lastCheckpoint: ${JSON.stringify(monitor.lastCheckpoint)}`]
      : ["lastCheckpoint: none"]),
    "",
    "Use normal tools/skills to inspect fresh source state.",
    "Default behavior is notify + draft to the origin chat unless the original task explicitly authorized action on the watched surface.",
    "After a successful check, update the monitor checkpoint/status if needed before finishing.",
  ];
  return lines.join("\n");
}
