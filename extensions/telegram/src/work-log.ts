import { resolveGlobalSingleton } from "../../../src/shared/global-singleton.js";
import type { TelegramInlineButtons } from "./button-types.js";

const WORK_LOG_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PROGRESS_ENTRIES = 12;
const MAX_PROGRESS_ENTRY_CHARS = 900;
const MAX_TOOL_NAMES = 4;

type TelegramWorkLogEntry = {
  id: string;
  progressEntries: string[];
  toolNames: string[];
  createdAt: number;
  expiresAt: number;
};

type TelegramWorkLogState = {
  nextId: number;
  entries: Map<string, TelegramWorkLogEntry>;
};

export type TelegramWorkLogCallback =
  | { action: "show"; id: string }
  | { action: "hide"; id: string };

export type TelegramWorkLogRender = {
  text: string;
  buttons: TelegramInlineButtons;
};

export type TelegramWorkLogReplyMarkup = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
};

const TELEGRAM_WORK_LOG_STATE_KEY = Symbol.for("openclaw.telegramWorkLogState");

const workLogState = resolveGlobalSingleton<TelegramWorkLogState>(
  TELEGRAM_WORK_LOG_STATE_KEY,
  () => ({
    nextId: 0,
    entries: new Map(),
  }),
);

function allocateWorkLogId(): string {
  workLogState.nextId = workLogState.nextId >= 999_999 ? 1 : workLogState.nextId + 1;
  return workLogState.nextId.toString(36);
}

function pruneExpiredWorkLogs(now = Date.now()) {
  for (const [id, entry] of workLogState.entries.entries()) {
    if (entry.expiresAt <= now) {
      workLogState.entries.delete(id);
    }
  }
}

function normalizeProgressEntry(input: string, maxChars: number): string {
  // Expanded Work Log entries are user-facing history, not compact telemetry.
  // Preserve meaningful internal newlines so plan/checklist progress stays
  // scannable instead of collapsing into one hard-to-read sentence. The cap is
  // intentionally roomy because plan snapshots often carry several checklist
  // rows; trimming them too aggressively makes the retained proof misleading.
  const normalized = input
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function normalizeProgressEntries(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const rawEntry of entries) {
    const entry = normalizeProgressEntry(rawEntry, MAX_PROGRESS_ENTRY_CHARS);
    if (!entry) {
      continue;
    }
    const key = entry.replace(/\s+/g, " ").toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(entry);
  }
  return normalized.slice(-MAX_PROGRESS_ENTRIES);
}

function formatToolName(rawName: string): string {
  const lower = rawName.trim().toLowerCase();
  if (!lower) {
    return "";
  }
  if (lower === "exec" || lower.includes("bash") || lower.includes("shell")) {
    return "Terminal";
  }
  if (lower.startsWith("browser") || lower.includes("chrome")) {
    return "Browser";
  }
  if (lower.includes("web_search")) {
    return "Web search";
  }
  if (lower.includes("web_fetch")) {
    return "Web fetch";
  }
  if (lower.includes("gmail") || lower.includes("email")) {
    return "Email";
  }
  if (lower.includes("telegram")) {
    return "Telegram";
  }
  if (lower.includes("calendar")) {
    return "Calendar";
  }
  if (lower.includes("memory")) {
    return "Memory";
  }
  if (lower.includes("message")) {
    return "Messages";
  }
  const firstSegment = lower.split(/[./:_-]+/).find(Boolean) ?? lower;
  return firstSegment.charAt(0).toUpperCase() + firstSegment.slice(1);
}

function normalizeToolNames(toolNames: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const rawName of toolNames ?? []) {
    const name = formatToolName(rawName);
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    normalized.push(name);
  }
  return normalized.slice(0, MAX_TOOL_NAMES);
}

function workLogButtons(entry: TelegramWorkLogEntry, expanded: boolean): TelegramInlineButtons {
  return [
    [
      {
        text: expanded ? "Hide" : "Show",
        callback_data: `wl:${entry.id}:${expanded ? "hide" : "show"}`,
      },
    ],
  ];
}

export function registerTelegramWorkLog(params: {
  progressEntries: readonly string[];
  toolNames?: readonly string[];
  now?: number;
}): TelegramWorkLogEntry | undefined {
  const progressEntries = normalizeProgressEntries(params.progressEntries);
  if (progressEntries.length === 0) {
    return undefined;
  }
  const now = params.now ?? Date.now();
  pruneExpiredWorkLogs(now);
  const entry: TelegramWorkLogEntry = {
    id: allocateWorkLogId(),
    progressEntries,
    toolNames: normalizeToolNames(params.toolNames),
    createdAt: now,
    expiresAt: now + WORK_LOG_TTL_MS,
  };
  workLogState.entries.set(entry.id, entry);
  return entry;
}

export function renderTelegramWorkLog(
  entry: TelegramWorkLogEntry,
  expanded: boolean,
): TelegramWorkLogRender {
  if (!expanded) {
    return {
      text: "Work log",
      buttons: workLogButtons(entry, false),
    };
  }
  return {
    text: ["Work log", ...entry.progressEntries].join("\n\n"),
    buttons: workLogButtons(entry, true),
  };
}

export function buildTelegramWorkLogReplyMarkup(
  render: TelegramWorkLogRender,
): TelegramWorkLogReplyMarkup {
  return {
    inline_keyboard: render.buttons.map((row) =>
      row.map((button) => ({
        text: button.text,
        callback_data: button.callback_data,
      })),
    ),
  };
}

export function parseTelegramWorkLogCallbackData(
  data: string,
): TelegramWorkLogCallback | undefined {
  const match = data.match(/^wl:([a-z0-9]+):(show|hide)$/i);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  return {
    id: match[1],
    action: match[2] === "show" ? "show" : "hide",
  };
}

export function getTelegramWorkLog(id: string, now = Date.now()): TelegramWorkLogEntry | undefined {
  pruneExpiredWorkLogs(now);
  return workLogState.entries.get(id);
}

export const __testing = {
  resetTelegramWorkLogsForTests() {
    workLogState.nextId = 0;
    workLogState.entries.clear();
  },
};
