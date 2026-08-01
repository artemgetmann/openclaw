import fs from "node:fs";
import { clearCliSessionId } from "../../agents/cli-session.js";
import { lookupContextTokens, resolveContextTokensForModel } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { resolveModelAuthMode } from "../../agents/model-auth.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { queueEmbeddedPiMessage } from "../../agents/pi-embedded.js";
import { deriveSessionTotalTokens, hasNonzeroUsage } from "../../agents/usage.js";
import {
  getSessionGoal,
  recordSessionGoalEvaluation,
  resolveAgentIdFromSessionKey,
  loadSessionStore,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveSessionTranscriptPath,
  resolveFreshSessionTotalTokens,
  type SessionEntry,
  updateSessionStore,
  updateSessionStoreEntry,
} from "../../config/sessions.js";
import type { TypingMode } from "../../config/types.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { emitDiagnosticEvent, isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { generateSecureUuid } from "../../infra/secure-random.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { logTelegramProgressDebug } from "../../infra/telegram-progress-debug.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import { estimateUsageCost, resolveModelCostConfig } from "../../utils/usage-format.js";
import {
  buildFallbackClearedNotice,
  buildFallbackNotice,
  resolveFallbackTransition,
} from "../fallback-state.js";
import type { OriginatingChannelType, TemplateContext } from "../templating.js";
import { resolveResponseUsageMode, type VerboseLevel } from "../thinking.js";
import type { AgentRunDeferralReason, GetReplyOptions, ReplyPayload } from "../types.js";
import { evaluateReplyHardReservePrecheck } from "./agent-runner-cli-preflight.js";
import { runAgentTurnWithFallback } from "./agent-runner-execution.js";
import {
  createShouldEmitToolOutput,
  createShouldEmitToolResult,
  isAudioPayload,
  signalTypingIfNeeded,
} from "./agent-runner-helpers.js";
import { runMemoryFlushIfNeeded } from "./agent-runner-memory.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import {
  appendUnscheduledReminderNote,
  hasSessionRelatedCronJobs,
  hasUnbackedReminderCommitment,
} from "./agent-runner-reminder-guard.js";
import { appendUsageLine, formatResponseUsageLine } from "./agent-runner-utils.js";
import { resolveOpenClawAssistantPhase } from "./assistant-phase.js";
import { createAudioAsVoiceBuffer, createBlockReplyPipeline } from "./block-reply-pipeline.js";
import { resolveEffectiveBlockStreamingConfig } from "./block-streaming.js";
import {
  buildContextPressureNoticeMarker,
  resolveContextPressureNotice,
} from "./context-pressure-notice.js";
import {
  canStartAnotherDurableTaskAttempt,
  completeDurableReplyTask,
  exhaustDurableReplyTask,
  formatDurableTaskExhaustedFailure,
  recordDurableTaskAttemptStart,
  recordDurableTaskEvidence,
  recordDurableTaskFallbackNotice,
  recordDurableTaskPayloadEvidence,
  recordDurableTaskTimeout,
  startDurableReplyTask,
  type DurableReplyTaskRecord,
} from "./durable-task-state.js";
import {
  buildEmptyFinalFallbackPayload,
  shouldReturnEmptyFinalFallback,
} from "./empty-final-reply.js";
import { createFollowupRunner } from "./followup-runner.js";
import {
  collectGoalEvaluationEvidence,
  formatGoalRevisionPrompt,
  runIndependentGoalEvaluator,
} from "./goal-evaluator.js";
import { resolveOriginMessageProvider, resolveOriginMessageTo } from "./origin-routing.js";
import { readPostCompactionContext } from "./post-compaction-context.js";
import { resolveActiveRunQueueAction } from "./queue-policy.js";
import {
  enqueueFollowupRunDurable,
  scheduleFollowupDrain,
  type FollowupRun,
  type QueueSettings,
} from "./queue.js";
import { persistDurableFollowup, persistDurableFollowupDelivery } from "./queue/durable-store.js";
import { createReplyMediaPathNormalizer } from "./reply-media-paths.js";
import { isRenderablePayload, shouldSuppressReasoningPayload } from "./reply-payloads.js";
import { startReplyRunWatchdog } from "./reply-run-watchdog.js";
import { createReplyToModeFilterForChannel, resolveReplyToMode } from "./reply-threading.js";
import { RESTART_INTERRUPTED_TURN_PAYLOAD } from "./restart-recovery.js";
import { resolveReplyRunPayloads } from "./run-result-payloads.js";
import { incrementRunCompactionCount, persistRunSessionUsage } from "./session-run-accounting.js";
import {
  isExplicitAgentTimeoutPayload,
  REPLY_TIMEOUT_CONTINUATION_PROMPT,
  resolveReplyTimeoutContinuationConfig,
  shouldContinueAfterReplyTimeout,
} from "./timeout-continuation.js";
import { createTypingSignaler } from "./typing-mode.js";
import type { TypingController } from "./typing.js";

const BLOCK_REPLY_SEND_TIMEOUT_MS = 15_000;

type FollowupFinalizationOwnership = {
  owners: number;
  pendingRunner?: (run: FollowupRun) => Promise<void>;
};

const FOLLOWUP_FINALIZATION_OWNERS = resolveGlobalMap<string, FollowupFinalizationOwnership>(
  Symbol.for("openclaw.auto-reply.followup-finalization-owners"),
);

function acquireFollowupFinalizationOwnership(queueKey: string): () => void {
  const state = FOLLOWUP_FINALIZATION_OWNERS.get(queueKey) ?? { owners: 0 };
  state.owners += 1;
  FOLLOWUP_FINALIZATION_OWNERS.set(queueKey, state);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    state.owners = Math.max(0, state.owners - 1);
    if (state.owners > 0) {
      return;
    }
    FOLLOWUP_FINALIZATION_OWNERS.delete(queueKey);
    if (state.pendingRunner) {
      // Normal finalization usually schedules first. A second call is safe:
      // the drain owns its own single-run guard. This release call closes error
      // and enqueue-after-empty-finalize races with the recovery runner.
      scheduleFollowupDrain(queueKey, state.pendingRunner);
    }
  };
}

/**
 * Treat the post-model finalization window as part of the active session turn.
 *
 * The embedded provider lane can become idle before usage persistence and
 * outbound reply delivery finish. Inbound admission must keep serializing
 * behind that owner or a new direct turn can start against stale session state.
 */
export function hasFollowupFinalizationOwnership(queueKey: string): boolean {
  return (FOLLOWUP_FINALIZATION_OWNERS.get(queueKey)?.owners ?? 0) > 0;
}

