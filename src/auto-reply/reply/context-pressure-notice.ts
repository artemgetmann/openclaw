import {
  resolveFreshSessionTotalTokens,
  type SessionEntry,
  type SessionSystemPromptReport,
} from "../../config/sessions.js";

export const CONTEXT_PRESSURE_NOTICE_THRESHOLD = 0.75;
export const CONTEXT_PRESSURE_NOTICE_CONVERSATION_THRESHOLD = 0.2;
export const CONTEXT_PRESSURE_NOTICE_TEXT =
  "This chat is getting long. I can keep going, but it may slow down soon. If you want a clean handoff, ask me to make a checkpoint, then start a new chat and ask me to resume from it.";

type ContextPressureSessionEntry = Pick<
  SessionEntry,
  | "totalTokens"
  | "totalTokensFresh"
  | "compactionCount"
  | "contextPressureNoticeAt"
  | "contextPressureNoticeCompactionCount"
  | "systemPromptReport"
>;

function normalizePositiveInt(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function estimateTokensFromChars(chars: number | undefined): number | undefined {
  if (typeof chars !== "number" || !Number.isFinite(chars) || chars <= 0) {
    return undefined;
  }
  return Math.ceil(chars / 4);
}

function resolveSystemPromptTokenEstimate(
  report?: Pick<SessionSystemPromptReport, "systemPrompt" | "tools">,
): number | undefined {
  if (!report) {
    return undefined;
  }

  // Static bootstrap and tool schemas can dominate a fresh Claude CLI turn.
  // The warning should track conversational pressure, not startup overhead.
  const promptTokens = estimateTokensFromChars(report.systemPrompt?.chars);
  const toolSchemaTokens = estimateTokensFromChars(report.tools?.schemaChars);
  const total = (promptTokens ?? 0) + (toolSchemaTokens ?? 0);
  return total > 0 ? total : undefined;
}

export function resolveContextPressureNotice(params: {
  sessionEntry?: ContextPressureSessionEntry;
  totalTokens?: number;
  contextTokens?: number;
  systemPromptReport?: Pick<SessionSystemPromptReport, "systemPrompt" | "tools">;
}): string | undefined {
  const totalTokens =
    normalizePositiveInt(params.totalTokens) ?? resolveFreshSessionTotalTokens(params.sessionEntry);
  const contextTokens = normalizePositiveInt(params.contextTokens);
  if (!totalTokens || !contextTokens) {
    return undefined;
  }
  if (totalTokens / contextTokens < CONTEXT_PRESSURE_NOTICE_THRESHOLD) {
    return undefined;
  }

  const currentCompactionCount = params.sessionEntry?.compactionCount ?? 0;
  const systemPromptTokens = resolveSystemPromptTokenEstimate(
    params.systemPromptReport ?? params.sessionEntry?.systemPromptReport,
  );
  if (typeof systemPromptTokens === "number" && currentCompactionCount === 0) {
    const conversationTokens = Math.max(0, totalTokens - systemPromptTokens);
    if (conversationTokens / contextTokens < CONTEXT_PRESSURE_NOTICE_CONVERSATION_THRESHOLD) {
      return undefined;
    }
  }

  // Only repeat the warning after the session crosses a new compaction
  // boundary; otherwise a heavy session would nag on every turn.
  if (
    typeof params.sessionEntry?.contextPressureNoticeAt === "number" &&
    params.sessionEntry.contextPressureNoticeCompactionCount === currentCompactionCount
  ) {
    return undefined;
  }

  return CONTEXT_PRESSURE_NOTICE_TEXT;
}

export function buildContextPressureNoticeMarker(params: {
  sessionEntry?: Pick<SessionEntry, "compactionCount">;
  now?: number;
}): Required<
  Pick<SessionEntry, "contextPressureNoticeAt" | "contextPressureNoticeCompactionCount">
> {
  return {
    contextPressureNoticeAt: params.now ?? Date.now(),
    contextPressureNoticeCompactionCount: params.sessionEntry?.compactionCount ?? 0,
  };
}
