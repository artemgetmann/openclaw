const FINAL_TTS_CAPTION_PREVIEW_MAX_CHARS = 160;

function hasMarkdownTableBlock(text: string): boolean {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = lines[index]?.trim() ?? "";
    const delimiter = lines[index + 1]?.trim() ?? "";
    const headerCellCount = header.split("|").filter((cell) => cell.trim()).length;

    // This mirrors the product concern, not a full Markdown parser: if the
    // visible final answer is a table, a voice caption should not repeat raw
    // pipe syntax underneath the rich table bubble.
    if (
      header.includes("|") &&
      headerCellCount > 1 &&
      /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(delimiter)
    ) {
      return true;
    }
  }
  return false;
}

export function buildFinalTtsCaptionPreview(text: string): string | undefined {
  if (hasMarkdownTableBlock(text)) {
    return undefined;
  }

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
