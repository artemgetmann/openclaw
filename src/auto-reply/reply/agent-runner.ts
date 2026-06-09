import fs from "node:fs";
import { clearCliSessionId } from "../../agents/cli-session.js";
import { lookupContextTokens } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { resolveModelAuthMode } from "../../agents/model-auth.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { queueEmbeddedPiMessage } from "../../agents/pi-embedded.js";
import { deriveSessionTotalTokens, hasNonzeroUsage } from "../../agents/usage.js";
import {
  resolveAgentIdFromSessionKey,
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
import { estimateUsageCost, resolveModelCostConfig } from "../../utils/usage-format.js";
import {
  buildFallbackClearedNotice,
  buildFallbackNotice,
  resolveFallbackTransition,
} from "../fallback-state.js";
import type { OriginatingChannelType, TemplateContext } from "../templating.js";
import { resolveResponseUsageMode, type VerboseLevel } from "../thinking.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { evaluateReplyHardReservePrecheck } from "./agent-runner-cli-preflight.js";
import { runAgentTurnWithFallback } from "./agent-runner-execution.js";
import {
  createShouldEmitToolOutput,
  createShouldEmitToolResult,
  finalizeWithFollowup,
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
import { resolveOriginMessageProvider, resolveOriginMessageTo } from "./origin-routing.js";
import { readPostCompactionContext } from "./post-compaction-context.js";
import { resolveActiveRunQueueAction } from "./queue-policy.js";
import { enqueueFollowupRun, type FollowupRun, type QueueSettings } from "./queue.js";
import { createReplyMediaPathNormalizer } from "./reply-media-paths.js";
import { isRenderablePayload, shouldSuppressReasoningPayload } from "./reply-payloads.js";
import { startReplyRunWatchdog } from "./reply-run-watchdog.js";
import { createReplyToModeFilterForChannel, resolveReplyToMode } from "./reply-threading.js";
import { incrementRunCompactionCount, persistRunSessionUsage } from "./session-run-accounting.js";
import {
  REPLY_TIMEOUT_CONTINUATION_PROMPT,
  resolveReplyTimeoutContinuationConfig,
  shouldContinueAfterReplyTimeout,
} from "./timeout-continuation.js";
import { createTypingSignaler } from "./typing-mode.js";
import type { TypingController } from "./typing.js";

const BLOCK_REPLY_SEND_TIMEOUT_MS = 15_000;

export async function runReplyAgent(params: {
  commandBody: string;
  followupRun: FollowupRun;
  queueKey: string;
  resolvedQueue: QueueSettings;
  shouldSteer: boolean;
  shouldFollowup: boolean;
  isActive: boolean;
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
}): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const {
    commandBody,
    followupRun,
    queueKey,
    resolvedQueue,
    shouldSteer,
    shouldFollowup,
    isActive,
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
    typing.cleanup();
    return undefined;
  }

  if (activeRunQueueAction === "enqueue-followup") {
    enqueueFollowupRun(queueKey, followupRun, resolvedQueue);
    await touchActiveSessionEntry();
    typing.cleanup();
    return undefined;
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
  const resetSessionBeforeHardReservePrompt = async (prompt: string): Promise<void> => {
    const persistedPromptTokens = followupRun.run.persistedPromptTokens;
    if (
      typeof persistedPromptTokens !== "number" ||
      !Number.isFinite(persistedPromptTokens) ||
      persistedPromptTokens <= 0
    ) {
      return;
    }
    const contextTokenBudget =
      agentCfgContextTokens ??
      activeSessionEntry?.contextTokens ??
      lookupContextTokens(followupRun.run.model) ??
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
      return;
    }
    // A persisted hard-reserve breach means the next prompt has already lost
    // the configured headroom. Reset the OpenClaw session before memory flush
    // or provider submission so no runtime path can spend another over-budget
    // call trying to repair stale context.
    defaultRuntime.log(precheck.logLine);
    const clearCliProvider = isCliProvider(followupRun.run.provider, cfg)
      ? followupRun.run.provider
      : undefined;
    const didReset = await resetSession({
      failureLabel: "hard-reserve preflight",
      buildLogMessage: (nextSessionId) =>
        `Pre-prompt context precheck reset ${sessionKey} -> ${nextSessionId} before provider submission.`,
      clearTokenUsage: true,
      ...(clearCliProvider ? { clearCliProvider } : {}),
      incrementCompactionCount: true,
    });
    if (didReset) {
      followupRun.run.persistedPromptTokens = undefined;
    }
  };

  await typingSignals.signalRunStart();
  await resetSessionBeforeHardReservePrompt(followupRun.prompt);

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

  const runFollowupTurn = createFollowupRunner({
    opts: runOpts,
    typing,
    typingMode,
    sessionEntry: activeSessionEntry,
    sessionStore: activeSessionStore,
    sessionKey,
    storePath,
    defaultModel,
    agentCfgContextTokens,
  });

  let stopReplyRunWatchdog = () => {};
  try {
    const runStartedAt = Date.now();
    const runSingleTurn = async (prompt: string) => {
      await resetSessionBeforeHardReservePrompt(prompt);
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
      if (runOutcome.runResult.meta?.aborted) {
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
      recordDurableTaskPayloadEvidence(durableTask, runOutcome.runResult.payloads);
      const timeoutContinuation = shouldContinueAfterReplyTimeout({
        cfg,
        opts: runOpts,
        isHeartbeat,
        payloads: runOutcome.runResult.payloads ?? [],
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
    const payloadArray = runResult.payloads ?? [];
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
