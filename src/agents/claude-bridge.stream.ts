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
