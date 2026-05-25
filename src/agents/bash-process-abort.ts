import { killProcessTree } from "../process/kill-tree.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import { listActiveSessions, markExited } from "./bash-process-registry.js";

export function abortProcessSessionsForScope(scopeKey?: string): number {
  const normalizedScope = scopeKey?.trim();
  if (!normalizedScope) {
    return 0;
  }
  const supervisor = getProcessSupervisor();
  let aborted = 0;

  for (const session of listActiveSessions()) {
    if (session.scopeKey !== normalizedScope && session.sessionKey !== normalizedScope) {
      continue;
    }
    const record = supervisor.getRecord(session.id);
    if (record && record.state !== "exited") {
      supervisor.cancel(session.id, "manual-cancel");
      aborted += 1;
      continue;
    }
    const pid = session.pid ?? session.child?.pid;
    if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) {
      continue;
    }
    killProcessTree(pid);
    markExited(session, null, "SIGKILL", "failed");
    aborted += 1;
  }

  return aborted;
}
