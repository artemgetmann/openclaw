import { resolveAgentDir, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { compactEmbeddedPiSession, isEmbeddedPiRunActive } from "../../agents/pi-embedded.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  loadSessionStore,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveStorePath,
  type SessionEntry,
  type SessionSystemPromptReport,
} from "../../config/sessions.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { incrementCompactionCount } from "./session-updates.js";

const log = createSubsystemLogger("proactive-compaction");

// Keep enough room for one unusually large inbound turn, including attachments.
// The previous 85% threshold let a 72%-full live chat jump straight into an
// eight-minute reactive compaction when the next message contained two images.
export const PROACTIVE_COMPACTION_THRESHOLD_RATIO = 0.7;
export const PROACTIVE_COMPACTION_MIN_CONVERSATION_RATIO = 0.2;
export const PROACTIVE_COMPACTION_IDLE_DELAY_MS = 10_000;

type ProactiveCompactionDecisionReason =
  | "stale-token-count"
  | "below-threshold"
  | "insufficient-conversation-history"
  | "threshold-reached";

type ProactiveCompactionState =
  | { phase: "scheduled"; timer: ReturnType<typeof setTimeout>; generation: symbol }
  | { phase: "running"; abortController: AbortController; generation: symbol };

const STATE_KEY = Symbol.for("openclaw.proactiveCompactionState");
const globalState = globalThis as typeof globalThis & {
  [STATE_KEY]?: Map<string, ProactiveCompactionState>;
};
const states = (globalState[STATE_KEY] ??= new Map<string, ProactiveCompactionState>());

