import fs from "node:fs/promises";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { normalizeProviderId } from "../model-selection.js";

const DEFAULT_MAX_REPLAY_CHARS = 24_000;
const DEFAULT_TOOL_RESULT_MAX_CHARS = 2_000;
const DEFAULT_TEXT_TURN_MAX_CHARS = 12_000;
const MIN_VERBATIM_TAIL_CHARS = 4_000;

const REPLAY_HEADER = [
  "Recent shared OpenClaw session history",
  "",
  "The transcript below is recent context from this same OpenClaw session before the current user message.",
  "Use it as conversation history. Do not replay old tool calls; tool-call structures were stripped and large tool outputs may be truncated.",
].join("\n");

const REPLAY_FOOTER = [
  "End recent shared OpenClaw session history.",
  "The current user message follows after this section.",
].join("\n");

type ReplayMessage = {
  message: AgentMessage;
  provider?: string;
};

type RenderedReplayTurn = {
  summary: string;
  text: string;
};

export type ClaudeCliSharedTranscriptReplayOptions = {
  sessionFile: string;
  currentPrompt: string;
  cliSessionId?: string;
  maxChars?: number;
  toolResultMaxChars?: number;
  textTurnMaxChars?: number;
};

function resolvePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return fallback;
}

function normalizeMessageProvider(message: AgentMessage): string | undefined {
  if (message.role !== "assistant") {
    return undefined;
  }
  const rawProvider = (message as { provider?: unknown }).provider;
  return typeof rawProvider === "string" && rawProvider.trim()
    ? normalizeProviderId(rawProvider)
    : undefined;
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const chunks: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type === "text" && typeof typed.text === "string") {
      chunks.push(typed.text);
    }
  }
  return chunks.join("\n");
}

function extractToolCallNames(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const names: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typed = block as { type?: unknown; name?: unknown };
    if (typed.type !== "toolCall" && typed.type !== "toolUse" && typed.type !== "functionCall") {
      continue;
    }
    const name = typeof typed.name === "string" ? typed.name.trim() : "";
    names.push(name || "unknown");
  }
  return names;
}

function truncateTextWithMarker(params: {
  text: string;
  maxChars: number;
  marker: (omittedChars: number) => string;
}): string {
  if (params.text.length <= params.maxChars) {
    return params.text;
  }
  const marker = params.marker(params.text.length - params.maxChars);
  const keepChars = Math.max(0, params.maxChars - marker.length);
  return `${params.text.slice(0, keepChars)}${marker}`;
}

function renderAssistantLabel(message: AgentMessage, provider?: string): string {
  const model = (message as { model?: unknown }).model;
  const modelSuffix = typeof model === "string" && model.trim() ? `/${model.trim()}` : "";
  return provider ? `Assistant (${provider}${modelSuffix})` : "Assistant";
}

function renderReplayMessage(params: {
  message: AgentMessage;
  provider?: string;
  toolResultMaxChars: number;
  textTurnMaxChars: number;
}): RenderedReplayTurn | undefined {
  const { message } = params;
  if (message.role === "user") {
    const text = truncateTextWithMarker({
      text: extractTextFromContent((message as { content?: unknown }).content).trim(),
      maxChars: params.textTurnMaxChars,
      marker: (omitted) => `\n[message truncated: omitted ${omitted} chars]`,
    });
    if (!text) {
      return undefined;
    }
    return {
      summary: `user: ${text.replace(/\s+/g, " ").slice(0, 160)}`,
      text: `User:\n${text}`,
    };
  }

  if (message.role === "assistant") {
    const label = renderAssistantLabel(message, params.provider);
    const text = truncateTextWithMarker({
      text: extractTextFromContent((message as { content?: unknown }).content).trim(),
      maxChars: params.textTurnMaxChars,
      marker: (omitted) => `\n[assistant text truncated: omitted ${omitted} chars]`,
    });
    const toolNames = extractToolCallNames((message as { content?: unknown }).content);
    const toolNote = toolNames.length > 0 ? `[tool request omitted: ${toolNames.join(", ")}]` : "";
    const body = [text, toolNote].filter(Boolean).join("\n");
    if (!body) {
      return undefined;
    }
    return {
      summary: `${label.toLowerCase()}: ${body.replace(/\s+/g, " ").slice(0, 160)}`,
      text: `${label}:\n${body}`,
    };
  }

  if (message.role === "toolResult") {
    const toolName = (message as { toolName?: unknown }).toolName;
    const label = typeof toolName === "string" && toolName.trim() ? toolName.trim() : "unknown";
    const text = truncateTextWithMarker({
      text: extractTextFromContent((message as { content?: unknown }).content).trim(),
      maxChars: params.toolResultMaxChars,
      marker: (omitted) => `\n[tool output truncated: omitted ${omitted} chars]`,
    });
    if (!text) {
      return undefined;
    }
    return {
      summary: `tool result (${label}): ${text.replace(/\s+/g, " ").slice(0, 160)}`,
      text: `Tool result (${label}):\n${text}`,
    };
  }

  return undefined;
}

