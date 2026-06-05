import {
  formatPrePromptPrecheckLog,
  resolvePrePromptReserveTokens,
  shouldPreemptivelyCompactBeforePrompt,
  type PreemptiveCompactionDecision,
} from "../../agents/pi-embedded-runner/run/preemptive-compaction.js";
import type { OpenClawConfig } from "../../config/config.js";

export type ReplyHardReservePrecheckResult = {
  decision: PreemptiveCompactionDecision;
  logLine: string;
};

export function evaluateReplyHardReservePrecheck(params: {
  provider: string;
  modelId: string;
  cfg: OpenClawConfig;
  prompt: string;
  persistedPromptTokens?: number;
  contextTokenBudget: number;
  sessionKey?: string;
  sessionId?: string;
  sessionFile?: string;
}): ReplyHardReservePrecheckResult | null {
  const persistedPromptTokens = params.persistedPromptTokens;
  if (
    typeof persistedPromptTokens !== "number" ||
    !Number.isFinite(persistedPromptTokens) ||
    persistedPromptTokens <= 0
  ) {
    return null;
  }

  const decision = shouldPreemptivelyCompactBeforePrompt({
    messages: [],
    prompt: params.prompt,
    persistedPromptTokens,
    contextTokenBudget: params.contextTokenBudget,
    reserveTokens: resolvePrePromptReserveTokens(params.cfg),
  });
  if (!decision.shouldCompact) {
    return null;
  }

  return {
    decision,
    logLine: formatPrePromptPrecheckLog({
      result: decision,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      provider: params.provider,
      modelId: params.modelId,
      messageCount: 0,
      contextTokenBudget: params.contextTokenBudget,
      sessionFile: params.sessionFile,
    }),
  };
}