function scheduleOrDeferFollowupDrain(
  queueKey: string,
  runner: (run: FollowupRun) => Promise<void>,
): void {
  const state = FOLLOWUP_FINALIZATION_OWNERS.get(queueKey);
  if (!state || state.owners === 0) {
    scheduleFollowupDrain(queueKey, runner);
    return;
  }
  // The direct turn still owns persistence and reply delivery after its model
  // lane releases. Store the recovery runner without starting queued work; the
  // owner's finalizer will drain normally, and release provides a safe fallback.
  state.pendingRunner = runner;
}

function finalizeWithFollowup<T>(
  value: T,
  queueKey: string,
  runner: (run: FollowupRun) => Promise<void>,
): T {
  // Every direct completion must respect all finalization owners. Calling the
  // raw scheduler here lets the first of multiple direct turns start queued
  // work while another still persists usage or delivers its final reply.
  scheduleOrDeferFollowupDrain(queueKey, runner);
  return value;
}

type RunReplyAgentFinalizationLifecycle = {
  releaseOwnership?: () => void;
  directRecoveryRun?: FollowupRun;
};

type RunReplyAgentParams = {
  commandBody: string;
  followupRun: FollowupRun;
  queueKey: string;
  resolvedQueue: QueueSettings;
  shouldSteer: boolean;
  shouldFollowup: boolean;
  isActive: boolean;
  activeRunDeferralReason?: AgentRunDeferralReason;
  isStreaming: boolean;
  opts?: GetReplyOptions;
  typing: TypingController;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  defaultModel: string;
  agentCfgContextTokens?: number;
  resolvedVerboseLevel: VerboseLevel;
  isNewSession: boolean;
  blockStreamingEnabled: boolean;
  blockReplyChunking?: {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
    flushOnParagraph?: boolean;
  };
  resolvedBlockStreamingBreak: "text_end" | "message_end";
  sessionCtx: TemplateContext;
  shouldInjectGroupIntro: boolean;
  typingMode: TypingMode;
};

export async function runReplyAgent(
  params: RunReplyAgentParams,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const lifecycle: RunReplyAgentFinalizationLifecycle = {};
  try {
    const result = await runReplyAgentWithFinalizationOwnership(params, lifecycle);
    if (lifecycle.directRecoveryRun && result !== undefined) {
      // Model/tool completion and Telegram acceptance are separate boundaries.
      // Replace the conservative blocker with the exact final before returning
      // it to the transport, so a restart in between only re-delivers output.
      await persistDurableFollowupDelivery({
        run: lifecycle.directRecoveryRun,
        payloads: Array.isArray(result) ? result : [result],
      });
    }
    return result;
  } finally {
    lifecycle.releaseOwnership?.();
  }
}

