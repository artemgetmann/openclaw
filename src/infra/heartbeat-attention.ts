import type { HeartbeatAttentionStateEntry } from "../config/sessions/types.js";

const ATTENTION_OPEN = "<heartbeat_attention>";
const ATTENTION_CLOSE = "</heartbeat_attention>";
const MAX_PARSED_ITEMS = 9;
const MAX_STATE_ITEMS = 50;
const MAX_KEY_CHARS = 120;
const MAX_FINGERPRINT_CHARS = 240;
const MAX_TITLE_CHARS = 160;
const MAX_TEXT_CHARS = 4_000;

type HeartbeatAttentionUrgency = "normal" | "urgent";
type HeartbeatAttentionCategory = "commitment" | "build" | "outreach" | "personal" | "other";

export type HeartbeatAttentionDestination =
  | { kind: "pager" }
  | {
      kind: "telegram_topic";
      chatId: string;
      threadId: number;
    };

export type HeartbeatAttentionItem = {
  key: string;
  fingerprint: string;
  title: string;
  text: string;
  urgency: HeartbeatAttentionUrgency;
  category: HeartbeatAttentionCategory;
  destination: HeartbeatAttentionDestination;
};

export type HeartbeatAttentionEnvelope = {
  items: HeartbeatAttentionItem[];
};

export type HeartbeatTopicGroup = {
  chatId: string;
  threadId: number;
  items: HeartbeatAttentionItem[];
  text: string;
};

function readTrimmedString(value: unknown, maxChars: number, pattern?: RegExp): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxChars || (pattern && !pattern.test(trimmed))) {
    return undefined;
  }
  return trimmed;
}

function parseDestination(value: unknown): HeartbeatAttentionDestination | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (raw.kind === "pager") {
    return { kind: "pager" };
  }
  if (raw.kind !== "telegram_topic") {
    return undefined;
  }

  // Topic fan-out is intentionally limited to private Telegram supergroups. A model must
  // return concrete chat/thread metadata from a trusted source; usernames and guessed labels
  // fail closed to the configured pager path in the runner.
  const chatId = readTrimmedString(raw.chatId, 32, /^-100\d{5,}$/);
  const threadIdRaw =
    typeof raw.threadId === "number"
      ? raw.threadId
      : typeof raw.threadId === "string" && /^\d+$/.test(raw.threadId.trim())
        ? Number(raw.threadId.trim())
        : Number.NaN;
  if (!chatId || !Number.isSafeInteger(threadIdRaw) || threadIdRaw <= 0) {
    return undefined;
  }
  return { kind: "telegram_topic", chatId, threadId: threadIdRaw };
}

function parseItem(value: unknown): HeartbeatAttentionItem | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const key = readTrimmedString(raw.key, MAX_KEY_CHARS, /^[a-z0-9][a-z0-9._:-]{2,119}$/);
  const fingerprint = readTrimmedString(raw.fingerprint, MAX_FINGERPRINT_CHARS);
  const title = readTrimmedString(raw.title, MAX_TITLE_CHARS);
  const text = readTrimmedString(raw.text, MAX_TEXT_CHARS);
  const urgency = raw.urgency === "normal" || raw.urgency === "urgent" ? raw.urgency : undefined;
  const category =
    raw.category === "commitment" ||
    raw.category === "build" ||
    raw.category === "outreach" ||
    raw.category === "personal" ||
    raw.category === "other"
      ? raw.category
      : undefined;
  const destination = parseDestination(raw.destination);
  if (!key || !fingerprint || !title || !text || !urgency || !category || !destination) {
    return undefined;
  }
  return { key, fingerprint, title, text, urgency, category, destination };
}

export function parseHeartbeatAttentionEnvelope(text: string): HeartbeatAttentionEnvelope | null {
  const start = text.indexOf(ATTENTION_OPEN);
  const end = text.indexOf(ATTENTION_CLOSE);
  if (start < 0 || end <= start) {
    return null;
  }
  const json = text.slice(start + ATTENTION_OPEN.length, end).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const rawItems = (parsed as { items?: unknown }).items;
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > MAX_PARSED_ITEMS) {
    return null;
  }

  // Reject the entire envelope when any item is malformed. Partial acceptance could silently
  // omit the user's most important alert while making the heartbeat look successful.
  const items = rawItems.map(parseItem);
  if (items.some((item) => !item)) {
    return null;
  }
  const typedItems = items as HeartbeatAttentionItem[];
  if (new Set(typedItems.map((item) => item.key)).size !== typedItems.length) {
    return null;
  }
  return { items: typedItems };
}

function destinationLabel(destination: HeartbeatAttentionDestination): string {
  return destination.kind === "pager"
    ? "pager"
    : `telegram:${destination.chatId}:topic:${destination.threadId}`;
}

export function selectHeartbeatAttentionItems(params: {
  items: HeartbeatAttentionItem[];
  previous: HeartbeatAttentionStateEntry[] | undefined;
  maxItems?: number;
}): { items: HeartbeatAttentionItem[]; suppressedKeys: string[] } {
  const previousByKey = new Map((params.previous ?? []).map((entry) => [entry.key, entry]));
  const suppressedKeys: string[] = [];
  const changed = params.items.filter((item) => {
    const previous = previousByKey.get(item.key);
    const unchanged =
      previous?.fingerprint === item.fingerprint && previous.urgency === item.urgency;
    if (unchanged) {
      suppressedKeys.push(item.key);
      return false;
    }
    return true;
  });
  const maxItems = Math.max(1, Math.min(3, params.maxItems ?? 3));
  return { items: changed.slice(0, maxItems), suppressedKeys };
}

