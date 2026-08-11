import crypto from "node:crypto";
import fs from "node:fs";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js";
import { clearCliSessionId } from "../../agents/cli-session.js";
import { estimateMessagesTokens } from "../../agents/compaction.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import { resolveSandboxConfigForAgent, resolveSandboxRuntimeStatus } from "../../agents/sandbox.js";
import {
  derivePromptTokens,
  hasNonzeroUsage,
  normalizeUsage,
  type UsageLike,
} from "../../agents/usage.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveAgentIdFromSessionKey,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  type SessionEntry,
  updateSessionStoreEntry,
} from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import type { TemplateContext } from "../templating.js";
import type { VerboseLevel } from "../thinking.js";
import type { GetReplyOptions } from "../types.js";
import {
  buildEmbeddedRunExecutionParams,
  resolveModelFallbackOptions,
} from "./agent-runner-utils.js";
import {
  hasAlreadyFlushedForCurrentCompaction,
  resolveMemoryFlushContextWindowTokens,
  resolveMemoryFlushRelativePathForRun,
  resolveMemoryFlushPromptForRun,
  resolveMemoryFlushSettings,
  shouldRunMemoryFlush,
} from "./memory-flush.js";
import type { FollowupRun } from "./queue.js";
import { incrementCompactionCount } from "./session-updates.js";

export function estimatePromptTokensForMemoryFlush(prompt?: string): number | undefined {
  const trimmed = prompt?.trim();
  if (!trimmed) {
    return undefined;
  }
  const message: AgentMessage = { role: "user", content: trimmed, timestamp: Date.now() };
  const tokens = estimateMessagesTokens([message]);
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return undefined;
  }
  return Math.ceil(tokens);
}

export function resolveEffectivePromptTokens(
  basePromptTokens?: number,
  lastOutputTokens?: number,
  promptTokenEstimate?: number,
): number {
  const base = Math.max(0, basePromptTokens ?? 0);
  const output = Math.max(0, lastOutputTokens ?? 0);
  const estimate = Math.max(0, promptTokenEstimate ?? 0);
  // Flush gating projects the next input context by adding the previous
  // completion and the current user prompt estimate.
  return base + output + estimate;
}

export type SessionTranscriptUsageSnapshot = {
  promptTokens?: number;
  outputTokens?: number;
};

// Keep a generous near-threshold window so large assistant outputs still trigger
// transcript reads in time to flip memory-flush gating when needed.
const TRANSCRIPT_OUTPUT_READ_BUFFER_TOKENS = 8192;
const TRANSCRIPT_TAIL_CHUNK_BYTES = 64 * 1024;

type TranscriptTailUsageLine = {
  usage?: ReturnType<typeof normalizeUsage>;
  stopsUsageScan: boolean;
  clearsStoredUsage?: boolean;
};

function parseTranscriptTailUsageLine(line: string): TranscriptTailUsageLine {
  const trimmed = line.trim();
  if (!trimmed) {
    return { stopsUsageScan: false };
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      type?: string;
      message?: { role?: string; usage?: UsageLike };
      usage?: UsageLike;
    };
    // Compaction rewrites the active context. A usage snapshot before this
    // boundary describes the discarded prompt and must never be resurrected as
    // fresh state. Session headers are also hard boundaries when reading a
    // repaired or concatenated transcript.
    if (
      parsed.type === "compaction" ||
      parsed.type === "session" ||
      parsed.message?.role === "compactionSummary"
    ) {
      return { stopsUsageScan: true, clearsStoredUsage: true };
    }
    const hasUsageRecord =
      Object.hasOwn(parsed, "usage") ||
      (parsed.message != null && Object.hasOwn(parsed.message, "usage"));
    const usageRaw = parsed.message?.usage ?? parsed.usage;
    const usage = normalizeUsage(usageRaw);
    if (usage && hasNonzeroUsage(usage)) {
      return { usage, stopsUsageScan: false };
    }
    if (hasUsageRecord) {
      // A newer assistant turn with explicit zero/unknown usage supersedes
      // older snapshots. CLI backends write this shape intentionally because
      // their aggregate run totals are not a valid final-context measurement.
      return { stopsUsageScan: true };
    }
  } catch {
    // ignore bad lines
  }
  return { stopsUsageScan: false };
}

