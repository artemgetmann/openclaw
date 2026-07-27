import type { TelegramInlineButtons } from "./button-types.js";

const QUEUE_CALLBACK_PREFIX = "oqk:";
const STEER_CALLBACK_PREFIX = "oqs:";
const SETTLED_CALLBACK_PREFIX = "oqd:";
const DURABLE_ID_RE = /^[A-Za-z0-9_-]{16,48}$/;

export type TelegramQueueCallback =
  | { action: "queue"; durableId: string }
  | { action: "steer"; durableId: string }
  | { action: "settled"; durableId: string };

export function parseTelegramQueueCallback(data: string): TelegramQueueCallback | undefined {
  const normalized = data.trim();
  const candidates = [
    { prefix: QUEUE_CALLBACK_PREFIX, action: "queue" as const },
    { prefix: STEER_CALLBACK_PREFIX, action: "steer" as const },
    { prefix: SETTLED_CALLBACK_PREFIX, action: "settled" as const },
  ];
  for (const candidate of candidates) {
    if (!normalized.startsWith(candidate.prefix)) {
      continue;
    }
    const durableId = normalized.slice(candidate.prefix.length);
    if (!DURABLE_ID_RE.test(durableId)) {
      return undefined;
    }
    return { action: candidate.action, durableId };
  }
  return undefined;
}

export function buildTelegramQueuedButtons(durableId: string): TelegramInlineButtons {
  if (!DURABLE_ID_RE.test(durableId)) {
    throw new Error("Invalid durable follow-up id for Telegram callback");
  }
  return [
    [
      { text: "✓ Queue", callback_data: `${QUEUE_CALLBACK_PREFIX}${durableId}`, style: "success" },
      { text: "Steer", callback_data: `${STEER_CALLBACK_PREFIX}${durableId}` },
    ],
  ];
}

export function buildTelegramSteeredButtons(durableId: string): TelegramInlineButtons {
  if (!DURABLE_ID_RE.test(durableId)) {
    throw new Error("Invalid durable follow-up id for Telegram callback");
  }
  return [
    [
      {
        text: "✓ Steer",
        callback_data: `${SETTLED_CALLBACK_PREFIX}${durableId}`,
        style: "success",
      },
    ],
  ];
}