async function runReplyAgentWithFinalizationOwnership(
  params: RunReplyAgentParams,
  lifecycle: RunReplyAgentFinalizationLifecycle,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const {
    commandBody,
    followupRun,
    queueKey,
    resolvedQueue,
    shouldSteer,
    shouldFollowup,
    isActive,
    activeRunDeferralReason,
    isStreaming,
    opts,
    typing,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    defaultModel,
    agentCfgContextTokens,
    resolvedVerboseLevel,
    isNewSession,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    sessionCtx,
    shouldInjectGroupIntro,
    typingMode,
  } = params;

  let activeSessionEntry = sessionEntry;
  const activeSessionStore = sessionStore;
  let activeIsNewSession = isNewSession;

  const isHeartbeat = opts?.isHeartbeat === true;
  const typingSignals = createTypingSignaler({
    typing,
    mode: typingMode,
    isHeartbeat,
  });

  const shouldEmitToolResult = createShouldEmitToolResult({
    sessionKey,
    storePath,
    resolvedVerboseLevel,
  });
  const shouldEmitToolOutput = createShouldEmitToolOutput({
    sessionKey,
    storePath,
    resolvedVerboseLevel,
  });

  const pendingToolTasks = new Set<Promise<void>>();
  const blockReplyTimeoutMs = opts?.blockReplyTimeoutMs ?? BLOCK_REPLY_SEND_TIMEOUT_MS;

  const replyToChannel = resolveOriginMessageProvider({
    originatingChannel: sessionCtx.OriginatingChannel,
    provider: sessionCtx.Surface ?? sessionCtx.Provider,
  }) as OriginatingChannelType | undefined;
  const replyToMode = resolveReplyToMode(
    followupRun.run.config,
    replyToChannel,
    sessionCtx.AccountId,
    sessionCtx.ChatType,
  );
  const applyReplyToMode = createReplyToModeFilterForChannel(replyToMode, replyToChannel);
  const cfg = followupRun.run.config;
  const didSendVisibleReply = { value: opts?.hasRepliedRef?.value === true };
  const didSendFinalVisibleReply = { value: opts?.hasRepliedRef?.value === true };
  let durableTask: DurableReplyTaskRecord | undefined;
  const markVisibleReply = (payload: ReplyPayload) => {
    if (shouldSuppressReasoningPayload(payload) || !isRenderablePayload(payload)) {
      return;
    }
    didSendVisibleReply.value = true;
  };
  const markFinalVisibleReply = (payload: ReplyPayload) => {
    markVisibleReply(payload);
    // Commentary proves that progress reached the user, not that the run
    // completed. If the provider dies after this block, preserve the empty-final
    // fallback instead of silently treating working state as the answer.
    if (resolveOpenClawAssistantPhase(payload) === "commentary") {
      return;
    }
    didSendFinalVisibleReply.value = true;
  };
  const runOpts =
    opts &&
    ({
      ...opts,
      onBlockReply: opts.onBlockReply
        ? async (payload, context) => {
            await opts.onBlockReply?.(payload, context);
            if (durableTask) {
              recordDurableTaskEvidence(durableTask, "block_reply", payload);
            }
            markFinalVisibleReply(payload);
          }
        : undefined,
      onPartialReply: opts.onPartialReply
        ? async (payload) => {
            await opts.onPartialReply?.(payload);
            if (durableTask) {
              recordDurableTaskEvidence(durableTask, "partial_reply", payload);
            }
            markFinalVisibleReply(payload);
          }
        : undefined,
      onToolResult: opts.onToolResult
        ? async (payload) => {
            await opts.onToolResult?.(payload);
            if (durableTask) {
              recordDurableTaskEvidence(durableTask, "tool_result", payload);
            }
            markVisibleReply(payload);
          }
        : undefined,
    } satisfies GetReplyOptions);
  const normalizeReplyMediaPaths = createReplyMediaPathNormalizer({
    cfg,
    sessionKey,
    workspaceDir: followupRun.run.workspaceDir,
  });
  const blockReplyCoalescing =
    blockStreamingEnabled && runOpts?.onBlockReply
      ? resolveEffectiveBlockStreamingConfig({
          cfg,
          provider: sessionCtx.Provider,
          accountId: sessionCtx.AccountId,
          chunking: blockReplyChunking,
        }).coalescing
      : undefined;
  const blockReplyPipeline =
    blockStreamingEnabled && runOpts?.onBlockReply
      ? createBlockReplyPipeline({
          onBlockReply: runOpts.onBlockReply,
          timeoutMs: blockReplyTimeoutMs,
          coalescing: blockReplyCoalescing,
          buffer: createAudioAsVoiceBuffer({ isAudioPayload }),
        })
      : null;
  const touchActiveSessionEntry = async () => {
    if (!activeSessionEntry || !activeSessionStore || !sessionKey) {
      return;
    }
    const updatedAt = Date.now();
    activeSessionEntry.updatedAt = updatedAt;
    activeSessionStore[sessionKey] = activeSessionEntry;
    if (storePath) {
      await updateSessionStoreEntry({
        storePath,
        sessionKey,
        update: async () => ({ updatedAt }),
      });
    }
  };
  const createRunFollowupTurn = (sessionState?: {
    entry?: SessionEntry;
    store?: Record<string, SessionEntry>;
  }) =>
    createFollowupRunner({
      opts: runOpts,
      typing,
      typingMode,
      sessionEntry: sessionState?.entry ?? activeSessionEntry,
      sessionStore: sessionState?.store ?? activeSessionStore,
      sessionKey,
      storePath,
      defaultModel,
      agentCfgContextTokens,
      liveReplyRoute: {
        originatingChannel: followupRun.originatingChannel,
        originatingTo: followupRun.originatingTo,
        originatingAccountId: followupRun.originatingAccountId,
        originatingThreadId: followupRun.originatingThreadId,
      },
      // The same callback drains RAM-only and persisted items. Preserve legacy
      // best-effort behavior for the former, but reject failed durable work so
      // the queue cannot acknowledge its disk record as successfully processed.
      failureMode: "throw-durable",
    });
  const runDurableFollowupTurn = async (queued: FollowupRun) => {
    // This callback may sit behind another turn for minutes. Reload at actual
    // execution time so compaction and usage bookkeeping cannot be based on
    // the busy inbound request's stale session snapshot.
    const refreshedSessionStore = storePath ? loadSessionStore(storePath) : activeSessionStore;
    const refreshedSessionEntry =
      (sessionKey ? refreshedSessionStore?.[sessionKey] : undefined) ?? activeSessionEntry;
    await createRunFollowupTurn({
      entry: refreshedSessionEntry,
      store: refreshedSessionStore,
    })(queued);
  };

  if (shouldSteer && isStreaming) {
    const steered = queueEmbeddedPiMessage(followupRun.run.sessionId, followupRun.prompt);
    if (steered && !shouldFollowup) {
      await touchActiveSessionEntry();
      typing.cleanup();
      return undefined;
    }
  }

  const activeRunQueueAction = resolveActiveRunQueueAction({
    isActive,
    isHeartbeat,
    shouldFollowup,
    queueMode: resolvedQueue.mode,
  });

  if (activeRunQueueAction === "drop") {
    // The caller needs the exact live blocker. In particular, restart recovery
    // must never infer that a stale transcript or its own queue carrier is a
    // genuinely active model/tool turn.
    if (activeRunDeferralReason) {
      runOpts?.onAgentRunDeferred?.(activeRunDeferralReason);
    }
    typing.cleanup();
    return undefined;
  }

  if (activeRunQueueAction === "enqueue-followup") {
    // Await the atomic disk record before returning to channel middleware. For
    // Telegram this is what makes advancing the update offset crash-safe.
    await enqueueFollowupRunDurable(
      queueKey,
      followupRun,
      resolvedQueue,
      "message-id",
      async (durableId) => {
        try {
          await runOpts?.onFollowupQueued?.({ durableId });
        } catch (err) {
          // The durable queue is already the source of truth. A channel receipt
          // failure must not strand accepted work by skipping drain scheduling.
          defaultRuntime.error?.(`follow-up queue receipt failed: ${String(err)}`);
        }
      },
    );
    // Offer the queue a fresh callback only after persistence. If the direct
    // turn still owns finalization, keep the callback pending so queued model
    // work cannot overtake its bookkeeping or reply delivery. With no owner,
    // the stale active classification outlived finalization, so drain now.
    scheduleOrDeferFollowupDrain(queueKey, runDurableFollowupTurn);
    await touchActiveSessionEntry();
    typing.cleanup();
    return undefined;
  }

  // From here through final payload persistence and delivery, this direct turn
  // owns queue finalization even after the embedded model lane becomes idle.
  // The exported wrapper releases ownership on every return and exception.
  lifecycle.releaseOwnership = acquireFollowupFinalizationOwnership(queueKey);

  const isAlreadyDurableQueuedWork = Boolean(
    followupRun.durableId?.trim() || followupRun.durableIds?.some((id) => id.trim()),
  );
  if (!isHeartbeat && !isAlreadyDurableQueuedWork && runOpts?.onDurableReplyAccepted) {
    // Persist a recovery-safe terminal payload before starting model or tool
    // work. An external restart can therefore never silently abandon this
    // accepted direct turn, while the blocker avoids replaying ambiguous side
    // effects. The transport removes this blocker only after terminal delivery.
    const recoveryRecord = await persistDurableFollowup({
      queueKey,
      run: followupRun,
      settings: resolvedQueue,
      // One atomic record is the acceptance boundary. There is no crash window
      // in which startup can observe replayable input without this blocker.
      deliveryPayloads: [RESTART_INTERRUPTED_TURN_PAYLOAD],
    });
    lifecycle.directRecoveryRun = { ...followupRun, durableId: recoveryRecord.id };
    await runOpts.onDurableReplyAccepted(recoveryRecord.id);
  }

  const timeoutContinuationConfig = resolveReplyTimeoutContinuationConfig(cfg);
  durableTask = startDurableReplyTask({
    sessionKey: sessionKey ?? followupRun.run.sessionKey,
    sessionId: followupRun.run.sessionId,
    maxAttempts: timeoutContinuationConfig.maxAttempts,
    maxWallClockMs: timeoutContinuationConfig.maxWallClockMs,
  });

  let responseUsageLine: string | undefined;
  type SessionResetOptions = {
    failureLabel: string;
    buildLogMessage: (nextSessionId: string) => string;
    cleanupTranscripts?: boolean;
    clearTokenUsage?: boolean;
    clearCliProvider?: string;
    incrementCompactionCount?: boolean;
  };
  const resetSession = async ({
    failureLabel,
    buildLogMessage,
    cleanupTranscripts,
    clearTokenUsage,
    clearCliProvider,
    incrementCompactionCount,
  }: SessionResetOptions): Promise<boolean> => {
    if (!sessionKey || !activeSessionStore || !storePath) {
      return false;
    }
    const prevEntry = activeSessionStore[sessionKey] ?? activeSessionEntry;
    if (!prevEntry) {
      return false;
    }
    const prevSessionId = cleanupTranscripts ? prevEntry.sessionId : undefined;
    const nextSessionId = generateSecureUuid();
    const nextCompactionCount = incrementCompactionCount
      ? (prevEntry.compactionCount ?? 0) + 1
      : undefined;
    const nextEntry: SessionEntry = {
      ...prevEntry,
      sessionId: nextSessionId,
      updatedAt: Date.now(),
      systemSent: false,
      abortedLastRun: false,
      modelProvider: undefined,
      model: undefined,
      contextTokens: undefined,
      systemPromptReport: undefined,
      ...(incrementCompactionCount ? { compactionCount: nextCompactionCount } : {}),
      ...(clearTokenUsage
        ? {
            totalTokens: undefined,
            totalTokensFresh: false,
            inputTokens: undefined,
            outputTokens: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
            memoryFlushCompactionCount: undefined,
            contextPressureNoticeAt: undefined,
            contextPressureNoticeCompactionCount: undefined,
          }
        : {}),
      fallbackNoticeSelectedModel: undefined,
      fallbackNoticeActiveModel: undefined,
      fallbackNoticeReason: undefined,
    };
    if (clearCliProvider) {
      clearCliSessionId(nextEntry, clearCliProvider);
    }
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    const nextSessionFile = resolveSessionTranscriptPath(
      nextSessionId,
      agentId,
      sessionCtx.MessageThreadId,
    );
    nextEntry.sessionFile = nextSessionFile;
    activeSessionStore[sessionKey] = nextEntry;
    try {
      await updateSessionStore(storePath, (store) => {
        store[sessionKey] = nextEntry;
      });
    } catch (err) {
      defaultRuntime.error(
        `Failed to persist session reset after ${failureLabel} (${sessionKey}): ${String(err)}`,
      );
    }
    followupRun.run.sessionId = nextSessionId;
    followupRun.run.sessionFile = nextSessionFile;
    activeSessionEntry = nextEntry;
    activeIsNewSession = true;
    defaultRuntime.error(buildLogMessage(nextSessionId));
    if (cleanupTranscripts && prevSessionId) {
      const transcriptCandidates = new Set<string>();
      const resolved = resolveSessionFilePath(
        prevSessionId,
        prevEntry,
        resolveSessionFilePathOptions({ agentId, storePath }),
      );
      if (resolved) {
        transcriptCandidates.add(resolved);
      }
      transcriptCandidates.add(resolveSessionTranscriptPath(prevSessionId, agentId));
      for (const candidate of transcriptCandidates) {
        try {
          fs.unlinkSync(candidate);
        } catch {
          // Best-effort cleanup.
        }
      }
    }
    return true;
  };
  const resetSessionAfterCompactionFailure = async (reason: string): Promise<boolean> =>
    resetSession({
      failureLabel: "compaction failure",
      buildLogMessage: (nextSessionId) =>
        `Auto-compaction failed (${reason}). Restarting session ${sessionKey} -> ${nextSessionId} and retrying.`,
    });
  const resetSessionAfterRoleOrderingConflict = async (reason: string): Promise<boolean> =>
    resetSession({
      failureLabel: "role ordering conflict",
      buildLogMessage: (nextSessionId) =>
        `Role ordering conflict (${reason}). Restarting session ${sessionKey} -> ${nextSessionId}.`,
      cleanupTranscripts: true,
    });
  const buildHardReserveOverflowPayload = (prompt: string): ReplyPayload | undefined => {
    // Heartbeats intentionally skip the pre-run memory flush. Their agent
    // runner owns overflow recovery, so this outer guard would otherwise
    // mistake the skipped flush for a failed one and surface a false overflow.
    if (isHeartbeat) {
      return undefined;
    }
    const persistedPromptTokens = followupRun.run.persistedPromptTokens;
    if (
      typeof persistedPromptTokens !== "number" ||
      !Number.isFinite(persistedPromptTokens) ||
      persistedPromptTokens <= 0
    ) {
      return undefined;
    }
    const contextTokenBudget =
      agentCfgContextTokens ??
      resolveContextTokensForModel({
        cfg,
        provider: followupRun.run.provider,
        model: followupRun.run.model,
      }) ??
      activeSessionEntry?.contextTokens ??
      DEFAULT_CONTEXT_TOKENS;
    const precheck = evaluateReplyHardReservePrecheck({
      provider: followupRun.run.provider,
      modelId: followupRun.run.model,
      cfg,
      prompt,
      persistedPromptTokens,
      contextTokenBudget,
      sessionKey,
      sessionId: followupRun.run.sessionId,
      sessionFile: followupRun.run.sessionFile,
    });
    if (!precheck) {
      return undefined;
    }
    // At this point memory flush has already had a chance to compact the
    // transcript. If the persisted prompt total still breaches the reserve,
    // stop before provider submission and report the overflow explicitly. A
    // silent reset detaches Telegram topics from the task they were already
    // executing, which is worse than surfacing the failure.
    defaultRuntime.log(precheck.logLine);
    defaultRuntime.error(
      `Pre-prompt context precheck blocked provider submission for ${sessionKey ?? followupRun.run.sessionId}; ` +
        `memory compaction did not recover enough context headroom.`,
    );
    return {
      text:
        "⚠️ Context overflow — this conversation is too large for the model, and automatic compaction could not recover enough room. " +
        "Use /new only if you want to intentionally start fresh.",
    };
  };

  await typingSignals.signalRunStart();

  activeSessionEntry = await runMemoryFlushIfNeeded({
    cfg,
    followupRun,
    promptForEstimate: followupRun.prompt,
    sessionCtx,
    opts: runOpts,
    defaultModel,
    agentCfgContextTokens,
    resolvedVerboseLevel,
    sessionEntry: activeSessionEntry,
    sessionStore: activeSessionStore,
    sessionKey,
    storePath,
    isHeartbeat,
  });

  // Queue execution may begin only after this direct turn finishes additional
  // bookkeeping. Reload again when the callback actually runs; otherwise the
  // normal finalizer can win drain ownership with a pre-finalization snapshot.
  const runFollowupTurn = runDurableFollowupTurn;

  const initialHardReservePayload = buildHardReserveOverflowPayload(followupRun.prompt);
  if (initialHardReservePayload) {
    return finalizeWithFollowup(initialHardReservePayload, queueKey, runFollowupTurn);
  }

  let stopReplyRunWatchdog = () => {};
  try {
    const runStartedAt = Date.now();
    const runSingleTurn = async (prompt: string) => {
      const hardReservePayload = buildHardReserveOverflowPayload(prompt);
      if (hardReservePayload) {
        return { kind: "final" as const, payload: hardReservePayload };
      }
      stopReplyRunWatchdog = startReplyRunWatchdog({
        cfg,
        enabled:
          !isHeartbeat &&
          runOpts?.typingPolicy !== "system_event" &&
          runOpts?.typingPolicy !== "heartbeat",
        // The watchdog is a status ping, not an agent/tool result. Use the original
        // channel callback so it does not suppress the empty-final fallback.
        onBlockReply: opts?.onBlockReply,
        log: (message) => defaultRuntime.log(message),
      });
      try {
        return await runAgentTurnWithFallback({
          commandBody: prompt,
          followupRun,
          sessionCtx,
          opts: runOpts,
          typingSignals,
          blockReplyPipeline,
          blockStreamingEnabled,
          blockReplyChunking,
          resolvedBlockStreamingBreak,
          applyReplyToMode,
          shouldEmitToolResult,
          shouldEmitToolOutput,
          pendingToolTasks,
          resetSessionAfterCompactionFailure,
          resetSessionAfterRoleOrderingConflict,
          isHeartbeat,
          sessionKey,
          getActiveSessionEntry: () => activeSessionEntry,
          activeSessionStore,
          storePath,
          resolvedVerboseLevel,
        });
      } finally {
        stopReplyRunWatchdog();
        stopReplyRunWatchdog = () => {};
      }
    };

    recordDurableTaskAttemptStart(durableTask);
    let runOutcome = await runSingleTurn(commandBody);
    while (runOutcome.kind !== "final") {
      const runPayloads = resolveReplyRunPayloads(runOutcome.runResult);
      const isExplicitTimeout =
        runPayloads.length === 1 && isExplicitAgentTimeoutPayload(runPayloads[0]);
      // The embedded runner marks provider timeouts as aborted after cancelling
      // their work. Let the explicit timeout payload reach continuation policy;
      // every other abort remains an immediate, silent user/system cancellation.
      if (runOutcome.runResult.meta?.aborted && !isExplicitTimeout) {
        exhaustDurableReplyTask(durableTask);
        return finalizeWithFollowup(undefined, queueKey, runFollowupTurn);
      }
      // Direct block/tool deliveries may still be queued locally when the model
      // returns. Drain them before deciding whether the user already saw a real
      // answer; watchdog/status pings still bypass this wrapped path.
      if (blockReplyPipeline) {
        await blockReplyPipeline.flush({ force: true });
      }
      if (pendingToolTasks.size > 0) {
        await Promise.allSettled(pendingToolTasks);
      }
      recordDurableTaskPayloadEvidence(durableTask, runPayloads);
      const timeoutContinuation = shouldContinueAfterReplyTimeout({
        cfg,
        opts: runOpts,
        isHeartbeat,
        payloads: runPayloads,
        didSendFinalVisibleReply: didSendFinalVisibleReply.value,
        messagingToolSentTargets: runOutcome.runResult.messagingToolSentTargets,
        messageProvider: followupRun.run.messageProvider,
        originatingTo: sessionCtx.OriginatingTo,
        accountId: sessionCtx.AccountId,
      });
      if (!timeoutContinuation.shouldContinue) {
        break;
      }
      recordDurableTaskTimeout(durableTask);
      const budget = canStartAnotherDurableTaskAttempt(durableTask);
      if (!budget.ok) {
        exhaustDurableReplyTask(durableTask);
        return finalizeWithFollowup(
          formatDurableTaskExhaustedFailure(durableTask),
          queueKey,
          runFollowupTurn,
        );
      }
      defaultRuntime.log(
        `reply durable task ${durableTask.taskId} timed out before final answer; auto-continuing attempt ${durableTask.attemptCount + 1}/${durableTask.maxAttempts}`,
      );
      recordDurableTaskAttemptStart(durableTask);
      runOutcome = await runSingleTurn(REPLY_TIMEOUT_CONTINUATION_PROMPT);
    }

    let goalEvaluatorPayloadOverride: ReplyPayload[] | undefined;
    while (runOutcome.kind !== "final" && sessionKey && storePath) {
      const candidate = runOutcome;
      const snapshot = await getSessionGoal({ sessionKey, storePath, persist: false });
      const goal = snapshot.goal;
      if (goal?.status !== "active" || !goal.pendingEvaluation) {
        break;
      }

      // Persist the working turn before grading it. If the process dies after
      // this point, the durable pending claim survives and can be evaluated on
      // the next finalization pass without trusting in-memory state.
      const candidateProvider =
        candidate.runResult.meta?.agentMeta?.provider ??
        candidate.fallbackProvider ??
        followupRun.run.provider;
      const candidateModel =
        candidate.runResult.meta?.agentMeta?.model ?? candidate.fallbackModel ?? defaultModel;
      await persistRunSessionUsage({
        storePath,
        sessionKey,
        usage: candidate.runResult.meta?.agentMeta?.usage,
        lastCallUsage: candidate.runResult.meta?.agentMeta?.lastCallUsage,
        promptTokens: candidate.runResult.meta?.agentMeta?.promptTokens,
        modelUsed: candidateModel,
        providerUsed: candidateProvider,
        contextTokensUsed:
          resolveContextTokensForModel({
            cfg,
            provider: candidateProvider,
            model: candidateModel,
          }) ?? DEFAULT_CONTEXT_TOKENS,
        systemPromptReport: candidate.runResult.meta?.systemPromptReport,
        cliSessionId: isCliProvider(candidateProvider, cfg)
          ? candidate.runResult.meta?.agentMeta?.sessionId?.trim()
          : undefined,
      });

      const evidence = collectGoalEvaluationEvidence({
        payloads: resolveReplyRunPayloads(candidate.runResult),
        transcriptMessages: candidate.runResult.transcriptMessages,
        messagingToolSentTexts: candidate.runResult.messagingToolSentTexts,
        messagingToolSentTargets: candidate.runResult.messagingToolSentTargets,
      });
      const evaluation = await runIndependentGoalEvaluator({
        goal,
        run: {
          ...followupRun.run,
          provider: candidateProvider,
          model: candidateModel,
        },
        evidence,
        workingTurnAborted: candidate.runResult.meta?.aborted,
        deterministicApprovalPromptSent: candidate.runResult.didSendDeterministicApprovalPrompt,
      });
      if (evaluation.kind !== "evaluated") {
        const detail =
          evaluation.kind === "unsupported_provider"
            ? `The selected provider (${evaluation.provider}) cannot guarantee a tool-disabled independent judge.`
            : `The independent judge failed closed: ${evaluation.reason}.`;
        goalEvaluatorPayloadOverride = [
          {
            text: `${detail} The goal remains active; completion was not accepted.`,
            isError: true,
          },
        ];
        break;
      }

      const decision = await recordSessionGoalEvaluation({
        sessionKey,
        storePath,
        expectedGoalId: goal.id,
        attemptId: goal.pendingEvaluation.requestId,
        verdict: evaluation.result.verdict,
        reason: evaluation.result.reason,
        evidence: evaluation.result.evidence,
        materialProgress: evaluation.result.materialProgress,
        blockerKey: evaluation.result.blockerKey,
      });
      if (decision.shouldContinueAutomatically) {
        const durableBudget = canStartAnotherDurableTaskAttempt(durableTask);
        if (!durableBudget.ok) {
          goalEvaluatorPayloadOverride = [
            {
              text: "The goal still needs revision, but this reply exhausted its safe retry budget. The goal remains active.",
              isError: true,
            },
          ];
          break;
        }
        defaultRuntime.log(
          `goal ${goal.id} needs revision; starting bounded automatic revision ${decision.goal.evaluation?.automaticRevisionCount ?? 0}/${decision.goal.evaluation?.maxAutomaticRevisions ?? 0}`,
        );
        recordDurableTaskAttemptStart(durableTask);
        runOutcome = await runSingleTurn(formatGoalRevisionPrompt(evaluation.result));
        continue;
      }

      if (decision.stopReason === "needs_input" || decision.stopReason === "approval_required") {
        goalEvaluatorPayloadOverride = [
          { text: evaluation.result.question ?? evaluation.result.reason },
        ];
      } else if (decision.stopReason === "goal_blocked") {
        goalEvaluatorPayloadOverride = [{ text: `Goal blocked: ${evaluation.result.reason}` }];
      } else if (decision.stopReason === "revision_limit") {
        goalEvaluatorPayloadOverride = [
          {
            text: `I could not verify completion within the automatic revision limit. The goal remains active. ${evaluation.result.reason}`,
            isError: true,
          },
        ];
      }
      break;
    }

    if (runOutcome.kind === "final") {
      completeDurableReplyTask(durableTask);
      return finalizeWithFollowup(runOutcome.payload, queueKey, runFollowupTurn);
    }

    const {
      runId,
      runResult,
      fallbackProvider,
      fallbackModel,
      fallbackAttempts,
      directlySentBlockKeys,
    } = runOutcome;
    let { didLogHeartbeatStrip, autoCompactionCount } = runOutcome;

    if (
      shouldInjectGroupIntro &&
      activeSessionEntry &&
      activeSessionStore &&
      sessionKey &&
      activeSessionEntry.groupActivationNeedsSystemIntro
    ) {
      const updatedAt = Date.now();
      activeSessionEntry.groupActivationNeedsSystemIntro = false;
      activeSessionEntry.updatedAt = updatedAt;
      activeSessionStore[sessionKey] = activeSessionEntry;
      if (storePath) {
        await updateSessionStoreEntry({
          storePath,
          sessionKey,
          update: async () => ({
            groupActivationNeedsSystemIntro: false,
            updatedAt,
          }),
        });
      }
    }

    if (blockReplyPipeline) {
      await blockReplyPipeline.flush({ force: true });
      blockReplyPipeline.stop();
    }
    if (pendingToolTasks.size > 0) {
      await Promise.allSettled(pendingToolTasks);
    }

    const usage = runResult.meta?.agentMeta?.usage;
    const promptTokens = runResult.meta?.agentMeta?.promptTokens;
    const modelUsed = runResult.meta?.agentMeta?.model ?? fallbackModel ?? defaultModel;
    const providerUsed =
      runResult.meta?.agentMeta?.provider ?? fallbackProvider ?? followupRun.run.provider;
    const payloadArray = goalEvaluatorPayloadOverride ?? resolveReplyRunPayloads(runResult);
    logTelegramProgressDebug("finalization.raw-payloads", {
      runId,
      sessionKey,
      sessionId: followupRun.run.sessionId,
      payloadCount: payloadArray.length,
      provider: providerUsed,
      model: modelUsed,
    });
    const verboseEnabled = resolvedVerboseLevel !== "off";
    const selectedProvider = followupRun.run.provider;
    const selectedModel = followupRun.run.model;
    const fallbackStateEntry =
      activeSessionEntry ?? (sessionKey ? activeSessionStore?.[sessionKey] : undefined);
    const fallbackTransition = resolveFallbackTransition({
      selectedProvider,
      selectedModel,
      activeProvider: providerUsed,
      activeModel: modelUsed,
      attempts: fallbackAttempts,
      state: fallbackStateEntry,
    });
    if (fallbackTransition.stateChanged) {
      if (fallbackStateEntry) {
        fallbackStateEntry.fallbackNoticeSelectedModel = fallbackTransition.nextState.selectedModel;
        fallbackStateEntry.fallbackNoticeActiveModel = fallbackTransition.nextState.activeModel;
        fallbackStateEntry.fallbackNoticeReason = fallbackTransition.nextState.reason;
        fallbackStateEntry.updatedAt = Date.now();
        activeSessionEntry = fallbackStateEntry;
      }
      if (sessionKey && fallbackStateEntry && activeSessionStore) {
        activeSessionStore[sessionKey] = fallbackStateEntry;
      }
      if (sessionKey && storePath) {
        await updateSessionStoreEntry({
          storePath,
          sessionKey,
          update: async () => ({
            fallbackNoticeSelectedModel: fallbackTransition.nextState.selectedModel,
            fallbackNoticeActiveModel: fallbackTransition.nextState.activeModel,
            fallbackNoticeReason: fallbackTransition.nextState.reason,
          }),
        });
      }
    }
    const cliSessionId = isCliProvider(providerUsed, cfg)
      ? runResult.meta?.agentMeta?.sessionId?.trim()
      : undefined;
    const contextTokensUsed =
      agentCfgContextTokens ??
      resolveContextTokensForModel({
        cfg,
        provider: providerUsed,
        model: modelUsed,
      }) ??
      lookupContextTokens(modelUsed) ??
      activeSessionEntry?.contextTokens ??
      DEFAULT_CONTEXT_TOKENS;

    await persistRunSessionUsage({
      storePath,
      sessionKey,
      usage,
      lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
      promptTokens,
      modelUsed,
      providerUsed,
      contextTokensUsed,
      systemPromptReport: runResult.meta?.systemPromptReport,
      cliSessionId,
    });

    // Drain any late tool/block deliveries before deciding there's "nothing to send".
    // Otherwise, a late typing trigger (e.g. from a tool callback) can outlive the run and
    // keep the typing indicator stuck.
    if (payloadArray.length === 0) {
      if (
        shouldReturnEmptyFinalFallback({
          opts: runOpts,
          isHeartbeat,
          rawPayloads: payloadArray,
          didSendVisibleReply: didSendVisibleReply.value,
          didSendFinalVisibleReply: didSendFinalVisibleReply.value,
          messagingToolSentTargets: runResult.messagingToolSentTargets,
          messageProvider: followupRun.run.messageProvider,
          originatingTo: sessionCtx.OriginatingTo,
          accountId: sessionCtx.AccountId,
        })
      ) {
        completeDurableReplyTask(durableTask);
        return finalizeWithFollowup(buildEmptyFinalFallbackPayload(), queueKey, runFollowupTurn);
      }
      completeDurableReplyTask(durableTask);
      return finalizeWithFollowup(undefined, queueKey, runFollowupTurn);
    }

    const payloadResult = await buildReplyPayloads({
      payloads: payloadArray,
      isHeartbeat,
      didLogHeartbeatStrip,
      blockStreamingEnabled,
      blockReplyPipeline,
      directlySentBlockKeys,
      replyToMode,
      replyToChannel,
      currentMessageId: sessionCtx.MessageSidFull ?? sessionCtx.MessageSid,
      messageProvider: followupRun.run.messageProvider,
      messagingToolSentTexts: runResult.messagingToolSentTexts,
      messagingToolSentMediaUrls: runResult.messagingToolSentMediaUrls,
      messagingToolSentTargets: runResult.messagingToolSentTargets,
      preserveFinalPayloadsAfterBlockStreaming:
        (sessionCtx.Surface ?? sessionCtx.Provider)?.trim().toLowerCase() === "telegram",
      originatingChannel: sessionCtx.OriginatingChannel,
      originatingTo: resolveOriginMessageTo({
        originatingTo: sessionCtx.OriginatingTo,
        to: sessionCtx.To,
      }),
      accountId: sessionCtx.AccountId,
      normalizeMediaPaths: normalizeReplyMediaPaths,
    });
    const { replyPayloads } = payloadResult;
    didLogHeartbeatStrip = payloadResult.didLogHeartbeatStrip;
    logTelegramProgressDebug("finalization.reply-payloads", {
      runId,
      sessionKey,
      sessionId: followupRun.run.sessionId,
      rawPayloadCount: payloadArray.length,
      replyPayloadCount: replyPayloads.length,
      blockStreamingEnabled,
    });

    if (replyPayloads.length === 0) {
      if (
        shouldReturnEmptyFinalFallback({
          opts: runOpts,
          isHeartbeat,
          rawPayloads: payloadArray,
          replyPayloads,
          didSendVisibleReply: didSendVisibleReply.value,
          didSendFinalVisibleReply: didSendFinalVisibleReply.value,
          messagingToolSentTargets: runResult.messagingToolSentTargets,
          messageProvider: followupRun.run.messageProvider,
          originatingTo: sessionCtx.OriginatingTo,
          accountId: sessionCtx.AccountId,
        })
      ) {
        completeDurableReplyTask(durableTask);
        return finalizeWithFollowup(buildEmptyFinalFallbackPayload(), queueKey, runFollowupTurn);
      }
      completeDurableReplyTask(durableTask);
      return finalizeWithFollowup(undefined, queueKey, runFollowupTurn);
    }

    const successfulCronAdds = runResult.successfulCronAdds ?? 0;
    const hasReminderCommitment = replyPayloads.some(
      (payload) =>
        !payload.isError &&
        typeof payload.text === "string" &&
        hasUnbackedReminderCommitment(payload.text),
    );
    // Suppress the guard note when an existing cron job (created in a prior
    // turn) already covers the commitment — avoids false positives (#32228).
    const coveredByExistingCron =
      hasReminderCommitment && successfulCronAdds === 0
        ? await hasSessionRelatedCronJobs({
            cronStorePath: cfg.cron?.store,
            sessionKey,
          })
        : false;
    const guardedReplyPayloads =
      hasReminderCommitment && successfulCronAdds === 0 && !coveredByExistingCron
        ? appendUnscheduledReminderNote(replyPayloads)
        : replyPayloads;

    await signalTypingIfNeeded(guardedReplyPayloads, typingSignals);
    logTelegramProgressDebug("finalization.before-delivery", {
      runId,
      sessionKey,
      sessionId: followupRun.run.sessionId,
      payloadCount: guardedReplyPayloads.length,
      mediaCount: guardedReplyPayloads.reduce(
        (count, payload) => count + (payload.mediaUrl ? 1 : 0) + (payload.mediaUrls?.length ?? 0),
        0,
      ),
    });

    if (isDiagnosticsEnabled(cfg) && hasNonzeroUsage(usage)) {
      const input = usage.input ?? 0;
      const output = usage.output ?? 0;
      const cacheRead = usage.cacheRead ?? 0;
      const cacheWrite = usage.cacheWrite ?? 0;
      const promptTokens = input + cacheRead + cacheWrite;
      const totalTokens = usage.total ?? promptTokens + output;
      const costConfig = resolveModelCostConfig({
        provider: providerUsed,
        model: modelUsed,
        config: cfg,
      });
      const costUsd = estimateUsageCost({ usage, cost: costConfig });
      emitDiagnosticEvent({
        type: "model.usage",
        sessionKey,
        sessionId: followupRun.run.sessionId,
        channel: replyToChannel,
        provider: providerUsed,
        model: modelUsed,
        usage: {
          input,
          output,
          cacheRead,
          cacheWrite,
          promptTokens,
          total: totalTokens,
        },
        lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
        context: {
          limit: contextTokensUsed,
          used: totalTokens,
        },
        costUsd,
        durationMs: Date.now() - runStartedAt,
      });
    }

    const responseUsageRaw =
      activeSessionEntry?.responseUsage ??
      (sessionKey ? activeSessionStore?.[sessionKey]?.responseUsage : undefined);
    const responseUsageMode = resolveResponseUsageMode(responseUsageRaw);
    if (responseUsageMode !== "off" && hasNonzeroUsage(usage)) {
      const authMode = resolveModelAuthMode(providerUsed, cfg);
      const showCost = authMode === "api-key";
      const costConfig = showCost
        ? resolveModelCostConfig({
            provider: providerUsed,
            model: modelUsed,
            config: cfg,
          })
        : undefined;
      let formatted = formatResponseUsageLine({
        usage,
        showCost,
        costConfig,
      });
      if (formatted && responseUsageMode === "full" && sessionKey) {
        formatted = `${formatted} · session \`${sessionKey}\``;
      }
      if (formatted) {
        responseUsageLine = formatted;
      }
    }

    // Always surface model switches. Consumers need to know when the selected
    // model was unavailable, otherwise the product quietly lies about what just
    // handled their message.
    let finalPayloads = guardedReplyPayloads;
    const runNotices: ReplyPayload[] = [];
    const verboseNotices: ReplyPayload[] = [];

    if (verboseEnabled && activeIsNewSession) {
      verboseNotices.push({ text: `🧭 New session: ${followupRun.run.sessionId}` });
    }

    const lastCallUsage = runResult.meta?.agentMeta?.lastCallUsage;
    // Match the session persistence trust boundary: raw accumulated `usage`
    // can include tool-loop/retry/replay cost and is not a reliable current
    // context snapshot. Warn only from promptTokens, last-call usage, or a
    // previously persisted fresh total.
    const contextPressureTotalTokens =
      promptTokens ??
      (lastCallUsage
        ? deriveSessionTotalTokens({
            usage: lastCallUsage,
          })
        : undefined) ??
      resolveFreshSessionTotalTokens(activeSessionEntry);
    const contextPressureNotice = resolveContextPressureNotice({
      sessionEntry: activeSessionEntry,
      totalTokens: contextPressureTotalTokens,
      contextTokens: contextTokensUsed,
      systemPromptReport: runResult.meta?.systemPromptReport,
    });
    if (contextPressureNotice && sessionKey && storePath) {
      // Persist the marker before we prepend the notice so the next turn can
      // suppress the same warning until compaction moves the session forward.
      const noticeMarker = buildContextPressureNoticeMarker({
        sessionEntry: activeSessionEntry,
      });
      const noticeAt = noticeMarker.contextPressureNoticeAt;
      if (activeSessionEntry) {
        activeSessionEntry.contextPressureNoticeAt = noticeAt;
        activeSessionEntry.contextPressureNoticeCompactionCount =
          noticeMarker.contextPressureNoticeCompactionCount;
        activeSessionEntry.updatedAt = noticeAt;
      }
      if (activeSessionStore) {
        activeSessionStore[sessionKey] = activeSessionEntry ?? activeSessionStore[sessionKey];
      }
      await updateSessionStoreEntry({
        storePath,
        sessionKey,
        update: async () => ({
          contextPressureNoticeAt: noticeAt,
          contextPressureNoticeCompactionCount: noticeMarker.contextPressureNoticeCompactionCount,
        }),
      });
      runNotices.push({ text: contextPressureNotice });
    }

    if (fallbackTransition.fallbackTransitioned) {
      emitAgentEvent({
        runId,
        sessionKey,
        stream: "lifecycle",
        data: {
          phase: "fallback",
          selectedProvider,
          selectedModel,
          activeProvider: providerUsed,
          activeModel: modelUsed,
          reasonSummary: fallbackTransition.reasonSummary,
          attemptSummaries: fallbackTransition.attemptSummaries,
          attempts: fallbackAttempts,
        },
      });
      const fallbackNotice = buildFallbackNotice({
        selectedProvider,
        selectedModel,
        activeProvider: providerUsed,
        activeModel: modelUsed,
        attempts: fallbackAttempts,
      });
      if (fallbackNotice && recordDurableTaskFallbackNotice(durableTask, fallbackNotice)) {
        runNotices.push({ text: fallbackNotice });
      }
    }
    if (fallbackTransition.fallbackCleared) {
      emitAgentEvent({
        runId,
        sessionKey,
        stream: "lifecycle",
        data: {
          phase: "fallback_cleared",
          selectedProvider,
          selectedModel,
          activeProvider: providerUsed,
          activeModel: modelUsed,
          previousActiveModel: fallbackTransition.previousState.activeModel,
        },
      });
      runNotices.push({
        text: buildFallbackClearedNotice({
          selectedProvider,
          selectedModel,
          previousActiveModel: fallbackTransition.previousState.activeModel,
        }),
      });
    }

    if (autoCompactionCount > 0) {
      const count = await incrementRunCompactionCount({
        sessionEntry: activeSessionEntry,
        sessionStore: activeSessionStore,
        sessionKey,
        storePath,
        amount: autoCompactionCount,
        lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
        contextTokensUsed,
      });

      // Inject post-compaction workspace context for the next agent turn
      if (sessionKey) {
        const workspaceDir = process.cwd();
        readPostCompactionContext(workspaceDir, cfg)
          .then((contextContent) => {
            if (contextContent) {
              enqueueSystemEvent(contextContent, { sessionKey });
            }
          })
          .catch(() => {
            // Silent failure — post-compaction context is best-effort
          });
      }

      if (verboseEnabled) {
        const suffix = typeof count === "number" ? ` (count ${count})` : "";
        verboseNotices.push({ text: `🧹 Auto-compaction complete${suffix}.` });
      }
    }
    if (runNotices.length > 0 || verboseNotices.length > 0) {
      finalPayloads = [...runNotices, ...verboseNotices, ...finalPayloads];
    }
    if (responseUsageLine) {
      finalPayloads = appendUsageLine(finalPayloads, responseUsageLine);
    }

    completeDurableReplyTask(durableTask);
    logTelegramProgressDebug("finalization.return", {
      runId,
      sessionKey,
      sessionId: followupRun.run.sessionId,
      payloadCount: finalPayloads.length,
    });
    return finalizeWithFollowup(
      finalPayloads.length === 1 ? finalPayloads[0] : finalPayloads,
      queueKey,
      runFollowupTurn,
    );
  } catch (error) {
    // Keep the followup queue moving even when an unexpected exception escapes
    // the run path; the caller still receives the original error.
    finalizeWithFollowup(undefined, queueKey, runFollowupTurn);
    throw error;
  } finally {
    stopReplyRunWatchdog();
    blockReplyPipeline?.stop();
    typing.markRunComplete();
    // Safety net: the dispatcher's onIdle callback normally fires
    // markDispatchIdle(), but if the dispatcher exits early, errors,
    // or the reply path doesn't go through it cleanly, the second
    // signal never fires and the typing keepalive loop runs forever.
    // Calling this twice is harmless — cleanup() is guarded by the
    // `active` flag.  Same pattern as the followup runner fix (#26881).
    typing.markDispatchIdle();
  }
}
