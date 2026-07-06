import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { expandHomePrefix } from "../infra/home-dir.js";
import {
  DEFAULT_MONITOR_STORE_PATH,
  loadMonitorStore,
  resolveMonitorStorePath,
} from "../monitor/store.js";
import type { MonitorEventEnvelope, MonitorRecord, MonitorSourceTarget } from "../monitor/types.js";
import { runTelegramUserRead } from "./backend.js";
import {
  buildTelegramUserMonitorEventEnvelope,
  pickTelegramUserMonitorMessage,
} from "./monitor-event.js";
import type {
  TelegramUserBackendOptions,
  TelegramUserMessage,
  TelegramUserReadResult,
} from "./types.js";

export const DEFAULT_TELEGRAM_USER_MONITOR_CURSOR_FILENAME = "telegram-user-listener-cursors.json";
const THREAD_SCOPED_MONITOR_READ_MAX_PAGES = 50;

export type TelegramUserMonitorCursor = {
  lastMessageId: number;
  sourceSignature: string;
  updatedAtMs: number;
};

export type TelegramUserMonitorCursorStoreFile = {
  version: 1;
  cursors: Record<string, TelegramUserMonitorCursor>;
};

export type TelegramUserMonitorPollDispatchContext = {
  chat: string;
  event: MonitorEventEnvelope;
  message: TelegramUserMessage;
  monitor: MonitorRecord;
};

export type TelegramUserMonitorPollEvent = TelegramUserMonitorPollDispatchContext & {
  dispatch?: unknown;
};

export type TelegramUserMonitorPollSkip = {
  monitorId: string;
  reason:
    | "missing_local_listener_trigger"
    | "missing_goal"
    | "missing_chat"
    | "read_error"
    | "dispatch_error";
  error?: string;
};

export type TelegramUserMonitorPollResult = {
  checked: number;
  cursorStorePath: string;
  dispatched: number;
  events: TelegramUserMonitorPollEvent[];
  skipped: TelegramUserMonitorPollSkip[];
  updatedCursors: number;
};

export type TelegramUserMonitorPollOptions = TelegramUserBackendOptions & {
  commitWithoutDispatch?: boolean;
  cronStorePath?: string;
  cursorStorePath?: string;
  dispatchEvent?: (context: TelegramUserMonitorPollDispatchContext) => Promise<unknown>;
  limit?: number;
  monitorStorePath?: string;
  nowMs?: number;
  readTelegramUser?: (params: {
    afterId: number;
    beforeId?: number;
    chat: string;
    contains?: string;
    envFile?: string | null;
    limit: number;
    session?: string | null;
  }) => Promise<TelegramUserReadResult>;
};

const serializedCursorStoreCache = new Map<string, string>();

function resolvePath(raw: string): string {
  return path.resolve(raw.startsWith("~") ? expandHomePrefix(raw) : raw);
}

export function resolveTelegramUserMonitorCursorStorePath(opts?: {
  cronStorePath?: string;
  cursorStorePath?: string;
  monitorStorePath?: string;
}): string {
  const explicit = opts?.cursorStorePath?.trim();
  if (explicit) {
    return resolvePath(explicit);
  }

  // Keep cursor state next to the monitor store so isolated cron stores, tests,
  // and runtime profiles do not accidentally share a Telegram read cursor.
  const monitorStorePath = opts?.monitorStorePath?.trim()
    ? resolveMonitorStorePath({ storePath: opts.monitorStorePath })
    : opts?.cronStorePath?.trim()
      ? resolveMonitorStorePath({ cronStorePath: opts.cronStorePath })
      : DEFAULT_MONITOR_STORE_PATH;
  return path.join(path.dirname(monitorStorePath), DEFAULT_TELEGRAM_USER_MONITOR_CURSOR_FILENAME);
}

