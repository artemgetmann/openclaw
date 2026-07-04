const FINAL_TTS_CAPTION_PREVIEW_MAX_CHARS = 160;
const FINAL_TTS_SPOKEN_PREVIEW_MAX_CHARS = 360;
const FINAL_TTS_TABLE_SUMMARY_MAX_ROWS = 3;

type MarkdownTableBlock = {
  headers: string[];
  rows: string[][];
  lineIndexes: Set<number>;
};

function splitMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim();
  const body = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const withoutTrailingPipe = body.endsWith("|") ? body.slice(0, -1) : body;
  return withoutTrailingPipe
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean);
}

function isMarkdownTableDelimiter(line: string): boolean {
  const cells = splitMarkdownTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function findMarkdownTableBlocks(text: string): MarkdownTableBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownTableBlock[] = [];
  let inFence = false;

  for (let index = 0; index + 1 < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^[ \t]*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line.includes("|") || !isMarkdownTableDelimiter(lines[index + 1] ?? "")) {
      continue;
    }

    const headers = splitMarkdownTableRow(line);
    const rows: string[][] = [];
    const lineIndexes = new Set<number>([index, index + 1]);
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const rowLine = lines[rowIndex] ?? "";
      if (!rowLine.includes("|")) {
        break;
      }
      rows.push(splitMarkdownTableRow(rowLine));
      lineIndexes.add(rowIndex);
      index = rowIndex;
    }
    blocks.push({ headers, rows, lineIndexes });
  }

  return blocks;
}

function stripFencedCode(text: string): { text: string; removed: boolean } {
  let removed = false;
  const withoutCode = text.replace(
    /(^|\n)[ \t]*(?:```|~~~)[\s\S]*?(?:\n[ \t]*(?:```|~~~)|$)/g,
    (match) => {
      removed = true;
      return match.startsWith("\n") ? "\n" : "";
    },
  );
  return { text: withoutCode, removed };
}

function stripMarkdownTables(text: string, tables: readonly MarkdownTableBlock[]): string {
  if (tables.length === 0) {
    return text;
  }
  const tableLineIndexes = new Set<number>();
  for (const table of tables) {
    for (const lineIndex of table.lineIndexes) {
      tableLineIndexes.add(lineIndex);
    }
  }
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((_line, index) => !tableLineIndexes.has(index))
    .join("\n");
}

function removeDominantPathLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return true;
      }
      const pathishChars = (trimmed.match(/[/.~_-]/g) ?? []).length;
      return !(pathishChars >= 4 && pathishChars / trimmed.length > 0.2);
    })
    .join("\n");
}

function hasDominantPathContent(text: string): boolean {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return false;
  }
  let pathHeavyLines = 0;
  for (const line of lines) {
    const pathishChars = (line.match(/[/.~_-]/g) ?? []).length;
    if (pathishChars >= 4 && pathishChars / line.length > 0.2) {
      pathHeavyLines += 1;
    }
  }
  return pathHeavyLines >= 2 || pathHeavyLines / lines.length > 0.5;
}

function sanitizeForVoice(text: string): string {
  return removeDominantPathLines(text)
    .replace(/`{1,3}([^`\n]+)`{1,3}/g, "$1")
    .replace(/(?:^|\s)(?:~|\.{1,2}|\/)[^\s`|]{8,}/g, " file")
    .replace(/[|`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function capPreview(
  text: string,
  maxChars = FINAL_TTS_CAPTION_PREVIEW_MAX_CHARS,
): string | undefined {
  const normalized = sanitizeForVoice(text);
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 3).trimEnd()}...`;
}

function normalizeTableVoiceCell(cell: string): string | undefined {
  const normalized = sanitizeForVoice(cell)
    .replace(/[.;:,]+$/g, "")
    .trim();
  return normalized.length > 0 ? normalized : undefined;
}

function summarizeTableRow(table: MarkdownTableBlock, row: readonly string[]): string | undefined {
  const label = normalizeTableVoiceCell(row[0] ?? "");
  if (!label) {
    return undefined;
  }
  const details = row
    .slice(1)
    .map((cell, offset) => {
      const value = normalizeTableVoiceCell(cell);
      if (!value) {
        return undefined;
      }
      const header = normalizeTableVoiceCell(table.headers[offset + 1] ?? "");
      return header ? `${header.toLowerCase()} ${value}` : value;
    })
    .filter((part): part is string => Boolean(part));

  return details.length > 0 ? `${label}: ${details.join(", ")}` : label;
}

function summarizeTables(tables: readonly MarkdownTableBlock[]): string {
  const rowSummaries: string[] = [];
  for (const table of tables) {
    // The voice path should acknowledge the table itself, not only nearby prose.
    // Use the first useful rows because they usually carry the actual choices.
    for (const row of table.rows) {
      const summary = summarizeTableRow(table, row);
      if (summary) {
        rowSummaries.push(summary);
      }
      if (rowSummaries.length >= FINAL_TTS_TABLE_SUMMARY_MAX_ROWS) {
        break;
      }
    }
    if (rowSummaries.length >= FINAL_TTS_TABLE_SUMMARY_MAX_ROWS) {
      break;
    }
  }

  if (rowSummaries.length === 0) {
    return "Full table is in Telegram.";
  }
  return `Full table is in Telegram. Key rows: ${rowSummaries.join("; ")}.`;
}

function buildFinalTtsSummary(
  text: string,
  maxChars = FINAL_TTS_CAPTION_PREVIEW_MAX_CHARS,
): string | undefined {
  const normalizedInput = text.replace(/\r\n?/g, "\n").trim();
  if (!normalizedInput) {
    return undefined;
  }

  const withoutCode = stripFencedCode(normalizedInput);
  const tables = findMarkdownTableBlocks(withoutCode.text);
  const prose = stripMarkdownTables(withoutCode.text, tables);
  if (tables.length > 0) {
    const tableSummary = summarizeTables(tables);
    const prosePreview = capPreview(prose, maxChars);
    return capPreview([tableSummary, prosePreview].filter(Boolean).join(" "), maxChars);
  }
  const prosePreview = capPreview(prose, maxChars);
  if (prosePreview) {
    return prosePreview;
  }
  if (withoutCode.removed) {
    return "I drafted the code in Telegram.";
  }
  return capPreview(normalizedInput, maxChars);
}

export function buildFinalTtsSpokenPreview(text: string): string | undefined {
  const normalizedInput = text.replace(/\r\n?/g, "\n").trim();
  if (!normalizedInput) {
    return undefined;
  }
  const withoutCode = stripFencedCode(normalizedInput);
  const tables = findMarkdownTableBlocks(withoutCode.text);
  if (!withoutCode.removed && tables.length === 0 && !hasDominantPathContent(normalizedInput)) {
    return normalizedInput;
  }
  return buildFinalTtsSummary(normalizedInput, FINAL_TTS_SPOKEN_PREVIEW_MAX_CHARS);
}

export function buildFinalTtsCaptionPreview(text: string): string | undefined {
  // Captions are Telegram UI snippets, so they are always bounded even when the
  // spoken TTS can safely use the complete plain final answer.
  return buildFinalTtsSummary(text);
}
