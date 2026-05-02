import { findCodeRegions, isInsideCode } from "./code-regions.js";
import { stripReasoningTagsFromText } from "./reasoning-tags.js";

const MEMORY_TAG_RE = /<\s*(\/?)\s*relevant[-_]memories\b[^<>]*>/gi;
const MEMORY_TAG_QUICK_RE = /<\s*\/?\s*relevant[-_]memories\b/i;
const TOOL_CALL_QUICK_RE =
  /<\s*\/?\s*(?:tool_call|tool_result|function_calls?|function|tool_calls)\b/i;
const TOOL_CALL_TAG_NAMES = new Set([
  "tool_call",
  "tool_result",
  "function_call",
  "function_calls",
  "function",
  "tool_calls",
]);
const TOOL_CALL_JSON_PAYLOAD_START_RE =
  /^\s*(?:\r?\n\s*)?(?:\{|\[|"(?:arguments_json|arguments|name|call_id)"\s*:)/i;
const TOOL_CALL_XML_PAYLOAD_START_RE =
  /^\s*(?:\r?\n\s*)?<(?:function|invoke|parameters?|arguments?)\b/i;

type ToolCallPayloadKind = "json" | "xml" | null;
type ParsedToolCallTag = {
  tagName: string;
  isClose: boolean;
  isSelfClosing: boolean;
  isTruncated: boolean;
  contentStart: number;
  end: number;
};

function stripRelevantMemoriesTags(text: string): string {
  if (!text || !MEMORY_TAG_QUICK_RE.test(text)) {
    return text;
  }
  MEMORY_TAG_RE.lastIndex = 0;

  const codeRegions = findCodeRegions(text);
  let result = "";
  let lastIndex = 0;
  let inMemoryBlock = false;

  for (const match of text.matchAll(MEMORY_TAG_RE)) {
    const idx = match.index ?? 0;
    if (isInsideCode(idx, codeRegions)) {
      continue;
    }

    const isClose = match[1] === "/";
    if (!inMemoryBlock) {
      result += text.slice(lastIndex, idx);
      if (!isClose) {
        inMemoryBlock = true;
      }
    } else if (isClose) {
      inMemoryBlock = false;
    }

    lastIndex = idx + match[0].length;
  }

  if (!inMemoryBlock) {
    result += text.slice(lastIndex);
  }

  return result;
}

function endsInsideQuotedString(text: string, start: number, end: number): boolean {
  let quoteChar: "'" | '"' | null = null;
  let isEscaped = false;
  for (let i = start; i < end; i += 1) {
    const ch = text[i];
    if (quoteChar) {
      if (isEscaped) {
        isEscaped = false;
      } else if (ch === "\\") {
        isEscaped = true;
      } else if (ch === quoteChar) {
        quoteChar = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quoteChar = ch;
    }
  }
  return quoteChar !== null;
}

function findTagCloseIndex(text: string, start: number): number {
  let quoteChar: "'" | '"' | null = null;
  let isEscaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (quoteChar) {
      if (isEscaped) {
        isEscaped = false;
      } else if (ch === "\\") {
        isEscaped = true;
      } else if (ch === quoteChar) {
        quoteChar = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quoteChar = ch;
      continue;
    }
    if (ch === ">") {
      return i;
    }
  }
  return -1;
}

function parseToolCallTagAt(text: string, start: number): ParsedToolCallTag | null {
  if (text[start] !== "<") {
    return null;
  }
  let idx = start + 1;
  while (idx < text.length && /\s/.test(text[idx])) {
    idx += 1;
  }
  const isClose = text[idx] === "/";
  if (isClose) {
    idx += 1;
    while (idx < text.length && /\s/.test(text[idx])) {
      idx += 1;
    }
  }
  const nameStart = idx;
  while (idx < text.length && /[A-Za-z0-9_:-]/.test(text[idx])) {
    idx += 1;
  }
  const tagName = text.slice(nameStart, idx).toLowerCase();
  if (!TOOL_CALL_TAG_NAMES.has(tagName)) {
    return null;
  }

  const closeIndex = findTagCloseIndex(text, idx);
  const isTruncated = closeIndex < 0;
  const end = isTruncated ? text.length : closeIndex + 1;
  const beforeClose = text.slice(idx, isTruncated ? text.length : closeIndex).trimEnd();
  return {
    tagName,
    isClose,
    isSelfClosing: beforeClose.endsWith("/"),
    isTruncated,
    contentStart: idx,
    end,
  };
}

function detectToolCallPayloadKind(text: string, start: number): ToolCallPayloadKind {
  const rest = text.slice(start);
  if (TOOL_CALL_JSON_PAYLOAD_START_RE.test(rest)) {
    return "json";
  }
  if (TOOL_CALL_XML_PAYLOAD_START_RE.test(rest)) {
    return "xml";
  }
  return null;
}

function isLikelyStandaloneFunctionToolCall(
  text: string,
  tagStart: number,
  tag: ParsedToolCallTag,
): boolean {
  if (tag.tagName !== "function" || tag.isClose || tag.isSelfClosing || tag.isTruncated) {
    return false;
  }
  if (!/\bname\s*=/.test(text.slice(tag.contentStart, tag.end))) {
    return false;
  }

  // Bare `<function>` is also valid prose/XML. Only strip when the tag starts
  // where model-emitted tool-call syntax usually appears: at a boundary after
  // whitespace/newline or after a sentence lead-in.
  let idx = tagStart - 1;
  while (idx >= 0 && (text[idx] === " " || text[idx] === "\t")) {
    idx -= 1;
  }
  return idx < 0 || text[idx] === "\n" || text[idx] === "\r" || /[.!?:]/.test(text[idx]);
}

export function stripToolCallXmlTags(text: string): string {
  if (!text || !TOOL_CALL_QUICK_RE.test(text)) {
    return text;
  }

  const codeRegions = findCodeRegions(text);
  let result = "";
  let lastIndex = 0;
  let inToolCallBlock = false;
  let toolCallBlockContentStart = 0;
  let toolCallBlockNeedsQuoteBalance = false;
  let toolCallBlockStart = 0;
  let toolCallBlockTagName: string | null = null;
  const visibleTagBalance = new Map<string, number>();

  for (let idx = 0; idx < text.length; idx += 1) {
    if (text[idx] !== "<" || isInsideCode(idx, codeRegions)) {
      continue;
    }
    const tag = parseToolCallTagAt(text, idx);
    if (!tag) {
      continue;
    }

    if (!inToolCallBlock) {
      if (tag.isClose) {
        const visibleCount = visibleTagBalance.get(tag.tagName) ?? 0;
        if (visibleCount > 0) {
          visibleTagBalance.set(tag.tagName, visibleCount - 1);
          idx = tag.end - 1;
          continue;
        }
        result += text.slice(lastIndex, idx);
        lastIndex = tag.end;
        idx = tag.end - 1;
        continue;
      }
      const payloadStart = tag.isTruncated ? tag.contentStart : tag.end;
      const payloadKind =
        tag.tagName === "tool_call" || tag.tagName === "function"
          ? detectToolCallPayloadKind(text, payloadStart)
          : TOOL_CALL_JSON_PAYLOAD_START_RE.test(text.slice(payloadStart))
            ? "json"
            : null;
      const shouldStripStandaloneFunction =
        tag.tagName !== "function" || isLikelyStandaloneFunctionToolCall(text, idx, tag);
      if (payloadKind && shouldStripStandaloneFunction) {
        result += text.slice(lastIndex, idx);
        inToolCallBlock = true;
        toolCallBlockContentStart = tag.end;
        toolCallBlockNeedsQuoteBalance = payloadKind === "json";
        toolCallBlockStart = idx;
        toolCallBlockTagName = tag.tagName;
        if (tag.isTruncated) {
          lastIndex = text.length;
          break;
        }
        lastIndex = tag.end;
      }
      if (!tag.isSelfClosing && !tag.isTruncated) {
        visibleTagBalance.set(tag.tagName, (visibleTagBalance.get(tag.tagName) ?? 0) + 1);
      }
      idx = tag.end - 1;
      continue;
    }

    if (
      tag.isClose &&
      (tag.tagName === toolCallBlockTagName ||
        (toolCallBlockTagName === "tool_result" && tag.tagName === "tool_call")) &&
      (!toolCallBlockNeedsQuoteBalance ||
        !endsInsideQuotedString(text, toolCallBlockContentStart, idx))
    ) {
      inToolCallBlock = false;
      toolCallBlockNeedsQuoteBalance = false;
      toolCallBlockTagName = null;
      lastIndex = tag.end;
    }
    idx = tag.end - 1;
  }

  if (!inToolCallBlock) {
    result += text.slice(lastIndex);
  } else if (toolCallBlockTagName === "function") {
    result += text.slice(toolCallBlockStart);
  }
  return result;
}

export function stripAssistantInternalScaffolding(text: string): string {
  const withoutReasoning = stripReasoningTagsFromText(text, { mode: "preserve", trim: "start" });
  return stripToolCallXmlTags(stripRelevantMemoriesTags(withoutReasoning)).trimStart();
}
