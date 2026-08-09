import type { OpenClawPluginApi } from "openclaw/plugin-sdk/telegram";

/** Binds generic subagent lifecycle events to the originating Telegram route. */
export function registerTelegramSubagentWorkingPresence(api: OpenClawPluginApi): void {
  // Reset/delete hooks identify a completion worker by child session key and
  // intentionally omit runId. Keep the small in-memory reverse index needed to
  // release every lease associated with that child at those terminal bounds.
  const runIdsByChildSessionKey = new Map<string, Set<string>>();
  const trackRun = (childSessionKey: string, runId: string) => {
    const runIds = runIdsByChildSessionKey.get(childSessionKey) ?? new Set<string>();
    runIds.add(runId);
    runIdsByChildSessionKey.set(childSessionKey, runIds);
  };
  const forgetRun = (childSessionKey: string, runId: string) => {
    const runIds = runIdsByChildSessionKey.get(childSessionKey);
    if (!runIds) return;
    runIds.delete(runId);
    if (runIds.size === 0) runIdsByChildSessionKey.delete(childSessionKey);
  };

  api.on("subagent_spawned", (event) => {
    const requester = event.requester;
    // Persistent session workers do not emit subagent_ended when a turn goes
    // idle, so only completion-mode runs currently have a safe stop boundary.
    if (event.mode !== "run" || requester?.channel !== "telegram" || !requester.to) return;
    const messageThreadId =
      typeof requester.threadId === "number"
        ? requester.threadId
        : requester.threadId != null
          ? Number.parseInt(String(requester.threadId), 10)
          : undefined;
    trackRun(event.childSessionKey, event.runId);
    // The child is already running when this hook fires. Never delay its
    // acceptance receipt on an optional Telegram network request.
    void api.runtime.channel.telegram.workingPresence
      .start({
        ownerId: `subagent:${event.runId}`,
        to: requester.to,
        accountId: requester.accountId,
        ...(Number.isFinite(messageThreadId) ? { messageThreadId } : {}),
      })
      .catch((error: unknown) => {
        api.logger.warn(`Could not start Telegram subagent working presence: ${String(error)}`);
      });
  });
  api.on("subagent_ended", (event) => {
    if (event.runId) {
      const trackedRunIds = runIdsByChildSessionKey.get(event.targetSessionKey);
      if (trackedRunIds?.has(event.runId)) {
        api.runtime.channel.telegram.workingPresence.stop(`subagent:${event.runId}`);
        forgetRun(event.targetSessionKey, event.runId);
        return;
      }
      // A successful steer restarts the child under a replacement runId but
      // does not emit another spawn hook. If the terminal runId is unknown for
      // this child, release the original tracked owner(s) as well as stopping
      // the reported ID defensively.
      if (trackedRunIds) {
        for (const trackedRunId of trackedRunIds) {
          api.runtime.channel.telegram.workingPresence.stop(`subagent:${trackedRunId}`);
        }
        runIdsByChildSessionKey.delete(event.targetSessionKey);
      }
      api.runtime.channel.telegram.workingPresence.stop(`subagent:${event.runId}`);
      return;
    }
    // Session reset/delete events carry only targetSessionKey. Stop every run
    // tracked for that child so a deferred completion handback cannot leave a
    // ghost Telegram activity pulse behind.
    const runIds = runIdsByChildSessionKey.get(event.targetSessionKey);
    if (!runIds) return;
    for (const runId of runIds) {
      api.runtime.channel.telegram.workingPresence.stop(`subagent:${runId}`);
    }
    runIdsByChildSessionKey.delete(event.targetSessionKey);
  });
  api.on("gateway_stop", () => {
    runIdsByChildSessionKey.clear();
    api.runtime.channel.telegram.workingPresence.stopAll();
  });
}