export async function loadTelegramUserMonitorCursorStore(
  storePath: string,
): Promise<TelegramUserMonitorCursorStoreFile> {
  try {
    const raw = await fs.promises.readFile(storePath, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON5.parse(raw);
    } catch (err) {
      throw new Error(
        `Failed to parse Telegram monitor cursor store at ${storePath}: ${String(err)}`,
        {
          cause: err,
        },
      );
    }
    const record =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    const cursors =
      record.cursors && typeof record.cursors === "object" && !Array.isArray(record.cursors)
        ? (record.cursors as Record<string, TelegramUserMonitorCursor>)
        : {};
    const store = { version: 1 as const, cursors };
    serializedCursorStoreCache.set(storePath, JSON.stringify(store, null, 2));
    return store;
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      serializedCursorStoreCache.delete(storePath);
      return { version: 1, cursors: {} };
    }
    throw err;
  }
}

export async function saveTelegramUserMonitorCursorStore(
  storePath: string,
  store: TelegramUserMonitorCursorStoreFile,
): Promise<void> {
  const json = JSON.stringify(store, null, 2);
  if (serializedCursorStoreCache.get(storePath) === json) {
    return;
  }

  const storeDir = path.dirname(storePath);
  await fs.promises.mkdir(storeDir, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(storeDir, 0o700).catch(() => undefined);
  const tmp = `${storePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await fs.promises.writeFile(tmp, json, { encoding: "utf-8", mode: 0o600 });
  await fs.promises.chmod(tmp, 0o600).catch(() => undefined);
  await fs.promises.rename(tmp, storePath).catch(async (err) => {
    const code = (err as { code?: string }).code;
    if (code === "EPERM" || code === "EEXIST") {
      await fs.promises.copyFile(tmp, storePath);
      await fs.promises.unlink(tmp).catch(() => undefined);
      return;
    }
    throw err;
  });
  await fs.promises.chmod(storePath, 0o600).catch(() => undefined);
  serializedCursorStoreCache.set(storePath, json);
}

function readStringTarget(sourceTarget: MonitorSourceTarget, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = sourceTarget[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readNumberTarget(sourceTarget: MonitorSourceTarget, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = sourceTarget[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function hasTelegramUserLocalListenerTrigger(monitor: MonitorRecord): boolean {
  if (monitor.sourceType.trim().toLowerCase() !== "telegram-user") {
    return false;
  }
  if (monitor.trigger?.kind === "local_listener") {
    return true;
  }
  return monitor.trigger?.kind === "hybrid" && monitor.trigger.event.kind === "local_listener";
}

function getTelegramUserTriggerMatchTarget(
  monitor: MonitorRecord,
): MonitorSourceTarget | undefined {
  if (monitor.trigger?.kind === "local_listener") {
    return monitor.trigger.match?.sourceTarget;
  }
  if (monitor.trigger?.kind === "hybrid" && monitor.trigger.event.kind === "local_listener") {
    return monitor.trigger.event.match?.sourceTarget;
  }
  return undefined;
}

function getTelegramUserPollTarget(monitor: MonitorRecord): {
  accountId?: string;
  chat?: string;
  contains?: string;
  seed?: number;
  signature: string;
  threadAnchor?: number;
} {
  const matchTarget = getTelegramUserTriggerMatchTarget(monitor);
  const sourceTarget = monitor.sourceTarget;
  const routingTarget = matchTarget ?? sourceTarget;
  const chat = readStringTarget(routingTarget, ["chat", "chatId", "target", "to"]);
  const accountId = readStringTarget(routingTarget, ["accountId", "account"]);
  const threadAnchor = readNumberTarget(routingTarget, ["threadAnchor", "topicAnchor", "topicId"]);
  const contains = readStringTarget(sourceTarget, ["contains"]);
  const seed = readNumberTarget(sourceTarget, ["afterId", "lastMessageId", "messageId"]);

  // The signature resets the cursor when a monitor is repointed. Without it,
  // an old high message id from chat A could make chat B silently skip replies.
  const signature = JSON.stringify({
    accountId: accountId ?? "default",
    chat: chat ?? "",
    contains: contains ?? "",
    threadAnchor: threadAnchor ?? 0,
  });
  return { accountId, chat, contains, seed, signature, threadAnchor };
}

function cursorKeyForMonitor(monitor: MonitorRecord): string {
  // Per-monitor cursors cost a little more polling but avoid cross-monitor
  // starvation when two waits watch the same chat with different text filters.
  return `monitor:${monitor.monitorId}`;
}

function shouldPollMonitor(monitor: MonitorRecord): boolean {
  return (
    (monitor.status === "active" || monitor.status === "degraded") &&
    hasTelegramUserLocalListenerTrigger(monitor)
  );
}

function dispatchConfirmsMonitorWake(dispatch: unknown, monitorId: string): boolean {
  if (!dispatch || typeof dispatch !== "object" || Array.isArray(dispatch)) {
    return true;
  }
  const record = dispatch as Record<string, unknown>;
  const wakes = Array.isArray(record.wakes) ? record.wakes : undefined;
  if (wakes) {
    return wakes.some(
      (wake) =>
        wake &&
        typeof wake === "object" &&
        !Array.isArray(wake) &&
        (wake as Record<string, unknown>).monitorId === monitorId,
    );
  }
  if (typeof record.matched === "number") {
    return record.matched > 0;
  }
  return true;
}

async function readTelegramUserMonitorCandidateMessages(params: {
  afterId: number;
  chat: string;
  contains?: string;
  envFile?: string | null;
  limit: number;
  read: NonNullable<TelegramUserMonitorPollOptions["readTelegramUser"]>;
  session?: string | null;
  threadAnchor?: number;
}): Promise<TelegramUserReadResult> {
  const messages: TelegramUserMessage[] = [];
  let backendMeta: TelegramUserReadResult["backend_meta"];
  let beforeId: number | undefined;

  // Topic matching is applied locally because the Telegram backend exposes a
  // chat read primitive, not a topic read primitive. Page backward through the
  // newer-than-cursor window so a busy group cannot hide a valid topic reply
  // behind many off-topic messages.
  const maxPages =
    params.threadAnchor && params.threadAnchor > 0 ? THREAD_SCOPED_MONITOR_READ_MAX_PAGES : 1;
  for (let page = 0; page < maxPages; page += 1) {
    const readResult = await params.read({
      afterId: params.afterId,
      beforeId,
      chat: params.chat,
      // Topic scans need full pages. Backend text filtering can shrink a page
      // before we know whether older in-topic messages still need scanning.
      contains: params.threadAnchor && params.threadAnchor > 0 ? undefined : params.contains,
      envFile: params.envFile,
      limit: params.limit,
      session: params.session,
    });
    backendMeta ??= readResult.backend_meta;
    messages.push(...readResult.messages);

    if (readResult.messages.length < params.limit) {
      break;
    }

    const minMessageId = readResult.messages.reduce(
      (min, message) => Math.min(min, message.message_id),
      Number.POSITIVE_INFINITY,
    );
    if (!Number.isFinite(minMessageId) || minMessageId <= params.afterId + 1) {
      break;
    }
    beforeId = minMessageId;
  }

  return { ...(backendMeta ? { backend_meta: backendMeta } : {}), messages };
}

export async function pollTelegramUserMonitorEvents(
  opts: TelegramUserMonitorPollOptions,
): Promise<TelegramUserMonitorPollResult> {
  const monitorStorePath = resolveMonitorStorePath({
    cronStorePath: opts.cronStorePath,
    storePath: opts.monitorStorePath,
  });
  const cursorStorePath = resolveTelegramUserMonitorCursorStorePath({
    cronStorePath: opts.cronStorePath,
    cursorStorePath: opts.cursorStorePath,
    monitorStorePath,
  });
  const monitorStore = await loadMonitorStore(monitorStorePath);
  const cursorStore = await loadTelegramUserMonitorCursorStore(cursorStorePath);
  const read = opts.readTelegramUser ?? runTelegramUserRead;
  const limit = opts.limit ?? 80;
  const nowMs = opts.nowMs ?? Date.now();
  const events: TelegramUserMonitorPollEvent[] = [];
  const skipped: TelegramUserMonitorPollSkip[] = [];
  let updatedCursors = 0;

  for (const monitor of monitorStore.monitors) {
    if (!shouldPollMonitor(monitor)) {
      skipped.push({ monitorId: monitor.monitorId, reason: "missing_local_listener_trigger" });
      continue;
    }
    if (!monitor.goal) {
      skipped.push({ monitorId: monitor.monitorId, reason: "missing_goal" });
      continue;
    }

    const target = getTelegramUserPollTarget(monitor);
    if (!target.chat) {
      skipped.push({ monitorId: monitor.monitorId, reason: "missing_chat" });
      continue;
    }

    const cursorKey = cursorKeyForMonitor(monitor);
    const existingCursor = cursorStore.cursors[cursorKey];
    const afterId =
      existingCursor?.sourceSignature === target.signature
        ? existingCursor.lastMessageId
        : target.seed;

    let readResult: TelegramUserReadResult;
    try {
      readResult = await readTelegramUserMonitorCandidateMessages({
        afterId: afterId ?? 0,
        chat: target.chat,
        contains: afterId === undefined ? undefined : target.contains,
        envFile: opts.envFile,
        limit,
        read,
        session: opts.session,
        threadAnchor: afterId === undefined ? undefined : target.threadAnchor,
      });
    } catch (err) {
      skipped.push({ monitorId: monitor.monitorId, reason: "read_error", error: String(err) });
      continue;
    }

    if (afterId === undefined) {
      // A goal-bound monitor without an explicit seed starts by checkpointing
      // the current visible history. It must not convert old Telegram messages
      // into fresh monitor wakes merely because the listener came online.
      const latestMessageId = readResult.messages.reduce(
        (max, message) => Math.max(max, message.message_id),
        0,
      );
      cursorStore.cursors[cursorKey] = {
        lastMessageId: latestMessageId,
        sourceSignature: target.signature,
        updatedAtMs: nowMs,
      };
      updatedCursors += 1;
      continue;
    }

    const message = pickTelegramUserMonitorMessage(readResult.messages, {
      afterId,
      contains: target.contains,
      threadAnchor: target.threadAnchor,
    });
    if (!message) {
      continue;
    }

    const event = buildTelegramUserMonitorEventEnvelope(message, {
      accountId: target.accountId,
      chat: target.chat,
      nowMs,
    });

    let dispatch: unknown;
    if (opts.dispatchEvent) {
      try {
        dispatch = await opts.dispatchEvent({ chat: target.chat, event, message, monitor });
      } catch (err) {
        skipped.push({
          monitorId: monitor.monitorId,
          reason: "dispatch_error",
          error: String(err),
        });
        continue;
      }
      if (!dispatchConfirmsMonitorWake(dispatch, monitor.monitorId)) {
        skipped.push({
          monitorId: monitor.monitorId,
          reason: "dispatch_error",
          error: "dispatch did not confirm monitor wake",
        });
        continue;
      }
    } else if (!opts.commitWithoutDispatch) {
      events.push({ chat: target.chat, event, message, monitor });
      continue;
    }

    cursorStore.cursors[cursorKey] = {
      lastMessageId: Math.max(afterId, message.message_id),
      sourceSignature: target.signature,
      updatedAtMs: nowMs,
    };
    updatedCursors += 1;
    events.push({ chat: target.chat, dispatch, event, message, monitor });
  }

  if (updatedCursors > 0) {
    await saveTelegramUserMonitorCursorStore(cursorStorePath, cursorStore);
  }

  return {
    checked: monitorStore.monitors.length,
    cursorStorePath,
    dispatched: events.filter((event) => event.dispatch !== undefined).length,
    events,
    skipped,
    updatedCursors,
  };
}