function buildOlderTurnsSummary(turns: RenderedReplayTurn[], maxChars: number): string {
  if (turns.length === 0 || maxChars <= 0) {
    return "";
  }
  const lines = ["Older turns compacted because the replay exceeded the budget:"];
  let omitted = 0;
  for (const turn of turns) {
    const line = `- ${turn.summary}`;
    const candidate = [...lines, line].join("\n");
    if (candidate.length > maxChars) {
      omitted += 1;
      continue;
    }
    lines.push(line);
  }
  if (omitted > 0) {
    const omittedLine = `- ${omitted} older turn(s) omitted from compacted summary.`;
    if ([...lines, omittedLine].join("\n").length <= maxChars) {
      lines.push(omittedLine);
    }
  }
  return lines.join("\n");
}

function assembleReplay(summary: string, verbatimTurns: RenderedReplayTurn[]): string {
  const body = [summary.trim(), ...verbatimTurns.map((turn) => turn.text.trim())]
    .filter(Boolean)
    .join("\n\n");
  return [REPLAY_HEADER, body, REPLAY_FOOTER].filter(Boolean).join("\n\n");
}

function compactReplayTurns(turns: RenderedReplayTurn[], maxChars: number): string {
  const fullReplay = assembleReplay("", turns);
  if (fullReplay.length <= maxChars) {
    return fullReplay;
  }

  // Keep the tail as real transcript first; only older turns are summarized.
  const wrapperChars = assembleReplay("", []).length;
  const bodyBudget = Math.max(0, maxChars - wrapperChars - 4);
  const verbatimBudget = Math.max(
    Math.min(MIN_VERBATIM_TAIL_CHARS, bodyBudget),
    Math.floor(bodyBudget * 0.55),
  );
  const verbatimTurns: RenderedReplayTurn[] = [];
  let verbatimChars = 0;
  let firstVerbatimIndex = turns.length;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!turn) {
      continue;
    }
    const nextChars = verbatimChars + turn.text.length + (verbatimTurns.length > 0 ? 2 : 0);
    if (verbatimTurns.length > 0 && nextChars > verbatimBudget) {
      break;
    }
    verbatimTurns.unshift(turn);
    verbatimChars = nextChars;
    firstVerbatimIndex = index;
  }

  const olderTurns = turns.slice(0, firstVerbatimIndex);
  const summaryBudget = Math.max(0, bodyBudget - verbatimChars - 2);
  const summary = buildOlderTurnsSummary(olderTurns, summaryBudget);
  const compacted = assembleReplay(summary, verbatimTurns);
  if (compacted.length <= maxChars || summary.length === 0) {
    return compacted;
  }

  const overflow = compacted.length - maxChars;
  const suffix = "\n[older summary truncated to fit replay budget]";
  const keepSummaryChars = Math.max(0, summary.length - overflow - suffix.length);
  return assembleReplay(`${summary.slice(0, keepSummaryChars)}${suffix}`, verbatimTurns);
}

