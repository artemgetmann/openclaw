const FINAL_TTS_CAPTION_PREVIEW_MAX_CHARS = 160;

export function buildFinalTtsCaptionPreview(text: string): string | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }

  // Telegram uses media captions in topic/chat-list previews. Keep this short
  // so the separate voice supplement carries context without duplicating the
  // already-visible final answer.
  if (normalized.length <= FINAL_TTS_CAPTION_PREVIEW_MAX_CHARS) {
    return normalized;
  }

  return `${normalized.slice(0, FINAL_TTS_CAPTION_PREVIEW_MAX_CHARS - 3).trimEnd()}...`;
}
