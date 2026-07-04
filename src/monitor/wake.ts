import type { MonitorRecord } from "./types.js";

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveTelegramUserChat(monitor: MonitorRecord): string | undefined {
  if (monitor.sourceType.trim().toLowerCase() !== "telegram-user") {
    return undefined;
  }
  // Telegram-as-me delivery is tool-mediated, not a gateway delivery tuple.
  // The stable target is the source chat the telegram-user CLI can read/send.
  return (
    readOptionalString(monitor.sourceTarget.chat) ??
    readOptionalString(monitor.sourceTarget.to) ??
    readOptionalString(monitor.sourceTarget.target) ??
    readOptionalString(monitor.sourceTarget.chatId)
  );
}

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
  watchDeliveryConfigured?: boolean;
}) {
  const { monitor } = params;
  const watchDeliveryConfigured = params.watchDeliveryConfigured ?? Boolean(monitor.watchDelivery);
  const telegramUserChat = resolveTelegramUserChat(monitor);
  const lines = [
    `Wake the monitor for ${monitor.monitorId}.`,
    "Keep the same monitor session going and continue the same task in plain language.",
    `wakeReason: ${params.wakeReason}`,
    `wakeAt: ${params.nowIso}`,
    `sourceType: ${monitor.sourceType}`,
    `sourceTarget: ${JSON.stringify(monitor.sourceTarget)}`,
    `actionPolicy: ${monitor.actionPolicy}`,
    ...(monitor.originDelivery
      ? [`originDelivery: ${JSON.stringify(monitor.originDelivery)}`]
      : ["originDelivery: none"]),
    `status: ${monitor.status}`,
    ...(monitor.goal
      ? [
          `goalId: ${monitor.goal.id}`,
          `goalObjective: ${monitor.goal.objective}`,
          "The goal is the user-facing contract. This monitor is only the continuation mechanism.",
        ]
      : []),
    ...(monitor.stopCondition?.trim() ? [`stopCondition: ${monitor.stopCondition.trim()}`] : []),
    ...(monitor.expiryAt?.trim() ? [`expiryAt: ${monitor.expiryAt.trim()}`] : []),
    ...(monitor.lastCheckpoint
      ? [`lastCheckpoint: ${JSON.stringify(monitor.lastCheckpoint)}`]
      : ["lastCheckpoint: none"]),
    "",
    // The checkpoint is a baseline cursor, not a hidden workflow engine.
    "Interpret lastCheckpoint as previous state, not final authority over new inbound messages.",
    "If fresh source inspection finds a new actionable change after an older resolved-looking checkpoint, keep the monitor active and continue the task.",
    "Do not keep or re-mark the monitor completed solely because older checkpoint data looked settled.",
    "Use normal tools/skills to inspect fresh source state.",
    "Evaluate after this wake: done, keep going, blocked, needs user input, or needs approval.",
    "Do not mark the goal complete unless the stop condition is satisfied with evidence.",
    ...(monitor.actionPolicy === "auto_send"
      ? telegramUserChat && watchDeliveryConfigured
        ? [
            `Telegram-as-me watched-surface delivery is authorized and configured for chat ${telegramUserChat}.`,
            "For green-zone follow-ups, use the telegram-user skill/CLI to read the fresh chat state and send directly to that Telegram chat.",
            "If the other person proposes something outside the user's stated constraints, reject or push back while restating the allowed options directly in the Telegram chat; do not ask the user unless you are considering accepting the changed term.",
            "Immediately before every Telegram-as-me send, re-read the target chat and stop if a newer inbound message changes the context.",
            "After a successful Telegram-as-me send, update the monitor checkpoint/status and return exactly NO_REPLY.",
            "Do not also send the same green-zone reply to the origin chat.",
            "If the next step needs user input or approval, send the approval question to originDelivery with the message tool, then return exactly NO_REPLY.",
            "Do not send approval questions, private status, or monitor narration to the watched Telegram-as-me chat.",
          ]
        : watchDeliveryConfigured
          ? [
              "Watched-surface delivery is authorized and configured for this wake.",
              "For green-zone follow-ups, reply only with the exact content that should be sent to the watched surface.",
              "If the other person proposes something outside the user's stated constraints, reject or push back while restating the allowed options directly on the watched surface; do not ask the user unless you are considering accepting the changed term.",
              "Do not add monitoring summaries, labels, explanations, markdown, or 'Suggested reply' to watched-surface replies.",
              "If the next step needs user input or approval, send the approval question to originDelivery with the message tool, then return exactly NO_REPLY.",
              "Do not send approval questions, private status, or monitor narration to the watched surface.",
              "If no watched-surface reply should be sent on this wake, return exactly NO_REPLY.",
            ]
          : [
              "auto_send was requested, but no watched-surface delivery target is configured.",
              "Do not send on the watched surface until a watched-surface delivery target is configured.",
              "Report the missing delivery target through the origin chat instead.",
            ]
      : [
          "Default behavior is notify + draft to the origin chat unless the original task explicitly authorized action on the watched surface.",
          "Write the update like an assistant talking to the user: natural, concise, and ready to send.",
          "If you draft a reply, include the actual draft text in the origin-chat update before asking whether to send, edit, or stop watching.",
          "If the wake only needs a status update, report the status and next step without pretending there is a draft to send.",
          "Buttons are shortcuts only; the natural-language path is the real interface.",
        ]),
    "After a successful check, update the monitor checkpoint/status if needed before finishing.",
  ];
  return lines.join("\n");
}
