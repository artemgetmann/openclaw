import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  MIN_PROMPT_BUDGET_RATIO,
  MIN_PROMPT_BUDGET_TOKENS,
} from "../../pi-compaction-constants.js";
import { DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR } from "../../pi-settings.js";

export const PREEMPTIVE_OVERFLOW_ERROR_TEXT =
  "Context overflow: prompt too large for the model (precheck).";

const ESTIMATED_CHARS_PER_TOKEN = 4;
const JSON_PAYLOAD_CHARS_PER_TOKEN = 3;
const MESSAGE_BOUNDARY_OVERHEAD_TOKENS = 12;
const CONTENT_BLOCK_OVERHEAD_TOKENS = 6;
const IMAGE_BLOCK_TOKENS = 2_000;
const SAFETY_MARGIN = 1.2;

export type PreemptiveCompactionDecision = {
  shouldCompact: boolean;
  estimatedPromptTokens: number;
  promptBudgetBeforeReserve: number;
  overflowTokens: number;
  requestedReserveTokens: number;
  effectiveReserveTokens: number;
};

function estimateStringTokenPressure(text: string, charsPerToken = ESTIMATED_CHARS_PER_TOKEN) {
  return Math.ceil(text.length / charsPerToken);
}

function estimateJsonPayloadTokenPressure(
  value: unknown,
  charsPerToken = JSON_PAYLOAD_CHARS_PER_TOKEN,
): number {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? Math.ceil(serialized.length / charsPerToken) : 1;
  } catch {
    // Cyclic or unserializable payloads are rare, but still LLM-facing. Bias
    // toward compaction instead of pretending the payload is free.
    return 256;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function estimateContentBlockTokenPressure(block: unknown): number {
  if (typeof block === "string") {
    return estimateStringTokenPressure(block);
  }
  if (!isRecord(block)) {
    return estimateJsonPayloadTokenPressure(block);
  }

  if (block.type === "text" && typeof block.text === "string") {
    return CONTENT_BLOCK_OVERHEAD_TOKENS + estimateStringTokenPressure(block.text);
  }
  if (block.type === "thinking" && typeof block.thinking === "string") {
    return CONTENT_BLOCK_OVERHEAD_TOKENS + estimateStringTokenPressure(block.thinking);
  }
  if (block.type === "image") {
    return IMAGE_BLOCK_TOKENS;
  }
  return CONTENT_BLOCK_OVERHEAD_TOKENS + estimateJsonPayloadTokenPressure(block);
}

function estimateContentTokenPressure(content: unknown): number {
  if (typeof content === "string") {
    return estimateStringTokenPressure(content);
  }
  if (Array.isArray(content)) {
    return content.reduce((sum, block) => sum + estimateContentBlockTokenPressure(block), 0);
  }
  if (content !== undefined) {
    return estimateJsonPayloadTokenPressure(content);
  }
  return 0;
}

function estimateAssistantToolCallTokenPressure(block: Record<string, unknown>): number {
  const args = block.arguments ?? block.input ?? block.args ?? {};
  return (
    CONTENT_BLOCK_OVERHEAD_TOKENS +
    estimateContentTokenPressure(block.name) +
    estimateJsonPayloadTokenPressure(args)
  );
}

function isToolResultMessage(message: AgentMessage): boolean {
  const record = message as unknown as { role?: unknown; type?: unknown };
  return record.role === "toolResult" || record.role === "tool" || record.type === "toolResult";
}

function estimateMessageTokenPressure(message: AgentMessage): number {
  const record = message as unknown as Record<string, unknown>;
  let tokens = MESSAGE_BOUNDARY_OVERHEAD_TOKENS;

  if (isToolResultMessage(message)) {
    tokens += estimateContentTokenPressure(record.content);
    tokens += estimateContentTokenPressure(record.toolName ?? record.tool_name);
    return tokens;
  }

  if (record.role === "assistant") {
    if (Array.isArray(record.content)) {
      for (const block of record.content) {
        if (isRecord(block) && (block.type === "toolCall" || block.type === "tool_use")) {
          tokens += estimateAssistantToolCallTokenPressure(block);
        } else {
          tokens += estimateContentBlockTokenPressure(block);
        }
      }
    } else {
      tokens += estimateContentTokenPressure(record.content);
    }

    const toolCalls = record.toolCalls ?? record.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const toolCall of toolCalls) {
        tokens += isRecord(toolCall)
          ? estimateAssistantToolCallTokenPressure(toolCall)
          : estimateJsonPayloadTokenPressure(toolCall);
      }
    }
    return tokens;
  }

  tokens += estimateContentTokenPressure(record.content);
  return tokens;
}

