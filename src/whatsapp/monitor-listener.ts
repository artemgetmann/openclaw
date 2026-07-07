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
import { buildWacliMonitorEventEnvelope } from "./monitor-event.js";
import {
  findLatestInboundReplyAcrossResolvedChats,
  type WacliReplyLookupResult,
} from "./wacli-reconciliation.js";

export const DEFAULT_WHATSAPP_MONITOR_CURSOR_FILENAME = "whatsapp-listener-cursors.json";

export type WhatsAppMonitorCursor = {
  lastMsgId: string | null;
  sourceSignature: string;
  updatedAtMs: number;
};

export type WhatsAppMonitorCursorStoreFile = {
  version: 1;
  cursors: Record<string, WhatsAppMonitorCursor>;
};

export type WhatsAppMonitorPollDispatchContext = {
  event: MonitorEventEnvelope;
  lookup: WacliReplyLookupResult;
  monitor: MonitorRecord;
  target: string;
};

export type WhatsAppMonitorPollEvent = WhatsAppMonitorPollDispatchContext & {
  dispatch?: unknown;
};

export type WhatsAppMonitorPollSkip = {
  monitorId: string;
  reason:
    | "missing_local_listener_trigger"
    | "missing_goal"
    | "missing_target"
    | "lookup_error"
    | "dispatch_error";
  error?: string;
};

export type WhatsAppMonitorPollResult = {
  checked: number;
  cursorStorePath: string;
  dispatched: number;
  events: WhatsAppMonitorPollEvent[];
  skipped: WhatsAppMonitorPollSkip[];
  updatedCursors: number;
};

export type WhatsAppMonitorPollOptions = {
  commitWithoutDispatch?: boolean;
  cronStorePath?: string;
  cursorStorePath?: string;
  dbPath: string;
  dispatchEvent?: (context: WhatsAppMonitorPollDispatchContext) => Promise<unknown>;
  lookupReply?: (params: {
    dbPath: string;
    seedMsgId?: string;
    target: string;
  }) => WacliReplyLookupResult;
  monitorStorePath?: string;
  nowMs?: number;
};

const serializedCursorStoreCache = new Map<string, string>();

function resolvePath(raw: string): string {
  return path.resolve(raw.startsWith("~") ? expandHomePrefix(raw) : raw);
}

export function resolveWhatsAppMonitorCursorStorePath(opts?: {
  cronStorePath?: string;
  cursorStorePath?: string;
  monitorStorePath?: string;
}): string {
  const explicit = opts?.cursorStorePath?.trim();
  if (explicit) {
    return resolvePath(explicit);
  }

  // Keep WhatsApp listener state beside the monitor store so isolated runtime
  // profiles and test stores cannot accidentally share a "last seen" cursor.
  const monitorStorePath = opts?.monitorStorePath?.trim()
    ? resolveMonitorStorePath({ storePath: opts.monitorStorePath })
    : opts?.cronStorePath?.trim()
      ? resolveMonitorStorePath({ cronStorePath: opts.cronStorePath })
      : DEFAULT_MONITOR_STORE_PATH;
  return path.join(path.dirname(monitorStorePath), DEFAULT_WHATSAPP_MONITOR_CURSOR_FILENAME);
}