function renderTopicGroup(items: HeartbeatAttentionItem[]): string {
  if (items.length === 1) {
    return items[0]?.text ?? "";
  }
  return items.map((item, index) => `${index + 1}. ${item.title}\n${item.text}`).join("\n\n");
}

export function groupHeartbeatTopicItems(items: HeartbeatAttentionItem[]): HeartbeatTopicGroup[] {
  const groups = new Map<string, HeartbeatTopicGroup>();
  for (const item of items) {
    if (item.destination.kind !== "telegram_topic") {
      continue;
    }
    const groupKey = `${item.destination.chatId}:${item.destination.threadId}`;
    const existing = groups.get(groupKey);
    if (existing) {
      existing.items.push(item);
      existing.text = renderTopicGroup(existing.items);
      continue;
    }
    groups.set(groupKey, {
      chatId: item.destination.chatId,
      threadId: item.destination.threadId,
      items: [item],
      text: item.text,
    });
  }
  return [...groups.values()];
}

function buildTelegramTopicLink(chatId: string, threadId: number): string {
  return `https://t.me/c/${chatId.replace(/^-100/, "")}/${threadId}`;
}

function countWord(count: number): string {
  if (count === 1) {
    return "One";
  }
  if (count === 2) {
    return "Two";
  }
  return "Three";
}

export function buildHeartbeatPagerText(items: HeartbeatAttentionItem[]): string {
  const lines = items.map((item, index) => {
    if (item.destination.kind === "pager") {
      return `${index + 1}. ${item.title}\n${item.text}`;
    }
    const link = buildTelegramTopicLink(item.destination.chatId, item.destination.threadId);
    return `${index + 1}. ${item.title} — details in the task topic: ${link}`;
  });
  return `${countWord(items.length)} thing${items.length === 1 ? "" : "s"} need attention:\n\n${lines.join("\n\n")}`;
}

export function buildHeartbeatAttentionState(params: {
  previous: HeartbeatAttentionStateEntry[] | undefined;
  delivered: HeartbeatAttentionItem[];
  deliveredAt: number;
}): HeartbeatAttentionStateEntry[] {
  const deliveredKeys = new Set(params.delivered.map((item) => item.key));
  const next = params.delivered.map((item) => ({
    key: item.key,
    fingerprint: item.fingerprint,
    title: item.title,
    deliveredAt: params.deliveredAt,
    urgency: item.urgency,
    destination: destinationLabel(item.destination),
  }));
  for (const previous of params.previous ?? []) {
    if (!deliveredKeys.has(previous.key)) {
      next.push(previous);
    }
  }
  return next.toSorted((a, b) => b.deliveredAt - a.deliveredAt).slice(0, MAX_STATE_ITEMS);
}

export function buildHeartbeatAttentionPrompt(
  previous: HeartbeatAttentionStateEntry[] | undefined,
): string {
  const stateLines = (previous ?? [])
    .toSorted((a, b) => b.deliveredAt - a.deliveredAt)
    .slice(0, 12)
    .map(
      (entry) =>
        `- key=${entry.key} | fingerprint=${entry.fingerprint} | urgency=${entry.urgency} | title=${entry.title}`,
    );
  const priorState =
    stateLines.length > 0
      ? [
          "Previously delivered attention items:",
          ...stateLines,
          "Reuse the same key and fingerprint when the material facts are unchanged.",
        ].join("\n")
      : "Previously delivered attention items: none.";

  return [
    "Heartbeat attention delivery contract:",
    `If nothing genuinely needs attention, reply exactly HEARTBEAT_OK. Otherwise reply only with ${ATTENTION_OPEN}, one JSON object, and ${ATTENTION_CLOSE}.`,
    'The JSON shape is {"items":[{"key":"stable-lowercase-id","fingerprint":"stable-material-facts","title":"short title","text":"actionable detail","urgency":"normal|urgent","category":"commitment|build|outreach|personal|other","destination":{"kind":"pager"} OR {"kind":"telegram_topic","chatId":"-100...","threadId":123}}]}.',
    "Return a maximum of 3 items. Include only items that need the user's decision, approval, reply, or awareness now.",
    "Do not emit FYI updates, cleanup notes, unchanged blockers, or work the agent can safely continue itself.",
    "A key identifies the same real-world obligation across runs. A fingerprint identifies its material state. Do not change a fingerprint merely because wording changed.",
    "Use telegram_topic only when tools or trusted source context provide the exact Telegram supergroup chat id and topic/thread id. Never guess routing metadata. Otherwise use pager.",
    "Calendar commitments, personal messages, and cross-cutting items without a trusted task topic belong in pager.",
    "Respect quiet-hour, weekend, and category timing rules in HEARTBEAT.md. Urgent means an imminent commitment, hard deadline, or material financial/security risk—not merely important work.",
    "Exact scheduled reminders belong in cron, not in repeated heartbeat alerts.",
    priorState,
  ].join("\n");
}