function normalizePositiveInt(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function estimateStaticPromptTokens(
  report?: Pick<SessionSystemPromptReport, "systemPrompt" | "tools">,
): number | undefined {
  if (!report) {
    return undefined;
  }
  // Character counts are deliberately estimated conservatively. Their only job
  // here is preventing a large static bootstrap from compacting a young chat.
  const chars = (report.systemPrompt?.chars ?? 0) + (report.tools?.schemaChars ?? 0);
  return chars > 0 ? Math.ceil(chars / 4) : undefined;
}

export function resolveProactiveCompactionDecision(params: {
  totalTokens?: number;
  totalTokensFresh?: boolean;
  contextTokens?: number;
  systemPromptReport?: Pick<SessionSystemPromptReport, "systemPrompt" | "tools">;
}): { shouldCompact: boolean; reason: ProactiveCompactionDecisionReason } {
  const totalTokens = normalizePositiveInt(params.totalTokens);
  const contextTokens = normalizePositiveInt(params.contextTokens);
  if (!params.totalTokensFresh || !totalTokens || !contextTokens) {
    return { shouldCompact: false, reason: "stale-token-count" };
  }
  if (totalTokens / contextTokens < PROACTIVE_COMPACTION_THRESHOLD_RATIO) {
    return { shouldCompact: false, reason: "below-threshold" };
  }

  const staticTokens = estimateStaticPromptTokens(params.systemPromptReport);
  if (staticTokens !== undefined) {
    const conversationTokens = Math.max(0, totalTokens - staticTokens);
    if (conversationTokens / contextTokens < PROACTIVE_COMPACTION_MIN_CONVERSATION_RATIO) {
      return { shouldCompact: false, reason: "insufficient-conversation-history" };
    }
  }
  return { shouldCompact: true, reason: "threshold-reached" };
}

function decisionForEntry(entry: SessionEntry | undefined) {
  return resolveProactiveCompactionDecision({
    totalTokens: entry?.totalTokens,
    totalTokensFresh: entry?.totalTokensFresh,
    contextTokens: entry?.contextTokens,
    systemPromptReport: entry?.systemPromptReport,
  });
}

export function scheduleProactiveCompactionAfterDelivery(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  messageChannel?: string;
  messageProvider?: string;
}): boolean {
  let storePath: string;
  let entry: SessionEntry | undefined;
  try {
    storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
    entry = loadSessionStore(storePath, { skipCache: true })[params.sessionKey];
  } catch (error) {
    // Delivery already succeeded. A maintenance read failure is diagnostic-only
    // and must not turn the Telegram update into a failed request.
    log.warn("proactive compaction scheduling failed", {
      sessionKey: params.sessionKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  if (!entry?.sessionId || !decisionForEntry(entry).shouldCompact) {
    return false;
  }

  // A newer delivery supersedes any older maintenance request for this session.
  cancelProactiveCompactionForIncomingTurn(params.sessionKey);
  const generation = Symbol(params.sessionKey);
  const deliveredSnapshot = {
    sessionId: entry.sessionId,
    updatedAt: entry.updatedAt,
  };
  const timer = setTimeout(() => {
    void runScheduledCompaction({ ...params, storePath, deliveredSnapshot, generation });
  }, PROACTIVE_COMPACTION_IDLE_DELAY_MS);
  timer.unref?.();
  states.set(params.sessionKey, { phase: "scheduled", timer, generation });
  return true;
}

async function runScheduledCompaction(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  messageChannel?: string;
  messageProvider?: string;
  storePath: string;
  deliveredSnapshot: { sessionId: string; updatedAt?: number };
  generation: symbol;
}): Promise<void> {
  const scheduled = states.get(params.sessionKey);
  if (scheduled?.phase !== "scheduled" || scheduled.generation !== params.generation) {
    return;
  }

  // Re-read at execution time. Any incoming turn changes updatedAt and invalidates
  // the snapshot, so maintenance never races ahead of user work.
  const store = loadSessionStore(params.storePath, { skipCache: true });
  const entry = store[params.sessionKey];
  if (
    entry?.sessionId !== params.deliveredSnapshot.sessionId ||
    entry.updatedAt !== params.deliveredSnapshot.updatedAt ||
    !decisionForEntry(entry).shouldCompact ||
    isEmbeddedPiRunActive(entry.sessionId)
  ) {
    states.delete(params.sessionKey);
    return;
  }

  const abortController = new AbortController();
  states.set(params.sessionKey, {
    phase: "running",
    abortController,
    generation: params.generation,
  });
  try {
    const sessionFile = resolveSessionFilePath(
      entry.sessionId,
      entry,
      resolveSessionFilePathOptions({ agentId: params.agentId, storePath: params.storePath }),
    );
    const result = await compactEmbeddedPiSession({
      sessionId: entry.sessionId,
      sessionKey: params.sessionKey,
      sessionFile,
      currentTokenCount: entry.totalTokens,
      workspaceDir: resolveAgentWorkspaceDir(params.cfg, params.agentId),
      agentDir: resolveAgentDir(params.cfg, params.agentId),
      config: params.cfg,
      provider: entry.modelProvider,
      model: entry.model,
      messageChannel: params.messageChannel,
      messageProvider: params.messageProvider,
      force: true,
      trigger: "proactive",
      abortSignal: abortController.signal,
    });
    if (result.ok && result.compacted) {
      const freshStore = loadSessionStore(params.storePath, { skipCache: true });
      await incrementCompactionCount({
        sessionEntry: freshStore[params.sessionKey],
        sessionStore: freshStore,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
        tokensAfter: result.result?.tokensAfter,
      });
    }
  } catch (error) {
    // Background maintenance must never fail the already-delivered user turn.
    log.warn("proactive compaction failed", {
      sessionKey: params.sessionKey,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    const current = states.get(params.sessionKey);
    if (current?.generation === params.generation) {
      states.delete(params.sessionKey);
    }
  }
}

export function cancelProactiveCompactionForIncomingTurn(
  sessionKey: string,
): "none" | "scheduled" | "running" {
  const current = states.get(sessionKey);
  if (!current) {
    return "none";
  }
  if (current.phase === "scheduled") {
    clearTimeout(current.timer);
    states.delete(sessionKey);
    return "scheduled";
  }
  current.abortController.abort();
  return "running";
}

export function resetProactiveCompactionStateForTests(): void {
  for (const [sessionKey, state] of states) {
    if (state.phase === "scheduled") {
      clearTimeout(state.timer);
    } else {
      state.abortController.abort();
    }
    states.delete(sessionKey);
  }
}
