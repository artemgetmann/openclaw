import path from "node:path";
import { SessionManager, type SessionEntry as PiSessionEntry } from "@mariozechner/pi-coding-agent";
import { acquireSessionWriteLock } from "../agents/session-write-lock.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore, resolveSessionFilePath } from "../config/sessions.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import type { MonitorRecord } from "./types.js";

const ORIGIN_SYNC_CURSOR_TYPE = "monitor-origin-sync-cursor";
const ORIGIN_SYNC_MESSAGE_TYPE = "monitor-origin-sync";
export const MONITOR_RESULT_IDEMPOTENCY_PREFIX = "monitor-result:";
const MAX_SYNCED_ENTRIES_PER_WAKE = 20;
const MAX_SYNCED_TEXT_CHARS = 12_000;

type SyncCursorData = {
  monitorId?: unknown;
  originSessionKey?: unknown;
  sourceEntryId?: unknown;
  sourceTextOffset?: unknown;
};

type OriginSyncCursor = {
  sourceEntryId: string;
  sourceTextOffset: number;
};

export function resolveMonitorTranscriptPath(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}): string | null {
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
  const entry = loadSessionStore(storePath, { skipCache: true })[params.sessionKey];
  if (!entry?.sessionId) {
    return null;
  }
  return resolveSessionFilePath(entry.sessionId, entry, {
    agentId: params.agentId,
    sessionsDir: path.dirname(storePath),
  });
}

function readTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
      continue;
    }
    if (record.type === "image") {
      // Never duplicate inline image bytes into another durable transcript.
      // A stable non-data URL remains useful evidence; raw/base64 content does not.
      const url = typeof record.url === "string" ? record.url : undefined;
      parts.push(url && !url.startsWith("data:") ? `[image: ${url}]` : "[image attachment]");
    }
  }
  return parts.join("\n");
}

function isMonitorResultMirror(entry: PiSessionEntry): boolean {
  if (entry.type !== "message") {
    return false;
  }
  const key = (entry.message as { idempotencyKey?: unknown }).idempotencyKey;
  return typeof key === "string" && key.startsWith(MONITOR_RESULT_IDEMPOTENCY_PREFIX);
}

function formatSyncedMessage(entry: PiSessionEntry): string | null {
  if (entry.type !== "message" || isMonitorResultMirror(entry)) {
    return null;
  }
  const message = entry.message as { role?: unknown; content?: unknown };
  if (message.role !== "user" && message.role !== "assistant") {
    return null;
  }
  const text = readTextContent(message.content).trim();
  if (!text) {
    return null;
  }
  return `${message.role === "user" ? "User" : "Jarvis"}: ${text}`;
}

function findOriginCursor(params: {
  entries: PiSessionEntry[];
  monitorId: string;
  originSessionKey: string;
}): OriginSyncCursor | undefined {
  for (let index = params.entries.length - 1; index >= 0; index -= 1) {
    const entry = params.entries[index];
    if (entry?.type !== "custom" || entry.customType !== ORIGIN_SYNC_CURSOR_TYPE) {
      continue;
    }
    const data = entry.data as SyncCursorData | undefined;
    if (
      data?.monitorId === params.monitorId &&
      data.originSessionKey === params.originSessionKey &&
      typeof data.sourceEntryId === "string"
    ) {
      return {
        sourceEntryId: data.sourceEntryId,
        sourceTextOffset:
          typeof data.sourceTextOffset === "number" &&
          Number.isInteger(data.sourceTextOffset) &&
          data.sourceTextOffset > 0
            ? data.sourceTextOffset
            : 0,
      };
    }
  }
  return undefined;
}

export function recordMonitorOriginSyncCursor(params: {
  sessionManager: SessionManager;
  monitorId: string;
  originSessionKey: string;
  sourceEntryId: string | undefined;
  sourceTextOffset?: number;
}): void {
  if (!params.sourceEntryId) {
    return;
  }
  params.sessionManager.appendCustomEntry(ORIGIN_SYNC_CURSOR_TYPE, {
    monitorId: params.monitorId,
    originSessionKey: params.originSessionKey,
    sourceEntryId: params.sourceEntryId,
    ...(params.sourceTextOffset ? { sourceTextOffset: params.sourceTextOffset } : {}),
  });
}

async function acquireCurrentTranscript(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  abortSignal?: AbortSignal;
}): Promise<{
  originPath: string;
  lock: Awaited<ReturnType<typeof acquireSessionWriteLock>>;
} | null> {
  for (;;) {
    const originPath = resolveMonitorTranscriptPath(params);
    if (!originPath) {
      return null;
    }
    const lock = await acquireSessionWriteLock({
      sessionFile: originPath,
      // A normal live turn can legitimately take minutes. Queue behind it
      // instead of waking on stale instructions after an arbitrary deadline.
      timeoutMs: Number.POSITIVE_INFINITY,
      staleMs: Number.POSITIVE_INFINITY,
      blockReentrant: true,
      abortSignal: params.abortSignal,
    });
    // A reset can rotate the session mapping while this call waits. Never sync
    // the old transcript once a newer live conversation has become current.
    if (resolveMonitorTranscriptPath(params) === originPath) {
      return { originPath, lock };
    }
    await lock.release();
  }
}

/**
 * Pull live-chat turns written after monitor creation into the durable monitor
 * context. The source entry id is the cursor, and the target stores it only
 * after the bounded batch is attached to the current Pi parent chain.
 */
