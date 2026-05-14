import { resolveFreshSessionTotalTokens, type SessionEntry } from "../../config/sessions.js";

export const CONTEXT_PRESSURE_NOTICE_THRESHOLD = 0.75;
export const CONTEXT_PRESSURE_NOTICE_TEXT =
  "This chat is getting long. I can keep going, but it may slow down soon. If you want a clean handoff, ask me to make a checkpoint, then start a new chat and ask me to resume from it.";

type ContextPressureSessionEntry = Pick<
  SessionEntry,
  | "totalTokens"
  | "totalTokensFresh"
  | "compactionCount"
  | "contextPressureNoticeAt"
  | "contextPressureNoticeCompactionCount"
>;

function normalizePositiveInt(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

export function resolveContextPressureNotice(params: {
  sessionEntry?: ContextPressureSessionEntry;
  totalTokens?: number;
  contextTokens?: number;
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
}): Pick<SessionEntry, "contextPressureNoticeAt" | "contextPressureNoticeCompactionCount"> {
  return {
    contextPressureNoticeAt: params.now ?? Date.now(),
    contextPressureNoticeCompactionCount: params.sessionEntry?.compactionCount ?? 0,
  };
}
