import type { OpenClawPluginApi } from "openclaw/plugin-sdk/telegram";

/** Binds generic subagent lifecycle events to the originating Telegram route. */
export function registerTelegramSubagentWorkingPresence(api: OpenClawPluginApi): void {
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
    if (event.runId) api.runtime.channel.telegram.workingPresence.stop(`subagent:${event.runId}`);
  });
  api.on("gateway_stop", () => api.runtime.channel.telegram.workingPresence.stopAll());
}
