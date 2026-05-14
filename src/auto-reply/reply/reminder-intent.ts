import { parseDurationMs } from "../../cli/parse-duration.js";

export type ReminderIntent = {
  delayMs: number;
  task: string;
};

const REMINDER_INTENT_RE =
  /^\s*(?:please\s+)?(?:can you\s+)?remind me in\s+(.+?)\s+to\s+(.+?)\s*[.?!]*\s*$/i;

function normalizeDurationPhrase(raw: string): string {
  const compact = raw
    .trim()
    .toLowerCase()
    .replace(/[.?!,]+$/g, "")
    .replace(/\s+/g, "");
  return compact
    .replace(/(\d+(?:\.\d+)?)(milliseconds?|msecs?|ms)(?=\d|$)/g, "$1ms")
    .replace(/(\d+(?:\.\d+)?)(hours?|hrs?|hr|h)(?=\d|$)/g, "$1h")
    .replace(/(\d+(?:\.\d+)?)(minutes?|mins?|min|m)(?=\d|$)/g, "$1m")
    .replace(/(\d+(?:\.\d+)?)(seconds?|secs?|sec|s)(?=\d|$)/g, "$1s")
    .replace(/(\d+(?:\.\d+)?)(days?|day|d)(?=\d|$)/g, "$1d");
}

export function extractReminderIntent(text: string): ReminderIntent | null {
  const match = REMINDER_INTENT_RE.exec(text.trim());
  if (!match) {
    return null;
  }

  const durationText = match[1]?.trim();
  const taskText = match[2]
    ?.trim()
    .replace(/[.?!]+$/g, "")
    .trim();
  if (!durationText || !taskText) {
    return null;
  }

  try {
    const delayMs = parseDurationMs(normalizeDurationPhrase(durationText), { defaultUnit: "m" });
    if (!Number.isFinite(delayMs) || delayMs <= 0) {
      return null;
    }
    return {
      delayMs,
      task: taskText,
    };
  } catch {
    return null;
  }
}

export function buildReminderCronJob(intent: ReminderIntent, nowMs = Date.now()) {
  const reminderText = `Reminder: ${intent.task}`;
  return {
    name: reminderText,
    schedule: {
      kind: "at" as const,
      at: new Date(nowMs + intent.delayMs).toISOString(),
    },
    payload: {
      kind: "agentTurn" as const,
      message: reminderText,
    },
  };
}
