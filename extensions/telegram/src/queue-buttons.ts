import type { TelegramInlineButtons } from "./button-types.js";

const QUEUE_CALLBACK_PREFIX = "oqk:";
const STEER_CALLBACK_PREFIX = "oqs:";
const SETTLED_CALLBACK_PREFIX = "oqd:";
const DURABLE_ID_RE = /^[A-Za-z0-9_-]{16,48}$/;

/**
 * Give people one useful Telegram round trip to change the default action.
 * The durable queue remains authoritative while this process-local timer runs,
 * so a restart safely falls back to "After this" instead of losing input.
 */
export const TELEGRAM_AUTO_STEER_GRACE_MS = 3_000;
type PendingAutoSteer = {
  timer: ReturnType<typeof setTimeout>;
  state: "scheduled" | "in-flight";
};
const pendingAutoSteers = new Map<string, PendingAutoSteer>();

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
      { text: "After this", callback_data: `${QUEUE_CALLBACK_PREFIX}${durableId}` },
      {
        text: "✓ Use now",
        callback_data: `${STEER_CALLBACK_PREFIX}${durableId}`,
        style: "success",
      },
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
        text: "✓ Using now",
        callback_data: `${SETTLED_CALLBACK_PREFIX}${durableId}`,
        style: "success",
      },
    ],
  ];
}

export function buildTelegramDeferredButtons(durableId: string): TelegramInlineButtons {
  if (!DURABLE_ID_RE.test(durableId)) {
    throw new Error("Invalid durable follow-up id for Telegram callback");
  }
  return [
    [
      {
        text: "✓ After this",
        callback_data: `${SETTLED_CALLBACK_PREFIX}${durableId}`,
        style: "success",
      },
    ],
  ];
}

export function scheduleTelegramAutoSteer(
  durableId: string,
  run: () => Promise<void> | void,
  delayMs = TELEGRAM_AUTO_STEER_GRACE_MS,
): void {
  cancelTelegramAutoSteer(durableId);
  const timer = setTimeout(() => {
    const pending = pendingAutoSteers.get(durableId);
    if (!pending || pending.timer !== timer) {
      return;
    }
    // Keep the entry until promotion settles. A late Telegram callback can now
    // distinguish "still cancellable" from "already accepted for steering."
    pending.state = "in-flight";
    void Promise.resolve(run())
      .catch(() => {
        // The durable follow-up remains queued if promotion or receipt editing
        // fails. Transport logging belongs to the caller, which has route context.
      })
      .finally(() => {
        if (pendingAutoSteers.get(durableId) === pending) {
          pendingAutoSteers.delete(durableId);
        }
      });
  }, delayMs);
  timer.unref?.();
  pendingAutoSteers.set(durableId, { timer, state: "scheduled" });
}

export type CancelTelegramAutoSteerResult = "cancelled" | "in-flight" | "missing";

export function cancelTelegramAutoSteer(durableId: string): CancelTelegramAutoSteerResult {
  const pending = pendingAutoSteers.get(durableId);
  if (!pending) {
    return "missing";
  }
  if (pending.state === "in-flight") {
    return "in-flight";
  }
  clearTimeout(pending.timer);
  pendingAutoSteers.delete(durableId);
  return "cancelled";
}

export const __testing = {
  resetAutoSteers(): void {
    for (const pending of pendingAutoSteers.values()) {
      clearTimeout(pending.timer);
    }
    pendingAutoSteers.clear();
  },
};
