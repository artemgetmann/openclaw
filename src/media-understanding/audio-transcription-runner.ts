import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  type ActiveMediaModel,
  buildProviderRegistry,
  createMediaAttachmentCache,
  normalizeMediaAttachments,
  runCapability,
} from "./runner.js";
import type {
  MediaAttachment,
  MediaUnderstandingDecision,
  MediaUnderstandingProvider,
} from "./types.js";

export async function runAudioTranscription(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  attachments?: MediaAttachment[];
  agentDir?: string;
  providers?: Record<string, MediaUnderstandingProvider>;
  activeModel?: ActiveMediaModel;
  localPathRoots?: readonly string[];
}): Promise<{
  transcript: string | undefined;
  attachments: MediaAttachment[];
  decision: MediaUnderstandingDecision;
}> {
  const attachments = params.attachments ?? normalizeMediaAttachments(params.ctx);
  if (attachments.length === 0) {
    return {
      transcript: undefined,
      attachments,
      decision: { capability: "audio", outcome: "no-attachment", attachments: [] },
    };
  }

  const providerRegistry = buildProviderRegistry(params.providers);
  const cache = createMediaAttachmentCache(
    attachments,
    params.localPathRoots ? { localPathRoots: params.localPathRoots } : undefined,
  );

  try {
    const result = await runCapability({
      capability: "audio",
      cfg: params.cfg,
      ctx: params.ctx,
      attachments: cache,
      media: attachments,
      agentDir: params.agentDir,
      providerRegistry,
      config: params.cfg.tools?.media?.audio,
      activeModel: params.activeModel,
    });
    const output = result.outputs.find((entry) => entry.kind === "audio.transcription");
    const transcript = output?.text?.trim();
    // Keep the decision alongside text so explicit file transcription can
    // distinguish successful silence from an unavailable provider.
    return { transcript: transcript || undefined, attachments, decision: result.decision };
  } finally {
    await cache.cleanup();
  }
}