function resolveSessionLogPath(
  sessionId?: string,
  sessionEntry?: SessionEntry,
  sessionKey?: string,
  opts?: { storePath?: string },
): string | undefined {
  if (!sessionId) {
    return undefined;
  }

  try {
    const transcriptPath = (
      sessionEntry as (SessionEntry & { transcriptPath?: string }) | undefined
    )?.transcriptPath?.trim();
    const sessionFile = sessionEntry?.sessionFile?.trim() || transcriptPath;
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    const pathOpts = resolveSessionFilePathOptions({
      agentId,
      storePath: opts?.storePath,
    });
    // Normalize sessionFile through resolveSessionFilePath so relative entries
    // are resolved against the sessions dir/store layout, not process.cwd().
    return resolveSessionFilePath(
      sessionId,
      sessionFile ? { sessionFile } : sessionEntry,
      pathOpts,
    );
  } catch {
    return undefined;
  }
}

function deriveTranscriptUsageSnapshot(
  usage: ReturnType<typeof normalizeUsage> | undefined,
): SessionTranscriptUsageSnapshot | undefined {
  if (!usage) {
    return undefined;
  }
  const promptTokens = derivePromptTokens(usage);
  const outputRaw = usage.output;
  const outputTokens =
    typeof outputRaw === "number" && Number.isFinite(outputRaw) && outputRaw > 0
      ? outputRaw
      : undefined;
  if (!(typeof promptTokens === "number") && !(typeof outputTokens === "number")) {
    return undefined;
  }
  return {
    promptTokens,
    outputTokens,
  };
}

type SessionLogSnapshot = {
  byteSize?: number;
  usage?: SessionTranscriptUsageSnapshot;
  usageBoundary?: boolean;
  usageReadSucceeded?: boolean;
  usageScanBoundary?: boolean;
};

async function readSessionLogSnapshot(params: {
  sessionId?: string;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  opts?: { storePath?: string };
  includeByteSize: boolean;
  includeUsage: boolean;
}): Promise<SessionLogSnapshot> {
  const logPath = resolveSessionLogPath(
    params.sessionId,
    params.sessionEntry,
    params.sessionKey,
    params.opts,
  );
  if (!logPath) {
    return {};
  }

  const snapshot: SessionLogSnapshot = {};

  if (params.includeByteSize) {
    try {
      const stat = await fs.promises.stat(logPath);
      const size = Math.floor(stat.size);
      snapshot.byteSize = Number.isFinite(size) && size >= 0 ? size : undefined;
    } catch {
      snapshot.byteSize = undefined;
    }
  }

  if (params.includeUsage) {
    try {
      const tailUsage = await readLastNonzeroUsageFromSessionLog(logPath);
      snapshot.usage = deriveTranscriptUsageSnapshot(tailUsage.usage);
      snapshot.usageBoundary = tailUsage.clearsStoredUsage;
      snapshot.usageReadSucceeded = true;
      snapshot.usageScanBoundary = tailUsage.stoppedAtBoundary;
    } catch {
      snapshot.usage = undefined;
      snapshot.usageReadSucceeded = false;
    }
  }

  return snapshot;
}

async function readLastNonzeroUsageFromSessionLog(logPath: string): Promise<{
  usage?: ReturnType<typeof normalizeUsage>;
  stoppedAtBoundary: boolean;
  clearsStoredUsage: boolean;
}> {
  const handle = await fs.promises.open(logPath, "r");
  try {
    const stat = await handle.stat();
    let position = stat.size;
    let leadingPartial = "";
    while (position > 0) {
      const chunkSize = Math.min(TRANSCRIPT_TAIL_CHUNK_BYTES, position);
      const start = position - chunkSize;
      const buffer = Buffer.allocUnsafe(chunkSize);
      const { bytesRead } = await handle.read(buffer, 0, chunkSize, start);
      if (bytesRead <= 0) {
        break;
      }
      const chunk = buffer.toString("utf-8", 0, bytesRead);
      const combined = `${chunk}${leadingPartial}`;
      const lines = combined.split(/\n+/);
      leadingPartial = lines.shift() ?? "";
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const parsed = parseTranscriptTailUsageLine(lines[i] ?? "");
        if (parsed.usage) {
          return { usage: parsed.usage, stoppedAtBoundary: false, clearsStoredUsage: false };
        }
        if (parsed.stopsUsageScan) {
          return {
            stoppedAtBoundary: true,
            clearsStoredUsage: parsed.clearsStoredUsage === true,
          };
        }
      }
      position = start;
    }
    const parsed = parseTranscriptTailUsageLine(leadingPartial);
    return {
      usage: parsed.usage,
      stoppedAtBoundary: parsed.stopsUsageScan,
      clearsStoredUsage: parsed.clearsStoredUsage === true,
    };
  } finally {
    await handle.close();
  }
}