export async function syncOriginContextIntoMonitor(params: {
  cfg: OpenClawConfig;
  monitor: MonitorRecord;
  abortSignal?: AbortSignal;
}): Promise<{ ok: true; imported: number } | { ok: false; reason: string }> {
  let originLock: Awaited<ReturnType<typeof acquireSessionWriteLock>> | undefined;
  let monitorLock: Awaited<ReturnType<typeof acquireSessionWriteLock>> | undefined;
  try {
    // Read a completed origin turn, never the midpoint between its user and
    // assistant messages. The blocking mode also prevents a new live turn from
    // starting while this bounded snapshot advances its durable cursor.
    const lockedOrigin = await acquireCurrentTranscript({
      cfg: params.cfg,
      agentId: params.monitor.agentId,
      sessionKey: params.monitor.originSessionKey,
      abortSignal: params.abortSignal,
    });
    if (!lockedOrigin) {
      return { ok: false, reason: "origin or monitor transcript is unavailable" };
    }
    const { originPath } = lockedOrigin;
    originLock = lockedOrigin.lock;
    // Serialize the cursor read and both target appends with every other
    // monitor-session writer. All sync callers lock origin then monitor.
    const lockedMonitor = await acquireCurrentTranscript({
      cfg: params.cfg,
      agentId: params.monitor.agentId,
      sessionKey: params.monitor.monitorSessionKey,
      abortSignal: params.abortSignal,
    });
    if (!lockedMonitor) {
      return { ok: false, reason: "origin or monitor transcript is unavailable" };
    }
    const { originPath: monitorPath } = lockedMonitor;
    monitorLock = lockedMonitor.lock;
    const originManager = SessionManager.open(originPath);
    const monitorManager = SessionManager.open(monitorPath);
    const originBranch = originManager.getBranch();
    if (!originManager.getLeafId()) {
      return { ok: true, imported: 0 };
    }
    const cursor = findOriginCursor({
      entries: monitorManager.getEntries(),
      monitorId: params.monitor.monitorId,
      originSessionKey: params.monitor.originSessionKey,
    });
    const cursorIndex = cursor
      ? originBranch.findIndex((entry) => entry.id === cursor.sourceEntryId)
      : -1;
    // Forked monitors seed a cursor. Legacy/compacted transcripts degrade to
    // a bounded recent window instead of replaying an unbounded conversation.
    const candidates = originBranch.slice(
      cursorIndex >= 0
        ? cursorIndex + (cursor?.sourceTextOffset ? 0 : 1)
        : -MAX_SYNCED_ENTRIES_PER_WAKE,
    );
    const importedEntries: PiSessionEntry[] = [];
    const lines: string[] = [];
    let textChars = 0;
    let nextCursor = cursor;
    for (const entry of candidates.slice(0, MAX_SYNCED_ENTRIES_PER_WAKE)) {
      const formattedLine = formatSyncedMessage(entry);
      const resumeOffset = entry.id === cursor?.sourceEntryId ? cursor.sourceTextOffset : 0;
      const line = formattedLine?.slice(resumeOffset) ?? null;
      // Tool/state entries and mirrored monitor results deliberately add no
      // duplicate model-visible content, but still advance the source cursor.
      if (!line) {
        nextCursor = { sourceEntryId: entry.id, sourceTextOffset: 0 };
        continue;
      }
      const remainingChars = MAX_SYNCED_TEXT_CHARS - textChars;
      if (remainingChars <= 0) {
        break;
      }
      const boundedLine = line.slice(0, remainingChars);
      lines.push(boundedLine);
      importedEntries.push(entry);
      textChars += boundedLine.length;
      const remainingLineChars = line.length - boundedLine.length;
      nextCursor = {
        sourceEntryId: entry.id,
        sourceTextOffset: remainingLineChars > 0 ? resumeOffset + boundedLine.length : 0,
      };
      // A single very large turn resumes from its durable text offset. Later
      // entries remain pending behind that cursor for the next wake.
      if (remainingLineChars > 0 || textChars >= MAX_SYNCED_TEXT_CHARS) {
        break;
      }
    }
    if (lines.length > 0) {
      const content = [
        "New activity from the live origin conversation since the previous monitor wake:",
        ...lines,
      ].join("\n\n");
      monitorManager.appendCustomMessageEntry(ORIGIN_SYNC_MESSAGE_TYPE, content, false, {
        monitorId: params.monitor.monitorId,
        originSessionKey: params.monitor.originSessionKey,
        sourceEntryIds: importedEntries.map((entry) => entry.id),
      });
    }
    const cursorAdvanced =
      nextCursor?.sourceEntryId !== cursor?.sourceEntryId ||
      nextCursor?.sourceTextOffset !== cursor?.sourceTextOffset;
    if (cursorAdvanced) {
      recordMonitorOriginSyncCursor({
        sessionManager: monitorManager,
        monitorId: params.monitor.monitorId,
        originSessionKey: params.monitor.originSessionKey,
        sourceEntryId: nextCursor?.sourceEntryId,
        sourceTextOffset: nextCursor?.sourceTextOffset,
      });
    }
    if (lines.length > 0 || cursorAdvanced) {
      emitSessionTranscriptUpdate(monitorPath);
    }
    return { ok: true, imported: lines.length };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    await monitorLock?.release();
    await originLock?.release();
  }
}
