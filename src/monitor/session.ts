import { SessionManager } from "@mariozechner/pi-coding-agent";
import { prepareSessionManagerForRun } from "../agents/pi-embedded-runner/session-manager-init.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStorePath, updateSessionStore, type SessionEntry } from "../config/sessions.js";
import { resolveSessionTranscriptFile } from "../config/sessions/transcript.js";
import type { CronDelivery } from "../cron/types.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveTelegramUserChat(params: {
  sourceType: string;
  sourceTarget: Record<string, unknown>;
}): string | undefined {
  if (params.sourceType.trim().toLowerCase() !== "telegram-user") {
    return undefined;
  }
  // Telegram-as-me uses the CLI against a real MTProto chat. It cannot be
  // represented as a normal gateway channel/to delivery tuple.
  return (
    readOptionalString(params.sourceTarget.chat) ??
    readOptionalString(params.sourceTarget.to) ??
    readOptionalString(params.sourceTarget.target) ??
    readOptionalString(params.sourceTarget.chatId)
  );
}

function buildMonitorBootstrapPrompt(params: {
  instructions: string;
  sourceType: string;
  sourceTarget: Record<string, unknown>;
  cadence: unknown;
  stopCondition?: string;
  expiryAt?: string;
  actionPolicy: string;
  goal?: { id: string; objective: string };
  watchDeliveryConfigured: boolean;
  originSessionKey: string;
  originDelivery?: CronDelivery;
}) {
  const telegramUserChat = resolveTelegramUserChat({
    sourceType: params.sourceType,
    sourceTarget: params.sourceTarget,
  });
  // Seed the monitor session with the durable task contract once so later cron
  // wakes can stay tiny and resume the same conversation instead of
  // reconstructing monitor intent from scratch.
  const lines = [
    "You are a durable monitor task.",
    "Treat future wake messages as the same monitor session continuing the same task.",
    `Task: ${params.instructions.trim()}`,
    "",
    "Monitor metadata:",
    `- sourceType: ${params.sourceType}`,
    `- sourceTarget: ${JSON.stringify(params.sourceTarget)}`,
    `- cadence: ${JSON.stringify(params.cadence)}`,
    `- actionPolicy: ${params.actionPolicy}`,
    `- originSessionKey: ${params.originSessionKey}`,
    `- originDelivery: ${params.originDelivery ? JSON.stringify(params.originDelivery) : "none"}`,
    "- defaultRoute: origin chat",
    ...(params.goal
      ? [
          `- goalId: ${params.goal.id}`,
          `- goalObjective: ${params.goal.objective}`,
          "The goal is the user-facing contract. This monitor is only the continuation mechanism.",
        ]
      : []),
    ...(params.stopCondition?.trim() ? [`- stopCondition: ${params.stopCondition.trim()}`] : []),
    ...(params.expiryAt?.trim() ? [`- expiryAt: ${params.expiryAt.trim()}`] : []),
    "",
    "Use normal OpenClaw tools and skills to fetch fresh source state on each wake.",
    "Evaluate after each wake: done, keep going, blocked, needs user input, or needs approval.",
    "Do not mark the goal complete unless the stop condition is satisfied with evidence.",
    ...(params.actionPolicy === "auto_send"
      ? telegramUserChat && params.watchDeliveryConfigured
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
        : params.watchDeliveryConfigured
          ? [
              "Watched-surface delivery is authorized and configured for this monitor.",
              "For green-zone follow-ups, reply only with the exact content that should be sent to the watched surface.",
              "If the other person proposes something outside the user's stated constraints, reject or push back while restating the allowed options directly on the watched surface; do not ask the user unless you are considering accepting the changed term.",
              "Do not add monitoring summaries, labels, explanations, markdown, or 'Suggested reply' to watched-surface replies.",
              "If the next step needs user input or approval, send the approval question to originDelivery with the message tool, then return exactly NO_REPLY.",
              "Do not send approval questions, private status, or monitor narration to the watched surface.",
              "If no watched-surface reply should be sent on this wake, return exactly NO_REPLY.",
            ]
          : [
              "auto_send was requested, but no watched-surface delivery target is configured.",
              "Do not attempt autonomous delivery on the watched source until a watched-surface delivery target is configured.",
              "Report the missing delivery target through the origin chat instead.",
            ]
      : [
          "Do not treat the watched source as the default delivery destination.",
          "Write origin-chat updates like an assistant talking to the user: natural, concise, and ready to send.",
          "If you draft a reply, include the actual draft text in the origin-chat update before asking whether to send, edit, or stop watching.",
          "If the monitor only has a status update, report the status and next step without pretending there is a draft to send.",
          "Buttons are shortcuts only; the natural-language path is the real interface.",
        ]),
  ];
  return lines.join("\n");
}

export async function seedMonitorSession(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  label: string;
  instructions: string;
  sourceType: string;
  sourceTarget: Record<string, unknown>;
  cadence: unknown;
  stopCondition?: string;
  expiryAt?: string;
  actionPolicy: string;
  goal?: { id: string; objective: string };
  watchDeliveryConfigured: boolean;
  originSessionKey: string;
  originDelivery?: CronDelivery;
}) {
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
  const sessionStore: Record<string, SessionEntry> = {};
  const entry: SessionEntry = {
    sessionId: params.sessionId,
    updatedAt: Date.now(),
    label: params.label,
  };

  await updateSessionStore(storePath, (store) => {
    sessionStore[params.sessionKey] = store[params.sessionKey] = {
      ...store[params.sessionKey],
      ...entry,
    };
  });

  const resolved = await resolveSessionTranscriptFile({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionEntry: sessionStore[params.sessionKey],
    sessionStore,
    storePath,
    agentId: params.agentId,
  });
  const sessionFile = resolved.sessionFile;
  const hadSessionFile = await import("node:fs/promises").then((fs) =>
    fs
      .access(sessionFile)
      .then(() => true)
      .catch(() => false),
  );
  const sessionManager = SessionManager.open(sessionFile);
  await prepareSessionManagerForRun({
    sessionManager,
    sessionFile,
    hadSessionFile,
    sessionId: params.sessionId,
    cwd: process.cwd(),
  });
  sessionManager.appendMessage({
    role: "user",
    content: buildMonitorBootstrapPrompt({
      instructions: params.instructions,
      sourceType: params.sourceType,
      sourceTarget: params.sourceTarget,
      cadence: params.cadence,
      stopCondition: params.stopCondition,
      expiryAt: params.expiryAt,
      actionPolicy: params.actionPolicy,
      goal: params.goal,
      watchDeliveryConfigured: params.watchDeliveryConfigured,
      originSessionKey: params.originSessionKey,
      originDelivery: params.originDelivery,
    }),
    timestamp: Date.now(),
  });
  emitSessionTranscriptUpdate(sessionFile);
}