export async function readPromptTokensFromSessionLog(
  sessionId?: string,
  sessionEntry?: SessionEntry,
  sessionKey?: string,
  opts?: { storePath?: string },
): Promise<SessionTranscriptUsageSnapshot | undefined> {
  const snapshot = await readSessionLogSnapshot({
    sessionId,
    sessionEntry,
    sessionKey,
    opts,
    includeByteSize: false,
    includeUsage: true,
  });
  return snapshot.usage;
}

export async function runMemoryFlushIfNeeded(params: {
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
  promptForEstimate?: string;
  sessionCtx: TemplateContext;
  opts?: GetReplyOptions;
  defaultModel: string;
  agentCfgContextTokens?: number;
  resolvedVerboseLevel: VerboseLevel;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  isHeartbeat: boolean;
}): Promise<SessionEntry | undefined> {
  const memoryFlushSettings = resolveMemoryFlushSettings(params.cfg);

  const memoryFlushWritable = (() => {
    if (!params.sessionKey) {
      return true;
    }
    const runtime = resolveSandboxRuntimeStatus({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
    });
    if (!runtime.sandboxed) {
      return true;
    }
    const sandboxCfg = resolveSandboxConfigForAgent(params.cfg, runtime.agentId);
    return sandboxCfg.workspaceAccess === "rw";
  })();

  const isCli = isCliProvider(params.followupRun.run.provider, params.cfg);
  // CLI providers can hide the same oversized context behind persisted resume ids.
  // Let the shared pre-compaction memory flush run before CLI turns; when that
  // flush completes a real compaction, drop the CLI resume id so the next CLI
  // call starts from compacted OpenClaw context instead of the old hidden session.
  const canAttemptFlush = memoryFlushSettings != null && memoryFlushWritable && !params.isHeartbeat;
  let entry =
    params.sessionEntry ??
    (params.sessionKey ? params.sessionStore?.[params.sessionKey] : undefined);
  const contextWindowTokens = resolveMemoryFlushContextWindowTokens({
    modelId: params.followupRun.run.model ?? params.defaultModel,
    agentCfgContextTokens: params.agentCfgContextTokens,
  });

  const promptTokenEstimate = estimatePromptTokensForMemoryFlush(
    params.promptForEstimate ?? params.followupRun.prompt,
  );
  const persistedPromptTokensRaw = entry?.totalTokens;
  const persistedPromptTokens =
    typeof persistedPromptTokensRaw === "number" &&
    Number.isFinite(persistedPromptTokensRaw) &&
    persistedPromptTokensRaw > 0
      ? persistedPromptTokensRaw
      : undefined;
  const hasFreshPersistedPromptTokens =
    typeof persistedPromptTokens === "number" && entry?.totalTokensFresh === true;

  const flushThreshold = memoryFlushSettings
    ? contextWindowTokens -
      memoryFlushSettings.reserveTokensFloor -
      memoryFlushSettings.softThresholdTokens
    : 0;

  // When totals are stale/unknown, derive prompt + last output from transcript so memory
  // flush can still be evaluated against projected next-input size.
  //
  // When totals are fresh, only read the transcript when we're close enough to the
  // threshold that missing the last output tokens could flip the decision.
  const shouldReadTranscriptForOutput =
    canAttemptFlush &&
    entry &&
    hasFreshPersistedPromptTokens &&
    typeof promptTokenEstimate === "number" &&
    Number.isFinite(promptTokenEstimate) &&
    flushThreshold > 0 &&
    (persistedPromptTokens ?? 0) + promptTokenEstimate >=
      flushThreshold - TRANSCRIPT_OUTPUT_READ_BUFFER_TOKENS;

  // Token reconciliation protects the outer reply preflight, not just memory
  // flushing. Always repair a stale snapshot from transcript usage even when
  // memory writes are disabled or the sandbox workspace is read-only.
  const shouldReadTranscript = Boolean(
    entry && (!hasFreshPersistedPromptTokens || shouldReadTranscriptForOutput),
  );

  const forceFlushTranscriptBytes = memoryFlushSettings?.forceFlushTranscriptBytes ?? 0;
  const shouldCheckTranscriptSizeForForcedFlush = Boolean(
    canAttemptFlush &&
    entry &&
    Number.isFinite(forceFlushTranscriptBytes) &&
    forceFlushTranscriptBytes > 0,
  );
  const shouldReadSessionLog = shouldReadTranscript || shouldCheckTranscriptSizeForForcedFlush;
  const sessionLogSnapshot = shouldReadSessionLog
    ? await readSessionLogSnapshot({
        sessionId: params.followupRun.run.sessionId,
        sessionEntry: entry,
        sessionKey: params.sessionKey ?? params.followupRun.run.sessionKey,
        opts: { storePath: params.storePath },
        includeByteSize: shouldCheckTranscriptSizeForForcedFlush,
        includeUsage: shouldReadTranscript,
      })
    : undefined;
  const transcriptByteSize = sessionLogSnapshot?.byteSize;
  const shouldForceFlushByTranscriptSize =
    typeof transcriptByteSize === "number" && transcriptByteSize >= forceFlushTranscriptBytes;

  const transcriptUsageSnapshot = sessionLogSnapshot?.usage;
  const transcriptUsageBoundary = sessionLogSnapshot?.usageBoundary === true;
  const transcriptUsageReadSucceeded = sessionLogSnapshot?.usageReadSucceeded === true;
  const transcriptUsageScanBoundary = sessionLogSnapshot?.usageScanBoundary === true;
  const transcriptPromptTokens = transcriptUsageSnapshot?.promptTokens;
  const transcriptOutputTokens = transcriptUsageSnapshot?.outputTokens;
  const hasReliableTranscriptPromptTokens =
    typeof transcriptPromptTokens === "number" &&
    Number.isFinite(transcriptPromptTokens) &&
    transcriptPromptTokens > 0;
  const shouldPersistTranscriptPromptTokens =
    hasReliableTranscriptPromptTokens &&
    (!hasFreshPersistedPromptTokens ||
      (transcriptPromptTokens ?? 0) > (persistedPromptTokens ?? 0));

  if (entry && shouldPersistTranscriptPromptTokens) {
    // Keep the queued run synchronized with the transcript-backed snapshot.
    // Provider input counters may be cumulative across tool turns, so leaving
    // the original value here lets the outer hard-reserve guard reject a
    // healthy transcript even after this function has repaired the store.
    // The provider's last input snapshot excludes its own assistant output,
    // but that output becomes part of the next request. Include it only in the
    // queued preflight value; SessionEntry.totalTokens intentionally remains a
    // last-input context metric for status and persistence.
    params.followupRun.run.persistedPromptTokens = resolveEffectivePromptTokens(
      transcriptPromptTokens,
      transcriptOutputTokens,
      promptTokenEstimate,
    );
    const nextEntry = {
      ...entry,
      totalTokens: transcriptPromptTokens,
      totalTokensFresh: true,
    };
    entry = nextEntry;
    if (params.sessionKey && params.sessionStore) {
      params.sessionStore[params.sessionKey] = nextEntry;
    }
    if (params.storePath && params.sessionKey) {
      try {
        const updatedEntry = await updateSessionStoreEntry({
          storePath: params.storePath,
          sessionKey: params.sessionKey,
          update: async () => ({ totalTokens: transcriptPromptTokens, totalTokensFresh: true }),
        });
        if (updatedEntry) {
          entry = updatedEntry;
          if (params.sessionStore) {
            params.sessionStore[params.sessionKey] = updatedEntry;
          }
        }
      } catch (err) {
        logVerbose(`failed to persist derived prompt totalTokens: ${String(err)}`);
      }
    }
  }

  if (
    shouldReadTranscript &&
    transcriptUsageReadSucceeded &&
    transcriptUsageScanBoundary &&
    !hasFreshPersistedPromptTokens &&
    !hasReliableTranscriptPromptTokens
  ) {
    // A stale provider counter is not safe enough to reject a turn by itself.
    // CLI usage can be absent because its reported totals aggregate a tool loop
    // rather than describe the final context snapshot. Let the provider's own
    // context handling run instead of permanently wedging the session.
    params.followupRun.run.persistedPromptTokens = undefined;
  }

  if (entry && transcriptUsageBoundary && !hasReliableTranscriptPromptTokens) {
    // Compaction is authoritative: every earlier usage snapshot describes
    // discarded context. Clear the store too so a crash between transcript and
    // metadata writes cannot resurrect pre-compaction pressure.
    const nextEntry = {
      ...entry,
      totalTokens: undefined,
      totalTokensFresh: false,
      inputTokens: undefined,
      outputTokens: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    };
    entry = nextEntry;
    if (params.sessionKey && params.sessionStore) {
      params.sessionStore[params.sessionKey] = nextEntry;
    }
    if (params.storePath && params.sessionKey) {
      try {
        const updatedEntry = await updateSessionStoreEntry({
          storePath: params.storePath,
          sessionKey: params.sessionKey,
          update: async () => ({
            totalTokens: undefined,
            totalTokensFresh: false,
            inputTokens: undefined,
            outputTokens: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          }),
        });
        if (updatedEntry) {
          entry = updatedEntry;
          if (params.sessionStore) {
            params.sessionStore[params.sessionKey] = updatedEntry;
          }
        }
      } catch (err) {
        logVerbose(`failed to clear pre-compaction token snapshot: ${String(err)}`);
      }
    }
  }

  const promptTokensSnapshot = Math.max(
    hasFreshPersistedPromptTokens ? (persistedPromptTokens ?? 0) : 0,
    hasReliableTranscriptPromptTokens ? (transcriptPromptTokens ?? 0) : 0,
  );
  const hasFreshPromptTokensSnapshot =
    promptTokensSnapshot > 0 &&
    (hasFreshPersistedPromptTokens || hasReliableTranscriptPromptTokens);

  const projectedTokenCount = hasFreshPromptTokensSnapshot
    ? resolveEffectivePromptTokens(
        promptTokensSnapshot,
        transcriptOutputTokens,
        promptTokenEstimate,
      )
    : undefined;
  const tokenCountForFlush =
    typeof projectedTokenCount === "number" &&
    Number.isFinite(projectedTokenCount) &&
    projectedTokenCount > 0
      ? projectedTokenCount
      : undefined;
  const hardReserveThreshold = Math.max(
    0,
    contextWindowTokens - (memoryFlushSettings?.reserveTokensFloor ?? 0),
  );
  const hardReserveBreached =
    typeof tokenCountForFlush === "number" &&
    hardReserveThreshold > 0 &&
    tokenCountForFlush >= hardReserveThreshold;

  // Diagnostic logging to understand why memory flush may not trigger.
  logVerbose(
    `memoryFlush check: sessionKey=${params.sessionKey} ` +
      `tokenCount=${tokenCountForFlush ?? "undefined"} ` +
      `contextWindow=${contextWindowTokens} threshold=${flushThreshold} ` +
      `isHeartbeat=${params.isHeartbeat} isCli=${isCli} memoryFlushWritable=${memoryFlushWritable} ` +
      `compactionCount=${entry?.compactionCount ?? 0} memoryFlushCompactionCount=${entry?.memoryFlushCompactionCount ?? "undefined"} ` +
      `persistedPromptTokens=${persistedPromptTokens ?? "undefined"} persistedFresh=${entry?.totalTokensFresh === true} ` +
      `promptTokensEst=${promptTokenEstimate ?? "undefined"} transcriptPromptTokens=${transcriptPromptTokens ?? "undefined"} transcriptOutputTokens=${transcriptOutputTokens ?? "undefined"} ` +
      `projectedTokenCount=${projectedTokenCount ?? "undefined"} transcriptBytes=${transcriptByteSize ?? "undefined"} ` +
      `forceFlushTranscriptBytes=${forceFlushTranscriptBytes} forceFlushByTranscriptSize=${shouldForceFlushByTranscriptSize}`,
  );

  const shouldFlushMemory =
    (memoryFlushSettings &&
      memoryFlushWritable &&
      !params.isHeartbeat &&
      shouldRunMemoryFlush({
        entry,
        tokenCount: tokenCountForFlush,
        contextWindowTokens,
        reserveTokensFloor: memoryFlushSettings.reserveTokensFloor,
        softThresholdTokens: memoryFlushSettings.softThresholdTokens,
        // A stale flush marker must not suppress recovery once the session is
        // already inside the configured reserve; that is the exact live failure
        // mode that let an over-budget CLI session keep replying without flush.
        ignoreAlreadyFlushed: hardReserveBreached,
      })) ||
    (shouldForceFlushByTranscriptSize &&
      entry != null &&
      !hasAlreadyFlushedForCurrentCompaction(entry));

  if (!memoryFlushSettings || !shouldFlushMemory) {
    return entry ?? params.sessionEntry;
  }

  logVerbose(
    `memoryFlush triggered: sessionKey=${params.sessionKey} tokenCount=${tokenCountForFlush ?? "undefined"} threshold=${flushThreshold}`,
  );

  let activeSessionEntry = entry ?? params.sessionEntry;
  const activeSessionStore = params.sessionStore;
  let bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
    activeSessionEntry?.systemPromptReport ??
      (params.sessionKey ? activeSessionStore?.[params.sessionKey]?.systemPromptReport : undefined),
  );
  const flushRunId = crypto.randomUUID();
  if (params.sessionKey) {
    registerAgentRunContext(flushRunId, {
      sessionKey: params.sessionKey,
      verboseLevel: params.resolvedVerboseLevel,
    });
  }
  let memoryCompactionCompleted = false;
  const memoryFlushNowMs = Date.now();
  const memoryFlushWritePath = resolveMemoryFlushRelativePathForRun({
    cfg: params.cfg,
    nowMs: memoryFlushNowMs,
  });
  const flushSystemPrompt = [
    params.followupRun.run.extraSystemPrompt,
    memoryFlushSettings.systemPrompt,
  ]
    .filter(Boolean)
    .join("\n\n");
  try {
    await runWithModelFallback({
      ...resolveModelFallbackOptions(params.followupRun.run),
      runId: flushRunId,
      run: async (provider, model, runOptions) => {
        const { embeddedContext, senderContext, runBaseParams } = buildEmbeddedRunExecutionParams({
          run: params.followupRun.run,
          sessionCtx: params.sessionCtx,
          hasRepliedRef: params.opts?.hasRepliedRef,
          provider,
          model,
          runId: flushRunId,
          allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
        });
        const result = await runEmbeddedPiAgent({
          ...embeddedContext,
          ...senderContext,
          ...runBaseParams,
          trigger: "memory",
          memoryFlushWritePath,
          prompt: resolveMemoryFlushPromptForRun({
            prompt: memoryFlushSettings.prompt,
            cfg: params.cfg,
            nowMs: memoryFlushNowMs,
          }),
          extraSystemPrompt: flushSystemPrompt,
          bootstrapPromptWarningSignaturesSeen,
          bootstrapPromptWarningSignature:
            bootstrapPromptWarningSignaturesSeen[bootstrapPromptWarningSignaturesSeen.length - 1],
          onAgentEvent: (evt) => {
            if (evt.stream === "compaction") {
              const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
              // Overflow recovery also emits an end event when compaction
              // fails. Only a completed rewrite makes the old token snapshot
              // and CLI resume state stale.
              if (phase === "end" && evt.data.completed === true) {
                memoryCompactionCompleted = true;
              }
            }
          },
        });
        bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
          result.meta?.systemPromptReport,
        );
        return result;
      },
    });
    const shouldClearPromptTokenSnapshot = memoryCompactionCompleted || hardReserveBreached;
    let memoryFlushCompactionCount =
      activeSessionEntry?.compactionCount ??
      (params.sessionKey ? activeSessionStore?.[params.sessionKey]?.compactionCount : 0) ??
      0;
    if (memoryCompactionCompleted) {
      if (isCli && activeSessionEntry) {
        clearCliSessionId(activeSessionEntry, params.followupRun.run.provider);
      }
      // A completed memory compaction rewrites the usable context into a
      // smaller summary/tail. Token totals measured before that rewrite are
      // stale; keeping them would make the reply hard-reserve preflight block
      // the freshly compacted session before the provider can see it.
      params.followupRun.run.persistedPromptTokens = undefined;
      if (activeSessionEntry) {
        activeSessionEntry.totalTokens = undefined;
        activeSessionEntry.totalTokensFresh = false;
        activeSessionEntry.inputTokens = undefined;
        activeSessionEntry.outputTokens = undefined;
        activeSessionEntry.cacheRead = undefined;
        activeSessionEntry.cacheWrite = undefined;
        activeSessionEntry.contextPressureNoticeAt = undefined;
        activeSessionEntry.contextPressureNoticeCompactionCount = undefined;
      }
      const nextCount = await incrementCompactionCount({
        sessionEntry: activeSessionEntry,
        sessionStore: activeSessionStore,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      });
      if (typeof nextCount === "number") {
        memoryFlushCompactionCount = nextCount;
      }
    }
    if (!memoryCompactionCompleted && shouldClearPromptTokenSnapshot) {
      // A hard-reserve memory flush can successfully preserve durable state
      // without producing an in-session compaction event. In that case the old
      // provider usage snapshot is still pre-flush pressure, not a reliable
      // reason to block the real reply turn. Clear it so the embedded runner can
      // estimate the current transcript and, if needed, run overflow compaction.
      params.followupRun.run.persistedPromptTokens = undefined;
      if (activeSessionEntry) {
        activeSessionEntry.totalTokens = undefined;
        activeSessionEntry.totalTokensFresh = false;
        activeSessionEntry.inputTokens = undefined;
        activeSessionEntry.outputTokens = undefined;
        activeSessionEntry.cacheRead = undefined;
        activeSessionEntry.cacheWrite = undefined;
        activeSessionEntry.contextPressureNoticeAt = undefined;
        activeSessionEntry.contextPressureNoticeCompactionCount = undefined;
      }
    }
    if (params.storePath && params.sessionKey) {
      try {
        const updatedEntry = await updateSessionStoreEntry({
          storePath: params.storePath,
          sessionKey: params.sessionKey,
          update: async (entry) => {
            if (isCli) {
              clearCliSessionId(entry, params.followupRun.run.provider);
            }
            if (shouldClearPromptTokenSnapshot) {
              entry.totalTokens = undefined;
              entry.totalTokensFresh = false;
              entry.inputTokens = undefined;
              entry.outputTokens = undefined;
              entry.cacheRead = undefined;
              entry.cacheWrite = undefined;
              entry.contextPressureNoticeAt = undefined;
              entry.contextPressureNoticeCompactionCount = undefined;
            }
            return {
              memoryFlushAt: Date.now(),
              memoryFlushCompactionCount,
              ...(shouldClearPromptTokenSnapshot
                ? {
                    totalTokens: undefined,
                    totalTokensFresh: false,
                    inputTokens: undefined,
                    outputTokens: undefined,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                    contextPressureNoticeAt: undefined,
                    contextPressureNoticeCompactionCount: undefined,
                  }
                : {}),
            };
          },
        });
        if (updatedEntry) {
          activeSessionEntry = updatedEntry;
        }
      } catch (err) {
        logVerbose(`failed to persist memory flush metadata: ${String(err)}`);
      }
    }
  } catch (err) {
    logVerbose(`memory flush run failed: ${String(err)}`);
  }

  return activeSessionEntry;
}
