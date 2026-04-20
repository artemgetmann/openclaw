import { isRecord } from "../utils.js";

export type ClaudeBridgeUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

export type ClaudeBridgeRawEvent = {
  type?: string;
  [key: string]: unknown;
};

export type ClaudeBridgeToolCallEvent = {
  id: string;
  name: string;
  arguments: unknown;
};

export type ClaudeBridgeToolResultEvent = {
  id: string;
  toolName?: string;
  text: string;
  isError: boolean;
};

function readTextDelta(value: unknown): string {
  if (!isRecord(value)) {
    return "";
  }
  const delta = isRecord(value.delta) ? value.delta : value;
  if (delta.type !== "text_delta") {
    return "";
  }
  return typeof delta.text === "string" ? delta.text : "";
}

function collectText(value: unknown): string {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => collectText(item)).join("");
  }
  if (!isRecord(value)) {
    return "";
  }
  if (typeof value.text === "string") {
    return value.text;
  }
  if (typeof value.content === "string") {
    return value.content;
  }
  if (Array.isArray(value.content)) {
    return value.content.map((item) => collectText(item)).join("");
  }
  if (isRecord(value.message)) {
    return collectText(value.message);
  }
  return "";
}

export function parseClaudeBridgeLine(raw: string): ClaudeBridgeRawEvent | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? (parsed as ClaudeBridgeRawEvent) : null;
  } catch {
    return null;
  }
}

export function collectClaudeBridgeText(value: unknown): string {
  return collectText(value).trim();
}

function normalizeBridgeJsonLikeValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value ?? {};
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return {};
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

function stringifyClaudeBridgeValue(value: unknown): string {
  const text = collectClaudeBridgeText(value);
  if (text) {
    return text;
  }
  if (typeof value === "string") {
    return value.trim();
  }
  if (value === undefined || value === null) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function pickNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

export function readClaudeBridgeToolCallEvent(
  event: ClaudeBridgeRawEvent,
): ClaudeBridgeToolCallEvent | undefined {
  const id = pickNonEmptyString(event.id, event.tool_call_id, event.toolUseId, event.tool_use_id);
  const name = pickNonEmptyString(event.name, event.tool_name, event.toolName);
  if (!id || !name) {
    return undefined;
  }

  return {
    id,
    name,
    arguments: normalizeBridgeJsonLikeValue(event.arguments ?? event.input ?? event.args),
  };
}

export function readClaudeBridgeToolResultEvent(
  event: ClaudeBridgeRawEvent,
): ClaudeBridgeToolResultEvent | undefined {
  const id = pickNonEmptyString(event.id, event.tool_call_id, event.toolUseId, event.tool_use_id);
  if (!id) {
    return undefined;
  }

  const text = stringifyClaudeBridgeValue(
    event.output ?? event.result ?? event.content ?? event.error,
  );
  const isError =
    event.is_error === true ||
    event.isError === true ||
    (typeof event.status === "string" && event.status.trim().toLowerCase() === "error") ||
    (event.error !== undefined && event.error !== null);

  return {
    id,
    toolName: pickNonEmptyString(event.tool_name, event.toolName, event.name),
    text,
    isError,
  };
}

export function isClaudeBridgeAssistantMessageStart(event: ClaudeBridgeRawEvent): boolean {
  if (event.type !== "stream_event" || !isRecord(event.event)) {
    return false;
  }
  if (event.event.type !== "message_start" || !isRecord(event.event.message)) {
    return false;
  }
  return event.event.message.role === "assistant";
}

export function readClaudeBridgeTextDelta(event: ClaudeBridgeRawEvent): string {
  if (event.type !== "stream_event" || !isRecord(event.event)) {
    return "";
  }
  if (event.event.type !== "content_block_delta") {
    return "";
  }
  return readTextDelta(event.event);
}

export function readClaudeBridgeUsage(rawUsage: unknown): ClaudeBridgeUsage | undefined {
  if (!isRecord(rawUsage)) {
    return undefined;
  }

  const pick = (key: string): number | undefined => {
    const value = rawUsage[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  };

  const input = pick("input_tokens") ?? pick("inputTokens");
  const output = pick("output_tokens") ?? pick("outputTokens");
  const cacheRead =
    pick("cache_read_input_tokens") ?? pick("cached_input_tokens") ?? pick("cacheRead");
  const cacheWrite = pick("cache_write_input_tokens") ?? pick("cacheWrite");
  const total = pick("total_tokens") ?? pick("total");

  if (!input && !output && !cacheRead && !cacheWrite && !total) {
    return undefined;
  }

  return { input, output, cacheRead, cacheWrite, total };
}