export function estimatePrePromptTokens(params: {
  messages: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
}): number {
  const historyTokens = params.messages.reduce(
    (sum, message) => sum + estimateMessageTokenPressure(message),
    0,
  );
  const systemTokens =
    typeof params.systemPrompt === "string" && params.systemPrompt.trim().length > 0
      ? MESSAGE_BOUNDARY_OVERHEAD_TOKENS + estimateStringTokenPressure(params.systemPrompt)
      : 0;
  const promptTokens =
    MESSAGE_BOUNDARY_OVERHEAD_TOKENS + estimateStringTokenPressure(params.prompt);

  // The estimator is intentionally conservative. The point is not perfect
  // tokenization; the point is to preserve configured headroom before the SDK
  // sees a request that may not emit its own compaction event.
  return Math.max(0, Math.ceil((historyTokens + systemTokens + promptTokens) * SAFETY_MARGIN));
}

export function resolvePrePromptReserveTokens(cfg?: OpenClawConfig): number {
  const compaction = cfg?.agents?.defaults?.compaction;
  const explicitReserve = compaction?.reserveTokens;
  if (
    typeof explicitReserve === "number" &&
    Number.isFinite(explicitReserve) &&
    explicitReserve >= 0
  ) {
    return Math.floor(explicitReserve);
  }

  const reserveFloor = compaction?.reserveTokensFloor;
  if (typeof reserveFloor === "number" && Number.isFinite(reserveFloor) && reserveFloor >= 0) {
    return Math.floor(reserveFloor);
  }

  return DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR;
}

export function shouldPreemptivelyCompactBeforePrompt(params: {
  messages: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
  contextTokenBudget: number;
  reserveTokens: number;
}): PreemptiveCompactionDecision {
  const contextTokenBudget = Math.max(1, Math.floor(params.contextTokenBudget));
  const requestedReserveTokens = Math.max(0, Math.floor(params.reserveTokens));
  const minPromptBudget = Math.min(
    MIN_PROMPT_BUDGET_TOKENS,
    Math.max(1, Math.floor(contextTokenBudget * MIN_PROMPT_BUDGET_RATIO)),
  );
  const effectiveReserveTokens = Math.min(
    requestedReserveTokens,
    Math.max(0, contextTokenBudget - minPromptBudget),
  );
  const promptBudgetBeforeReserve = Math.max(1, contextTokenBudget - effectiveReserveTokens);
  const estimatedPromptTokens = estimatePrePromptTokens({
    messages: params.messages,
    systemPrompt: params.systemPrompt,
    prompt: params.prompt,
  });
  const overflowTokens = Math.max(0, estimatedPromptTokens - promptBudgetBeforeReserve);

  return {
    shouldCompact: overflowTokens > 0,
    estimatedPromptTokens,
    promptBudgetBeforeReserve,
    overflowTokens,
    requestedReserveTokens,
    effectiveReserveTokens,
  };
}

export function formatPrePromptPrecheckLog(params: {
  result: PreemptiveCompactionDecision;
  sessionKey?: string;
  sessionId?: string;
  provider: string;
  modelId: string;
  messageCount: number;
  contextTokenBudget: number;
  sessionFile?: string;
}): string {
  return (
    `[context-overflow-precheck] pre-prompt check ` +
    `sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"} ` +
    `provider=${params.provider}/${params.modelId} ` +
    `shouldCompact=${params.result.shouldCompact} ` +
    `estimatedPromptTokens=${params.result.estimatedPromptTokens} ` +
    `promptBudgetBeforeReserve=${params.result.promptBudgetBeforeReserve} ` +
    `overflowTokens=${params.result.overflowTokens} ` +
    `reserveTokens=${params.result.requestedReserveTokens} ` +
    `effectiveReserveTokens=${params.result.effectiveReserveTokens} ` +
    `contextTokenBudget=${params.contextTokenBudget} ` +
    `messages=${params.messageCount} ` +
    `sessionFile=${params.sessionFile}`
  );
}

export function createPrePromptOverflowErrorIfNeeded(params: {
  messages: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
  contextTokenBudget: number;
  reserveTokens: number;
}): { error: Error; decision: PreemptiveCompactionDecision } | null {
  const decision = shouldPreemptivelyCompactBeforePrompt(params);
  if (!decision.shouldCompact) {
    return null;
  }

  return {
    error: new Error(PREEMPTIVE_OVERFLOW_ERROR_TEXT),
    decision,
  };
}
