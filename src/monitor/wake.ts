import { buildMonitorAutonomyLines, buildMonitorNotificationLines } from "./prompt-contract.js";
import type { MonitorRecord } from "./types.js";

const CHECKPOINT_MEDIA_PLACEHOLDER = "[media reference omitted]";
const CHECKPOINT_LIMIT_PLACEHOLDER = "[checkpoint content omitted: wake prompt limit reached]";
const CHECKPOINT_MAX_RENDERED_CHARS = 16_000;
const CHECKPOINT_IMAGE_EXTENSIONS = "(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif|svg|ico)";
const CHECKPOINT_DATA_IMAGE_REGEX = /data:image\/[a-z0-9.+-]+(?:;[^,\s]*)?,[^\s"'`<>]*/giu;
// Match the runner's file-URL grammar exactly: spaces are valid until the image extension, while
// closing markers and ordinary prose after the extension remain untouched.
const CHECKPOINT_FILE_URL_IMAGE_REGEX = new RegExp(
  "file://[^<>\"'`\\]]+?\\." + CHECKPOINT_IMAGE_EXTENSIONS,
  "giu",
);
const CHECKPOINT_IMAGE_REFERENCE_REGEX = new RegExp(
  `(?:(?:file|https?):\\/\\/|[a-z]:[\\\\/]|\\\\\\\\|~\\/|\\.\\.?\\/|\\/)[^\\s"'<>\\]\\[(){}]*?\\.${CHECKPOINT_IMAGE_EXTENSIONS}(?:[?#][^\\s"'<>\\]\\[(){}]*)?`,
  "giu",
);
const CHECKPOINT_WHOLE_IMAGE_REFERENCE_REGEX = new RegExp(
  `^\\s*(?:(?:file|https?):\\/\\/|[a-z]:[\\\\/]|\\\\\\\\|~\\/|\\.\\.?\\/|\\/)[\\s\\S]*\\.${CHECKPOINT_IMAGE_EXTENSIONS}(?:[?#][^\\s]*)?\\s*$`,
  "iu",
);
const CHECKPOINT_STRUCTURED_IMAGE_REFERENCE_REGEX = new RegExp(
  `\\[(?:Image:\\s*source:|media attached(?:\\s+\\d+\\/\\d+)?:)\\s*[^\\]\\r\\n]*?\\.${CHECKPOINT_IMAGE_EXTENSIONS}[^\\]\\r\\n]*\\]`,
  "giu",
);

type CheckpointRenderState = {
  remainingChars: number;
  activeReferences: WeakSet<object>;
};

function replaceCheckpointMediaReferences(value: string): string {
  // Whole-value matching catches paths containing spaces. Inline matching keeps useful prose around
  // ordinary path/URL tokens while removing anything a prompt-image scanner could rehydrate.
  if (CHECKPOINT_WHOLE_IMAGE_REFERENCE_REGEX.test(value)) {
    return CHECKPOINT_MEDIA_PLACEHOLDER;
  }
  return (
    value
      // Mirror the runner's structured markers before token matching so paths with spaces cannot
      // survive as `[Image: source: ...]` or `[media attached: ...]` prompt references.
      .replace(CHECKPOINT_STRUCTURED_IMAGE_REFERENCE_REGEX, CHECKPOINT_MEDIA_PLACEHOLDER)
      .replace(CHECKPOINT_DATA_IMAGE_REGEX, CHECKPOINT_MEDIA_PLACEHOLDER)
      .replace(CHECKPOINT_FILE_URL_IMAGE_REGEX, CHECKPOINT_MEDIA_PLACEHOLDER)
      .replace(CHECKPOINT_IMAGE_REFERENCE_REGEX, CHECKPOINT_MEDIA_PLACEHOLDER)
  );
}

function takeCheckpointText(value: string, state: CheckpointRenderState): string {
  const safe = replaceCheckpointMediaReferences(value);
  const retained = safe.slice(0, Math.max(0, state.remainingChars));
  state.remainingChars -= retained.length;
  return retained.length < safe.length ? `${retained}${CHECKPOINT_LIMIT_PLACEHOLDER}` : retained;
}

function objectDeclaresImageContent(value: Record<string, unknown>): boolean {
  return [
    value.mimeType,
    value.mime_type,
    value.mediaType,
    value.media_type,
    value.contentType,
    value.content_type,
    value.type,
  ].some(
    (entry) =>
      typeof entry === "string" &&
      (entry.toLowerCase().startsWith("image/") || entry.trim().toLowerCase() === "image"),
  );
}

function isInlineImagePayload(key: string | undefined, parentDeclaresImage: boolean): boolean {
  if (!key) {
    return false;
  }
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (parentDeclaresImage && /^(?:data|content|payload|base64|b64json|bytes)$/.test(normalized)) {
    return true;
  }
  // `screenshotId` remains useful ordinary data; only explicit byte/content keys are removed.
  return (
    /(?:image|screenshot|photo|thumbnail)(?:data|content|payload|base64|bytes)$/.test(normalized) ||
    /^(?:data|content|payload|base64|bytes)(?:image|screenshot|photo|thumbnail)/.test(normalized)
  );
}

function sanitizeCheckpointValue(
  value: unknown,
  state: CheckpointRenderState,
  keyHint?: string,
  parentDeclaresImage = false,
): unknown {
  if (state.remainingChars <= 0) {
    return CHECKPOINT_LIMIT_PLACEHOLDER;
  }
  // Charge every visited node against the same global budget. This bounds wide and deeply nested
  // structures without separate depth, item, key, and node limits.
  state.remainingChars -= 8;

  // Payload keys are authoritative regardless of representation: base64 strings, byte arrays, and
  // serialized Buffer objects all describe the same image bytes and must stay out of wake prompts.
  if (isInlineImagePayload(keyHint, parentDeclaresImage)) {
    return CHECKPOINT_MEDIA_PLACEHOLDER;
  }
  if (typeof value === "string") {
    return takeCheckpointText(value, state);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (state.activeReferences.has(value)) {
    return "[checkpoint circular reference omitted]";
  }

  state.activeReferences.add(value);
  try {
    if (Array.isArray(value)) {
      const sanitized: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (state.remainingChars <= 0) {
          sanitized.push(CHECKPOINT_LIMIT_PLACEHOLDER);
          break;
        }
        sanitized.push(sanitizeCheckpointValue(value[index], state, keyHint, parentDeclaresImage));
      }
      return sanitized;
    }

    const source = value as Record<string, unknown>;
    // Image blocks commonly nest encoded bytes under `source`; once declared, image context stays
    // active for descendants so inner payload fields cannot become ordinary checkpoint data again.
    const declaresImage = parentDeclaresImage || objectDeclaresImageContent(source);
    const sanitized: Record<string, unknown> = {};
    for (const key in source) {
      if (!Object.hasOwn(source, key)) {
        continue;
      }
      if (state.remainingChars <= 0) {
        sanitized.__wakePromptOmitted = CHECKPOINT_LIMIT_PLACEHOLDER;
        break;
      }
      const safeKey = takeCheckpointText(key, state);
      sanitized[safeKey] = sanitizeCheckpointValue(source[key], state, key, declaresImage);
    }
    return sanitized;
  } finally {
    state.activeReferences.delete(value);
  }
}

function renderCheckpointForWake(checkpoint: Record<string, unknown>): string {
  try {
    // Half the hard output limit is used as traversal budget, leaving headroom for JSON punctuation
    // and escaping. The final check is the single authoritative bound.
    const sanitized = sanitizeCheckpointValue(checkpoint, {
      remainingChars: Math.floor(CHECKPOINT_MAX_RENDERED_CHARS / 2),
      activeReferences: new WeakSet<object>(),
    });
    const rendered = JSON.stringify(sanitized);
    return rendered.length <= CHECKPOINT_MAX_RENDERED_CHARS
      ? rendered
      : JSON.stringify({ checkpoint: CHECKPOINT_LIMIT_PLACEHOLDER });
  } catch {
    // Persisted checkpoints are JSON. Fail closed for invalid in-memory values such as throwing
    // getters; the monitor can still inspect fresh source state on this wake.
    return JSON.stringify({ checkpoint: "[checkpoint omitted: unable to render safely]" });
  }
}

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
      ? [`lastCheckpoint: ${renderCheckpointForWake(monitor.lastCheckpoint)}`]
      : ["lastCheckpoint: none"]),
    "",
    // The checkpoint is a baseline cursor, not a hidden workflow engine.
    "Interpret lastCheckpoint as previous state, not final authority over new inbound messages.",
    "If fresh source inspection finds a new actionable change after an older resolved-looking checkpoint, keep the monitor active and continue the task.",
    "Do not keep or re-mark the monitor completed solely because older checkpoint data looked settled.",
    "Use normal tools/skills to inspect fresh source state.",
    ...buildMonitorAutonomyLines(monitor.goal),
    ...buildMonitorNotificationLines({
      policy: monitor.notificationPolicy,
      state: monitor.notificationState,
    }),
    "Evaluate after this wake: done, keep going, blocked, needs user input, or needs approval.",
    "Do not mark the goal complete unless the stop condition is satisfied with evidence.",
    ...(monitor.actionPolicy === "auto_send" &&
    (!monitor.goal || monitor.goal.autonomy?.level === "act_within_scope")
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
              ...(monitor.goal?.autonomy?.level === "act_within_scope"
                ? [
                    "Only the delivery adapter is unavailable; the goal's act_within_scope autonomy remains intact.",
                    "Use an available normal tool or skill path for an allowed action when one exists, and preserve every approval-required boundary.",
                    "Do not use the unavailable adapter. If no authorized normal path exists, report that specific gap through the origin chat.",
                  ]
                : [
                    "Do not send on the watched surface until a watched-surface delivery target is configured.",
                    "Report the missing delivery target through the origin chat instead.",
                  ]),
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