export async function loadWhatsAppMonitorCursorStore(
  storePath: string,
): Promise<WhatsAppMonitorCursorStoreFile> {
  try {
    const raw = await fs.promises.readFile(storePath, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON5.parse(raw);
    } catch (err) {
      throw new Error(
        `Failed to parse WhatsApp monitor cursor store at ${storePath}: ${String(err)}`,
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
        ? (record.cursors as Record<string, WhatsAppMonitorCursor>)
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

export async function saveWhatsAppMonitorCursorStore(
  storePath: string,
  store: WhatsAppMonitorCursorStoreFile,
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

function hasWhatsAppLocalListenerTrigger(monitor: MonitorRecord): boolean {
  if (monitor.sourceType.trim().toLowerCase() !== "whatsapp") {
    return false;
  }
  if (monitor.trigger?.kind === "local_listener") {
    return true;
  }
  return monitor.trigger?.kind === "hybrid" && monitor.trigger.event.kind === "local_listener";
}

function getWhatsAppTriggerMatchTarget(monitor: MonitorRecord): MonitorSourceTarget | undefined {
  if (monitor.trigger?.kind === "local_listener") {
    return monitor.trigger.match?.sourceTarget;
  }
  if (monitor.trigger?.kind === "hybrid" && monitor.trigger.event.kind === "local_listener") {
    return monitor.trigger.event.match?.sourceTarget;
  }
  return undefined;
}

function getWhatsAppPollTarget(monitor: MonitorRecord): {
  accountId?: string;
  seed?: string;
  signature: string;
  target?: string;
} {
  const matchTarget = getWhatsAppTriggerMatchTarget(monitor);
  const sourceTarget = monitor.sourceTarget;
  const routingTarget = matchTarget ?? sourceTarget;
  const target = readStringTarget(routingTarget, ["target", "to", "chat", "chatId", "chatJid"]);
  const accountId = readStringTarget(routingTarget, ["accountId", "account"]);
  const seed = readStringTarget(sourceTarget, [
    "afterMsgId",
    "lastMsgId",
    "lastMessageId",
    "messageId",
  ]);

  // The signature invalidates stale cursors when a durable monitor is repointed
  // to another WhatsApp identity or account. Without this, a reused monitor id
  // could silently skip replies in the new chat.
  const signature = JSON.stringify({
    accountId: accountId ?? "default",
    seed: seed ?? "",
    target: target ?? "",
  });
  return { accountId, seed, signature, target };
}

function cursorKeyForMonitor(monitor: MonitorRecord): string {
  // Per-monitor cursors avoid starvation when two goal waits watch the same
  // WhatsApp chat but carry different goals or dispatch policies.
  return `monitor:${monitor.monitorId}`;
}

function shouldPollMonitor(monitor: MonitorRecord): boolean {
  return (
    (monitor.status === "active" || monitor.status === "degraded") &&
    hasWhatsAppLocalListenerTrigger(monitor)
  );
}

function dispatchConfirmsMonitorWake(dispatch: unknown, monitorId: string): boolean {
  if (!dispatch || typeof dispatch !== "object" || Array.isArray(dispatch)) {
    return true;
  }
  const record = dispatch as Record<string, unknown>;
  const wakes = Array.isArray(record.wakes) ? record.wakes : undefined;
  if (wakes) {
    return wakes.some((wake) => {
      if (!wake || typeof wake !== "object" || Array.isArray(wake)) {
        return false;
      }
      const wakeRecord = wake as Record<string, unknown>;
      if (wakeRecord.monitorId !== monitorId) {
        return false;
      }
      const enqueue =
        wakeRecord.enqueue &&
        typeof wakeRecord.enqueue === "object" &&
        !Array.isArray(wakeRecord.enqueue)
          ? (wakeRecord.enqueue as Record<string, unknown>)
          : undefined;
      // The gateway can match a monitor even when cron refuses to enqueue
      // because the job is already running or otherwise not runnable. Only mark
      // the WhatsApp reply seen once a run is actually queued or run inline.
      return enqueue?.ok === true && (enqueue.enqueued === true || enqueue.ran === true);
    });
  }
  if (typeof record.matched === "number") {
    return record.matched > 0;
  }
  return true;
}

function latestInboundSeedRelation(
  lookup: WacliReplyLookupResult,
  seedMsgId: string,
): "after" | "not_after" | "unknown" {
  const latestInbound = lookup.latestInboundReply;
  if (!latestInbound) {
    return "not_after";
  }

  const seedIndex = lookup.recentConversation.findIndex((turn) => turn.msgId === seedMsgId);
  const latestIndex = lookup.recentConversation.findIndex(
    (turn) => turn.msgId === latestInbound.msgId,
  );

  if (seedIndex >= 0 && latestIndex >= 0) {
    return latestIndex > seedIndex ? "after" : "not_after";
  }

  const seededOutbound =
    lookup.seedMessage?.msgId === seedMsgId
      ? lookup.seedMessage
      : lookup.continuity.lastOutboundReply?.msgId === seedMsgId
        ? lookup.continuity.lastOutboundReply
        : lookup.continuity.previousOutboundReply?.msgId === seedMsgId
          ? lookup.continuity.previousOutboundReply
          : null;
  if (seededOutbound) {
    if (latestInbound.ts > seededOutbound.ts) {
      return "after";
    }
    if (latestInbound.ts < seededOutbound.ts) {
      return "not_after";
    }
    // Across sibling chats there is no shared row order. Equal timestamps are
    // ambiguous, so do not checkpoint the inbound row as already seen.
    return "unknown";
  }

  // WhatsApp message ids are opaque strings, not reliable clocks. If the local
  // DB window cannot prove that the inbound row is newer than the explicit wait
  // seed, fail closed without committing; a later poll may resolve the seed
  // after the local DB sync catches up.
  return "unknown";
}

function commitCursor(params: {
  cursorStore: WhatsAppMonitorCursorStoreFile;
  cursorKey: string;
  lastMsgId: string | null;
  nowMs: number;
  sourceSignature: string;
}): void {
  params.cursorStore.cursors[params.cursorKey] = {
    lastMsgId: params.lastMsgId,
    sourceSignature: params.sourceSignature,
    updatedAtMs: params.nowMs,
  };
}

export async function pollWhatsAppMonitorEvents(
  opts: WhatsAppMonitorPollOptions,
): Promise<WhatsAppMonitorPollResult> {
  const monitorStorePath = resolveMonitorStorePath({
    cronStorePath: opts.cronStorePath,
    storePath: opts.monitorStorePath,
  });
  const cursorStorePath = resolveWhatsAppMonitorCursorStorePath({
    cronStorePath: opts.cronStorePath,
    cursorStorePath: opts.cursorStorePath,
    monitorStorePath,
  });
  const monitorStore = await loadMonitorStore(monitorStorePath);
  const cursorStore = await loadWhatsAppMonitorCursorStore(cursorStorePath);
  const lookupReply = opts.lookupReply ?? findLatestInboundReplyAcrossResolvedChats;
  const dbPath = resolvePath(opts.dbPath);
  const nowMs = opts.nowMs ?? Date.now();
  const events: WhatsAppMonitorPollEvent[] = [];
  const skipped: WhatsAppMonitorPollSkip[] = [];
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

    const target = getWhatsAppPollTarget(monitor);
    if (!target.target) {
      skipped.push({ monitorId: monitor.monitorId, reason: "missing_target" });
      continue;
    }

    let lookup: WacliReplyLookupResult;
    try {
      lookup = lookupReply({ dbPath, seedMsgId: target.seed, target: target.target });
    } catch (err) {
      skipped.push({ monitorId: monitor.monitorId, reason: "lookup_error", error: String(err) });
      continue;
    }

    const cursorKey = cursorKeyForMonitor(monitor);
    const existingCursor = cursorStore.cursors[cursorKey];
    const cursor =
      existingCursor?.sourceSignature === target.signature ? existingCursor : undefined;
    const baselineMsgId = cursor ? cursor.lastMsgId : (target.seed ?? undefined);
    const latestMsgId = lookup.latestInboundReply?.msgId ?? null;

    if (!cursor && target.seed === undefined) {
      // First listener run is a checkpoint, not a replay. If history already
      // has a latest inbound row, store it as seen. If no inbound row exists,
      // store null so the next real reply can wake the monitor.
      commitCursor({
        cursorStore,
        cursorKey,
        lastMsgId: latestMsgId,
        nowMs,
        sourceSignature: target.signature,
      });
      updatedCursors += 1;
      continue;
    }

    if (target.seed !== undefined) {
      const seedRelation = latestInboundSeedRelation(lookup, target.seed);
      if (seedRelation !== "after") {
        // Seeded waits mean "wake on replies after this outbound message."
        // Keep checking the seed relation even if an older cursor exists; local
        // WhatsApp DB sync can reveal stale pre-seed rows after the listener
        // has already started.
        continue;
      }
    }

    if (!lookup.latestInboundReply || baselineMsgId === lookup.latestInboundReply.msgId) {
      continue;
    }

    const event = buildWacliMonitorEventEnvelope(lookup, {
      accountId: target.accountId,
      nowMs,
    });

    let dispatch: unknown;
    if (opts.dispatchEvent) {
      try {
        dispatch = await opts.dispatchEvent({
          event,
          lookup,
          monitor,
          target: target.target,
        });
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
      events.push({ event, lookup, monitor, target: target.target });
      continue;
    }

    commitCursor({
      cursorStore,
      cursorKey,
      lastMsgId: lookup.latestInboundReply.msgId,
      nowMs,
      sourceSignature: target.signature,
    });
    updatedCursors += 1;
    events.push({ dispatch, event, lookup, monitor, target: target.target });
  }

  if (updatedCursors > 0) {
    await saveWhatsAppMonitorCursorStore(cursorStorePath, cursorStore);
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