function removeCurrentPromptDuplicate(
  messages: ReplayMessage[],
  currentPrompt: string,
): ReplayMessage[] {
  const trimmedPrompt = currentPrompt.trim();
  if (!trimmedPrompt || messages.length === 0) {
    return messages;
  }
  const next = [...messages];
  const last = next[next.length - 1]?.message;
  if (last?.role !== "user") {
    return next;
  }
  const lastUserText = extractTextFromContent((last as { content?: unknown }).content).trim();
  if (lastUserText === trimmedPrompt) {
    next.pop();
  }
  return next;
}

function selectReplayMessages(params: {
  messages: ReplayMessage[];
  cliSessionId?: string;
  currentPrompt: string;
}): ReplayMessage[] {
  let startIndex = 0;
  if (params.cliSessionId) {
    const lastClaudeAssistantIndex = params.messages.findLastIndex(
      (entry) => entry.message.role === "assistant" && entry.provider === "claude-cli",
    );
    startIndex = lastClaudeAssistantIndex >= 0 ? lastClaudeAssistantIndex + 1 : 0;
  }
  return removeCurrentPromptDuplicate(params.messages.slice(startIndex), params.currentPrompt);
}

export async function buildClaudeCliSharedTranscriptReplay(
  options: ClaudeCliSharedTranscriptReplayOptions,
): Promise<string | undefined> {
  await fs.access(options.sessionFile).catch(() => undefined);
  const exists = await fs
    .stat(options.sessionFile)
    .then((stat) => stat.isFile())
    .catch(() => false);
  if (!exists) {
    return undefined;
  }

  const sessionManager = SessionManager.open(options.sessionFile);
  const branchMessages = sessionManager
    .getBranch()
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message)
    .filter(
      (message) =>
        message.role === "user" || message.role === "assistant" || message.role === "toolResult",
    )
    .map((message) => ({
      message,
      provider: normalizeMessageProvider(message),
    }));

  const replayMessages = selectReplayMessages({
    messages: branchMessages,
    cliSessionId: options.cliSessionId,
    currentPrompt: options.currentPrompt,
  });
  const hasNonClaudeAssistant = replayMessages.some(
    (entry) =>
      entry.message.role === "assistant" &&
      entry.provider !== undefined &&
      entry.provider !== "claude-cli",
  );
  if (!hasNonClaudeAssistant) {
    return undefined;
  }

  const toolResultMaxChars = resolvePositiveInteger(
    options.toolResultMaxChars ?? process.env.OPENCLAW_CLAUDE_CLI_TRANSCRIPT_REPLAY_TOOL_MAX_CHARS,
    DEFAULT_TOOL_RESULT_MAX_CHARS,
  );
  const textTurnMaxChars = resolvePositiveInteger(
    options.textTurnMaxChars ?? process.env.OPENCLAW_CLAUDE_CLI_TRANSCRIPT_REPLAY_TEXT_MAX_CHARS,
    DEFAULT_TEXT_TURN_MAX_CHARS,
  );
  const turns = replayMessages
    .map((entry) =>
      renderReplayMessage({
        message: entry.message,
        provider: entry.provider,
        toolResultMaxChars,
        textTurnMaxChars,
      }),
    )
    .filter((turn): turn is RenderedReplayTurn => Boolean(turn));
  if (turns.length === 0) {
    return undefined;
  }

  const maxChars = resolvePositiveInteger(
    options.maxChars ?? process.env.OPENCLAW_CLAUDE_CLI_TRANSCRIPT_REPLAY_MAX_CHARS,
    DEFAULT_MAX_REPLAY_CHARS,
  );
  return compactReplayTurns(turns, maxChars);
}

export function prependClaudeCliSharedTranscriptReplay(params: {
  prompt: string;
  replay?: string;
}): string {
  const replay = params.replay?.trim();
  if (!replay) {
    return params.prompt;
  }
  return `${replay}\n\nCurrent user message:\n${params.prompt}`;
}
