import crypto from "node:crypto";
import { resolveRunModelFallbacksOverride } from "../../agents/agent-scope.js";
import { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js";
import { lookupContextTokens, resolveContextTokensForModel } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import { loadSessionStore, resolveStorePath, type SessionEntry } from "../../config/sessions.js";
import type { TypingMode } from "../../config/types.js";
import { logVerbose } from "../../globals.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import { defaultRuntime } from "../../runtime.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import type { OriginatingChannelType } from "../templating.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { resolveRunAuthProfile } from "./agent-runner-utils.js";
import {
  resolveOriginAccountId,
  resolveOriginMessageProvider,
  resolveOriginMessageTo,
} from "./origin-routing.js";
import type { FollowupRun } from "./queue.js";
import {
  checkpointDurableFollowupDelivery,
  loadDurableFollowupDelivery,
  persistDurableFollowupDelivery,
} from "./queue/durable-store.js";
import {
  applyReplyThreading,
  filterMessagingToolDuplicates,
  filterMessagingToolMediaDuplicates,
  shouldSuppressMessagingToolReplies,
} from "./reply-payloads.js";
import { resolveReplyToMode } from "./reply-threading.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";
import { incrementRunCompactionCount, persistRunSessionUsage } from "./session-run-accounting.js";
import { createTypingSignaler } from "./typing-mode.js";
import { createTypingController, type TypingController } from "./typing.js";

/**
 * Build the process-start callback used for disk-backed followups.
 *
 * Unlike the normal callback, this cannot inherit a live inbound dispatcher or
 * typing lifecycle from the pre-restart process. Every queued record already
 * carries its original routing, model, and session input, so reconstruct only
 * the local session bookkeeping and let routeReply deliver to that origin.
 */
export function createRestoredFollowupRunner(): (queued: FollowupRun) => Promise<void> {
  return async (queued) => {
    const sessionKey = queued.run.sessionKey;
    const storePath = sessionKey
      ? resolveStorePath(queued.run.config.session?.store, { agentId: queued.run.agentId })
      : undefined;
    const sessionStore = storePath ? loadSessionStore(storePath) : undefined;
    const typing = createTypingController({});
    const run = createFollowupRunner({
      typing,
      // Recovery has no transport-owned typing callback. Disabling it avoids
      // inventing a stale indicator while preserving the actual reply route.
      typingMode: "never",
      sessionEntry: sessionKey ? sessionStore?.[sessionKey] : undefined,
      sessionStore,
      sessionKey,
      storePath,
      defaultModel: queued.run.model,
      // A fulfilled callback is the queue's durable acknowledgement boundary.
      // Recovery must reject model or unrecovered route failures so the record
      // remains available for the next drain/restart attempt.
      failureMode: "throw-durable",
    });
    await run(queued);
  };
}

export function createFollowupRunner(params: {
  opts?: GetReplyOptions;
  typing: TypingController;
  typingMode: TypingMode;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  defaultModel: string;
  agentCfgContextTokens?: number;
  /** Preserve legacy behavior for RAM-only work; durable drains opt into rejection. */
  failureMode?: "absorb" | "throw-durable";
}): (queued: FollowupRun) => Promise<void> {
  const {
    opts,
    typing,
    typingMode,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    defaultModel,
    agentCfgContextTokens,
    failureMode = "absorb",
  } = params;
  const resolveDurableIds = (queued: FollowupRun): string[] =>
    [...new Set([queued.durableId, ...(queued.durableIds ?? [])])].filter((id): id is string =>
      Boolean(id?.trim()),
    );
  const shouldThrowProcessingFailure = (queued: FollowupRun): boolean =>
    failureMode === "throw-durable" && resolveDurableIds(queued).length > 0;
  const persistDeliveryStage = async (queued: FollowupRun, payloads: ReplyPayload[]) => {
    const deliveryRecord = await persistDurableFollowupDelivery({ run: queued, payloads });
    if (!deliveryRecord?.delivery) {
      return;
    }
    queued.durableId = deliveryRecord.id;
    queued.durableIds = deliveryRecord.delivery.sourceDurableIds;
    queued.deliveryPayloads = deliveryRecord.delivery.payloads;
  };
  const typingSignals = createTypingSignaler({
    typing,
    mode: typingMode,
    isHeartbeat: opts?.isHeartbeat === true,
  });

  /**
   * Sends followup payloads, routing to the originating channel if set.
   *
   * A live same-channel dispatcher owns channel-specific reply lifecycle
   * semantics such as Telegram's mutable progress bubble and retained Work log.
   * Cross-channel delivery and restart recovery have no matching live
   * dispatcher, so those paths still route directly to the recorded origin.
   */
  const sendFollowupPayloads = async (payloads: ReplyPayload[], queued: FollowupRun) => {
    // Check if we should route to originating channel.
    const { originatingChannel, originatingTo } = queued;
    const shouldRouteToOriginating = isRoutableChannel(originatingChannel) && originatingTo;
    const provider = resolveOriginMessageProvider({
      provider: queued.run.messageProvider,
    });
    const origin = resolveOriginMessageProvider({
      originatingChannel,
    });
    const canUseSameChannelDispatcher = Boolean(
      opts?.onBlockReply && shouldRouteToOriginating && origin && origin === provider,
    );

    if (!shouldRouteToOriginating && !opts?.onBlockReply) {
      logVerbose("followup queue: no onBlockReply handler; dropping payloads");
      if (shouldThrowProcessingFailure(queued)) {
        throw new Error("Followup reply routing failed: no delivery handler");
      }
      return;
    }

    const markPayloadComplete = async () => {
      if (queued.deliveryPayloads === undefined) {
        return;
      }
      // Persist first: once the next provider call begins, disk must already
      // identify the exact FIFO suffix that remains after a restart.
      await checkpointDurableFollowupDelivery(queued.durableId, 1);
      queued.deliveryPayloads = queued.deliveryPayloads.slice(1);
    };

    for (const payload of payloads) {
      if (!payload?.text && !payload?.mediaUrl && !payload?.mediaUrls?.length) {
        await markPayloadComplete();
        continue;
      }
      if (
        isSilentReplyText(payload.text, SILENT_REPLY_TOKEN) &&
        !payload.mediaUrl &&
        !payload.mediaUrls?.length
      ) {
        await markPayloadComplete();
        continue;
      }
      await typingSignals.signalTextDelta(payload.text);

      if (canUseSameChannelDispatcher && opts?.onBlockReply) {
        // Queued same-channel replies must re-enter the original transport
        // dispatcher. Direct outbound routing would turn every phase-aware
        // commentary payload into a separate durable message, bypassing
        // Telegram's one-message progress controller and Work log finalization.
        await opts.onBlockReply(payload);
      } else if (shouldRouteToOriginating) {
        const result = await routeReply({
          payload,
          channel: originatingChannel,
          to: originatingTo,
          sessionKey: queued.run.sessionKey,
          accountId: queued.originatingAccountId,
          threadId: queued.originatingThreadId,
          cfg: queued.run.config,
        });
        if (!result.ok) {
          const errorMsg = result.error ?? "unknown error";
          logVerbose(`followup queue: route-reply failed: ${errorMsg}`);
          // Fall back to the caller-provided dispatcher only when the
          // originating channel matches the session's message provider.
          // In that case onBlockReply was created by the same channel's
          // handler and delivers to the correct destination.  For true
          // cross-channel routing (origin !== provider), falling back
          // would send to the wrong channel, so we drop the payload.
          if (opts?.onBlockReply && origin && origin === provider) {
            await opts.onBlockReply(payload);
          } else if (shouldThrowProcessingFailure(queued)) {
            throw new Error(`Followup reply routing failed: ${errorMsg}`);
          }
        }
      } else if (opts?.onBlockReply) {
        await opts.onBlockReply(payload);
      }
      await markPayloadComplete();
    }
  };

  return async (queued: FollowupRun) => {
    try {
      const durableIds = resolveDurableIds(queued);
      const stagedDelivery =
        queued.deliveryPayloads !== undefined
          ? undefined
          : await loadDurableFollowupDelivery(durableIds);
      if (stagedDelivery?.delivery) {
        // A prior attempt completed the agent/tool turn. Mutate this in-memory
        // wrapper as well as using the disk payload so immediate retry and
        // restart recovery both remain delivery-only.
        queued.durableId = stagedDelivery.id;
        queued.durableIds = stagedDelivery.delivery.sourceDurableIds;
        queued.deliveryPayloads = stagedDelivery.delivery.payloads;
      }
      if (queued.deliveryPayloads !== undefined) {
        // Empty is a valid completed stage (NO_REPLY or messaging-tool
        // suppression). Its presence must skip model/tool execution just like
        // a non-empty outbound retry.
        await sendFollowupPayloads(queued.deliveryPayloads, queued);
        return;
      }

      const runId = crypto.randomUUID();
      const shouldSurfaceToControlUi = isInternalMessageChannel(
        resolveOriginMessageProvider({
          originatingChannel: queued.originatingChannel,
          provider: queued.run.messageProvider,
        }),
      );
      if (queued.run.sessionKey) {
        registerAgentRunContext(runId, {
          sessionKey: queued.run.sessionKey,
          verboseLevel: queued.run.verboseLevel,
          isControlUiVisible: shouldSurfaceToControlUi,
        });
      }
      let autoCompactionCount = 0;
      let runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
      let fallbackProvider = queued.run.provider;
      let fallbackModel = queued.run.model;
      const activeSessionEntry =
        (sessionKey ? sessionStore?.[sessionKey] : undefined) ?? sessionEntry;
      let bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
        activeSessionEntry?.systemPromptReport,
      );
      try {
        const fallbackResult = await runWithModelFallback({
          cfg: queued.run.config,
          provider: queued.run.provider,
          model: queued.run.model,
          runId,
          agentDir: queued.run.agentDir,
          fallbacksOverride: resolveRunModelFallbacksOverride({
            cfg: queued.run.config,
            agentId: queued.run.agentId,
            sessionKey: queued.run.sessionKey,
          }),
          run: async (provider, model, runOptions) => {
            const authProfile = resolveRunAuthProfile(queued.run, provider);
            let attemptCompactionCount = 0;
            try {
              const result = await runEmbeddedPiAgent({
                sessionId: queued.run.sessionId,
                sessionKey: queued.run.sessionKey,
                agentId: queued.run.agentId,
                trigger: "user",
                messageChannel: queued.originatingChannel ?? undefined,
                messageProvider: queued.run.messageProvider,
                agentAccountId: queued.run.agentAccountId,
                messageTo: queued.originatingTo,
                messageThreadId: queued.originatingThreadId,
                currentChannelId: queued.originatingTo,
                currentThreadTs:
                  queued.originatingThreadId != null
                    ? String(queued.originatingThreadId)
                    : undefined,
                groupId: queued.run.groupId,
                groupChannel: queued.run.groupChannel,
                groupSpace: queued.run.groupSpace,
                senderId: queued.run.senderId,
                senderName: queued.run.senderName,
                senderUsername: queued.run.senderUsername,
                senderE164: queued.run.senderE164,
                senderIsOwner: queued.run.senderIsOwner,
                sessionFile: queued.run.sessionFile,
                persistedPromptTokens: queued.run.persistedPromptTokens,
                agentDir: queued.run.agentDir,
                workspaceDir: queued.run.workspaceDir,
                config: queued.run.config,
                skillsSnapshot: queued.run.skillsSnapshot,
                prompt: queued.prompt,
                extraSystemPrompt: queued.run.extraSystemPrompt,
                ownerNumbers: queued.run.ownerNumbers,
                enforceFinalTag: queued.run.enforceFinalTag,
                provider,
                model,
                ...authProfile,
                thinkLevel: queued.run.thinkLevel,
                verboseLevel: queued.run.verboseLevel,
                reasoningLevel: queued.run.reasoningLevel,
                suppressToolErrorWarnings: opts?.suppressToolErrorWarnings,
                execOverrides: queued.run.execOverrides,
                bashElevated: queued.run.bashElevated,
                timeoutMs: queued.run.timeoutMs,
                runId,
                allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
                blockReplyBreak: queued.run.blockReplyBreak,
                bootstrapPromptWarningSignaturesSeen,
                bootstrapPromptWarningSignature:
                  bootstrapPromptWarningSignaturesSeen[
                    bootstrapPromptWarningSignaturesSeen.length - 1
                  ],
                onAgentEvent: (evt) => {
                  if (evt.stream !== "compaction") {
                    return;
                  }
                  const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
                  const completed = evt.data?.completed === true;
                  if (phase === "end" && completed) {
                    attemptCompactionCount += 1;
                  }
                },
              });
              bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
                result.meta?.systemPromptReport,
              );
              const resultCompactionCount = Math.max(
                0,
                result.meta?.agentMeta?.compactionCount ?? 0,
              );
              attemptCompactionCount = Math.max(attemptCompactionCount, resultCompactionCount);
              return result;
            } finally {
              autoCompactionCount += attemptCompactionCount;
            }
          },
        });
        runResult = fallbackResult.result;
        fallbackProvider = fallbackResult.provider;
        fallbackModel = fallbackResult.model;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        defaultRuntime.error?.(`Followup agent failed before reply: ${message}`);
        if (shouldThrowProcessingFailure(queued)) {
          throw err;
        }
        return;
      }

      // An aborted embedded run is not a completed durable turn, even when it
      // happens to contain partial text. Reject before publishing a delivery
      // stage so recovery retries the original input instead of acknowledging
      // or sending an incomplete result. RAM-only followups intentionally keep
      // their historical best-effort behavior.
      if (durableIds.length > 0 && runResult.meta?.aborted === true) {
        throw new Error("Durable followup agent run aborted");
      }

      const usage = runResult.meta?.agentMeta?.usage;
      const promptTokens = runResult.meta?.agentMeta?.promptTokens;
      const modelUsed = runResult.meta?.agentMeta?.model ?? fallbackModel ?? defaultModel;
      const contextTokensUsed =
        agentCfgContextTokens ??
        resolveContextTokensForModel({
          cfg: queued.run.config,
          provider: fallbackProvider,
          model: modelUsed,
        }) ??
        lookupContextTokens(modelUsed) ??
        sessionEntry?.contextTokens ??
        DEFAULT_CONTEXT_TOKENS;

      const payloadArray = runResult.payloads ?? [];
      const sanitizedPayloads = payloadArray.flatMap((payload) => {
        const text = payload.text;
        if (!text || !text.includes("HEARTBEAT_OK")) {
          return [payload];
        }
        const stripped = stripHeartbeatToken(text, { mode: "message" });
        const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
        if (stripped.shouldSkip && !hasMedia) {
          return [];
        }
        return [{ ...payload, text: stripped.text }];
      });
      const replyToChannel = resolveOriginMessageProvider({
        originatingChannel: queued.originatingChannel,
        provider: queued.run.messageProvider,
      }) as OriginatingChannelType | undefined;
      const replyToMode = resolveReplyToMode(
        queued.run.config,
        replyToChannel,
        queued.originatingAccountId,
        queued.originatingChatType,
      );

      const replyTaggedPayloads: ReplyPayload[] = applyReplyThreading({
        payloads: sanitizedPayloads,
        replyToMode,
        replyToChannel,
      });

      const dedupedPayloads = filterMessagingToolDuplicates({
        payloads: replyTaggedPayloads,
        sentTexts: runResult.messagingToolSentTexts ?? [],
      });
      const mediaFilteredPayloads = filterMessagingToolMediaDuplicates({
        payloads: dedupedPayloads,
        sentMediaUrls: runResult.messagingToolSentMediaUrls ?? [],
      });
      const suppressMessagingToolReplies = shouldSuppressMessagingToolReplies({
        messageProvider: resolveOriginMessageProvider({
          originatingChannel: queued.originatingChannel,
          provider: queued.run.messageProvider,
        }),
        messagingToolSentTargets: runResult.messagingToolSentTargets,
        originatingTo: resolveOriginMessageTo({
          originatingTo: queued.originatingTo,
        }),
        accountId: resolveOriginAccountId({
          originatingAccountId: queued.originatingAccountId,
          accountId: queued.run.agentAccountId,
        }),
      });
      const finalPayloads = suppressMessagingToolReplies ? [] : mediaFilteredPayloads;

      if (autoCompactionCount > 0) {
        if (queued.run.verboseLevel && queued.run.verboseLevel !== "off") {
          // Compute the same count incrementRunCompactionCount will publish,
          // but do it without touching session storage. The exact outbound
          // envelope must be durable before any fallible bookkeeping begins.
          const compactionEntry =
            sessionStore && sessionKey ? (sessionStore[sessionKey] ?? sessionEntry) : undefined;
          const projectedCount = compactionEntry
            ? (compactionEntry.compactionCount ?? 0) + autoCompactionCount
            : undefined;
          const suffix = typeof projectedCount === "number" ? ` (count ${projectedCount})` : "";
          finalPayloads.unshift({
            text: `🧹 Auto-compaction complete${suffix}.`,
          });
        }
      }

      if (durableIds.length > 0) {
        // Commit the exact model-complete output before session usage,
        // compaction bookkeeping, or outbound delivery. Any later failure can
        // now retry this payload without replaying tools or other agent-side
        // effects. Empty is also a completed delivery stage.
        await persistDeliveryStage(queued, finalPayloads);
      }

      if (storePath && sessionKey) {
        await persistRunSessionUsage({
          storePath,
          sessionKey,
          usage,
          lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
          promptTokens,
          modelUsed,
          providerUsed: fallbackProvider,
          contextTokensUsed,
          systemPromptReport: runResult.meta?.systemPromptReport,
          logLabel: "followup",
        });
      }

      if (autoCompactionCount > 0) {
        await incrementRunCompactionCount({
          sessionEntry,
          sessionStore,
          sessionKey,
          storePath,
          amount: autoCompactionCount,
          lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
          contextTokensUsed,
        });
      }

      if (finalPayloads.length === 0) {
        return;
      }

      await sendFollowupPayloads(finalPayloads, queued);
    } finally {
      // Both signals are required for the typing controller to clean up.
      // The main inbound dispatch path calls markDispatchIdle() from the
      // buffered dispatcher's finally block, but followup turns bypass the
      // dispatcher entirely — so we must fire both signals here.  Without
      // this, NO_REPLY / empty-payload followups leave the typing indicator
      // stuck (the keepalive loop keeps sending "typing" to Telegram
      // indefinitely until the TTL expires).
      typing.markRunComplete();
      typing.markDispatchIdle();
    }
  };
}
