import fs from "node:fs/promises";
import path from "node:path";
import {
  resolveDailyResetAtMs,
  resolveSessionFilePath,
  resolveStoredSessionMemoryScope,
  type SessionEntry,
} from "../../config/sessions.js";

const STATE_DIRNAME = ".openclaw";
const STATE_FILENAME = "daily-memory-rollover-state.json";
const STATE_VERSION = 1;
const MAX_MESSAGES_PER_SESSION = 12;
const MAX_TEXT_CHARS = 240;

type DailyMemoryRolloverState = {
  version: typeof STATE_VERSION;
  agents?: Record<string, { lastSnapshotDate?: string }>;
};

type DailyWindow = {
  startMs: number;
  endMs: number;
  targetDateKey: string;
};

type DailyExcerpt = {
  timestamp: number;
  role: string;
  text: string;
};

function formatLocalDateKey(nowMs: number): string {
  const date = new Date(nowMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function resolveDailyWindow(nowMs: number, atHour: number): DailyWindow {
  const endMs = resolveDailyResetAtMs(nowMs, atHour);
  const startDate = new Date(endMs);
  startDate.setDate(startDate.getDate() - 1);
  const startMs = startDate.getTime();
  return {
    startMs,
    endMs,
    targetDateKey: formatLocalDateKey(startMs),
  };
}

function formatLocalClock(nowMs: number): string {
  const date = new Date(nowMs);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function sanitizeExcerptText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_TEXT_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_TEXT_CHARS - 1).trimEnd()}…`;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const candidate = (entry as { text?: unknown }).text;
      return typeof candidate === "string" ? [candidate] : [];
    })
    .join("\n");
}

function parseMessageTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

async function readRolloverState(workspaceDir: string): Promise<DailyMemoryRolloverState> {
  const statePath = path.join(workspaceDir, STATE_DIRNAME, STATE_FILENAME);
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw) as DailyMemoryRolloverState;
    if (!parsed || typeof parsed !== "object") {
      return { version: STATE_VERSION };
    }
    return {
      version: STATE_VERSION,
      agents: parsed.agents && typeof parsed.agents === "object" ? parsed.agents : {},
    };
  } catch {
    return { version: STATE_VERSION };
  }
}

async function writeRolloverState(
  workspaceDir: string,
  state: DailyMemoryRolloverState,
): Promise<void> {
  const stateDir = path.join(workspaceDir, STATE_DIRNAME);
  const statePath = path.join(stateDir, STATE_FILENAME);
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

async function dailyFileContainsMarker(filePath: string, marker: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return raw.includes(marker);
  } catch {
    return false;
  }
}

async function collectSessionExcerpts(params: {
  sessionEntry: SessionEntry;
  agentId: string;
  sessionsDir: string;
  window: DailyWindow;
}): Promise<DailyExcerpt[]> {
  const sessionFile = resolveSessionFilePath(params.sessionEntry.sessionId, params.sessionEntry, {
    agentId: params.agentId,
    sessionsDir: params.sessionsDir,
  });
  try {
    const raw = await fs.readFile(sessionFile, "utf-8");
    const excerpts: DailyExcerpt[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as {
          type?: string;
          timestamp?: unknown;
          message?: {
            role?: unknown;
            content?: unknown;
          };
        };
        if (parsed.type !== "message") {
          continue;
        }
        const role = typeof parsed.message?.role === "string" ? parsed.message.role : "";
        if (role !== "user" && role !== "assistant") {
          continue;
        }
        const timestamp = parseMessageTimestamp(parsed.timestamp);
        if (
          timestamp == null ||
          timestamp < params.window.startMs ||
          timestamp >= params.window.endMs
        ) {
          continue;
        }
        const text = sanitizeExcerptText(extractTextContent(parsed.message?.content));
        if (!text) {
          continue;
        }
        excerpts.push({ timestamp, role, text });
        if (excerpts.length >= MAX_MESSAGES_PER_SESSION) {
          break;
        }
      } catch {
        continue;
      }
    }
    return excerpts;
  } catch {
    return [];
  }
}

function buildDailySnapshotBlock(params: {
  agentId: string;
  window: DailyWindow;
  groupedExcerpts: Array<{
    label: string;
    sessionKey: string;
    excerpts: DailyExcerpt[];
  }>;
}): string {
  const marker = `<!-- openclaw-daily-rollover:${params.agentId}:${params.window.targetDateKey} -->`;
  const lines: string[] = [
    marker,
    `## Auto Snapshot ${params.window.targetDateKey}`,
    "",
    `Window: ${new Date(params.window.startMs).toISOString()} -> ${new Date(params.window.endMs).toISOString()}`,
    "",
  ];

  for (const group of params.groupedExcerpts) {
    lines.push(`### ${group.label}`);
    lines.push(`Session: \`${group.sessionKey}\``);
    lines.push("");
    for (const excerpt of group.excerpts) {
      lines.push(`- [${formatLocalClock(excerpt.timestamp)}] ${excerpt.role}: ${excerpt.text}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

async function appendDailySnapshot(params: {
  workspaceDir: string;
  agentId: string;
  window: DailyWindow;
  groupedExcerpts: Array<{
    label: string;
    sessionKey: string;
    excerpts: DailyExcerpt[];
  }>;
}): Promise<void> {
  const memoryDir = path.join(params.workspaceDir, "memory");
  const filePath = path.join(memoryDir, `${params.window.targetDateKey}.md`);
  const marker = `<!-- openclaw-daily-rollover:${params.agentId}:${params.window.targetDateKey} -->`;
  if (await dailyFileContainsMarker(filePath, marker)) {
    return;
  }

  await fs.mkdir(memoryDir, { recursive: true });
  const exists = await fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
  const prefix = exists ? "\n\n" : `# Daily Memory ${params.window.targetDateKey}\n\n`;
  const block = buildDailySnapshotBlock(params);
  await fs.appendFile(filePath, `${prefix}${block}`, "utf-8");
}

export async function maybeRunDailyMemoryRollover(params: {
  workspaceDir: string;
  agentId: string;
  storePath: string;
  sessionKey: string;
  sessionEntry?: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  atHour: number;
  nowMs: number;
}): Promise<{ shouldRotateSession: boolean; snapshotDateKey?: string }> {
  const window = resolveDailyWindow(params.nowMs, params.atHour);
  const shouldRotateSession =
    typeof params.sessionEntry?.updatedAt === "number" &&
    params.sessionEntry.updatedAt < window.endMs;
  const state = await readRolloverState(params.workspaceDir);
  const agentState = state.agents?.[params.agentId];
  if (agentState?.lastSnapshotDate === window.targetDateKey) {
    return {
      shouldRotateSession,
      snapshotDateKey: window.targetDateKey,
    };
  }

  const sessionsDir = path.dirname(params.storePath);
  const groupedExcerpts: Array<{
    label: string;
    sessionKey: string;
    excerpts: DailyExcerpt[];
  }> = [];
  const seenSessionIds = new Set<string>();

  // Aggregate across every personal session for the agent so topic/thread memory
  // survives cross-chat. Shared sessions are intentionally excluded from this lane.
  for (const [sessionKey, entry] of Object.entries(params.sessionStore)) {
    if (!entry?.sessionId || seenSessionIds.has(entry.sessionId)) {
      continue;
    }
    if (resolveStoredSessionMemoryScope(entry) !== "personal") {
      continue;
    }
    seenSessionIds.add(entry.sessionId);
    const excerpts = await collectSessionExcerpts({
      sessionEntry: entry,
      agentId: params.agentId,
      sessionsDir,
      window,
    });
    if (excerpts.length === 0) {
      continue;
    }
    groupedExcerpts.push({
      sessionKey,
      label: entry.displayName?.trim() || entry.subject?.trim() || sessionKey,
      excerpts,
    });
  }

  if (groupedExcerpts.length > 0) {
    await appendDailySnapshot({
      workspaceDir: params.workspaceDir,
      agentId: params.agentId,
      window,
      groupedExcerpts,
    });
  }

  const nextState: DailyMemoryRolloverState = {
    version: STATE_VERSION,
    agents: {
      ...state.agents,
      [params.agentId]: {
        lastSnapshotDate: window.targetDateKey,
      },
    },
  };
  await writeRolloverState(params.workspaceDir, nextState);
  return {
    shouldRotateSession,
    snapshotDateKey: window.targetDateKey,
  };
}
