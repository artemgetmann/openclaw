import type { ReplyPayload } from "../types.js";

export type OpenClawAssistantPhase = "commentary" | "final_answer";

/**
 * Read the structural assistant phase attached by provider stream adapters.
 *
 * Phase metadata is authoritative: commentary is visible working state, while
 * final_answer is durable user output. Unknown values stay unknown so legacy
 * phase-less providers keep their existing end-of-run finalization behavior.
 */
export function resolveOpenClawAssistantPhase(
  payload: ReplyPayload,
): OpenClawAssistantPhase | undefined {
  const channelData = payload.channelData;
  const openclaw =
    channelData && typeof channelData === "object" && !Array.isArray(channelData)
      ? channelData.openclaw
      : undefined;
  if (!openclaw || typeof openclaw !== "object" || Array.isArray(openclaw)) {
    return undefined;
  }
  const phase = (openclaw as { assistantPhase?: unknown }).assistantPhase;
  return phase === "commentary" || phase === "final_answer" ? phase : undefined;
}
