import type { Bot } from "grammy";
import type { TelegramThreadSpec } from "./bot/helpers.js";
import {
  createTelegramDraftStream,
  type TelegramDraftDurableSendEvent,
  type TelegramDraftStream,
} from "./draft-stream.js";

type ProgressPreview = {
  text: string;
  parseMode?: "HTML";
};

const OMITTED_PROGRESS_PREFIX = "[earlier progress omitted]";
const PROGRESS_ENTRY_SEPARATOR = "\n\n";
const PROGRESS_RENDER_HEADROOM_CHARS = 64;

export type TelegramProgressController = {
  update: (text: string) => void;
  clear: () => Promise<void>;
  messageId: () => number | undefined;
};

export function createTelegramProgressController(params: {
  api: Bot["api"];
  chatId: number;
  maxChars: number;
  thread?: TelegramThreadSpec | null;
  replyToMessageId?: number;
  minInitialChars?: number;
  renderText: (text: string) => ProgressPreview;
  onMessageDelivered?: (messageId: number, event: TelegramDraftDurableSendEvent) => void;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): TelegramProgressController {
  const maxProgressChars = Math.max(
    1,
    params.maxChars > PROGRESS_RENDER_HEADROOM_CHARS * 2
      ? params.maxChars - PROGRESS_RENDER_HEADROOM_CHARS
      : params.maxChars,
  );
  const stream: TelegramDraftStream = createTelegramDraftStream({
    api: params.api,
    chatId: params.chatId,
    maxChars: params.maxChars,
    thread: params.thread,
    previewTransport: "message",
    replyToMessageId: params.replyToMessageId,
    minInitialChars: params.minInitialChars,
    renderText: params.renderText,
    onMessageDelivered: params.onMessageDelivered,
    log: params.log,
    warn: params.warn,
  });
  let hasProgress = false;
  let cleared = false;
  const progressEntries: string[] = [];
  const progressEntryKeys = new Set<string>();

  const normalizeProgressEntryKey = (entry: string) => entry.replace(/\s+/g, " ").trim();

  const appendProgressEntries = (text: string) => {
    let didAppend = false;
    // Providers can deliver one status per block or an already-joined block.
    // Store one logical line per entry so repeated cumulative snapshots do not
    // duplicate earlier progress inside the single transient Telegram bubble.
    for (const rawEntry of text.split(/\n+/)) {
      const entry = rawEntry.trim();
      if (!entry) {
        continue;
      }
      const key = normalizeProgressEntryKey(entry);
      if (progressEntryKeys.has(key)) {
        continue;
      }
      progressEntryKeys.add(key);
      progressEntries.push(entry);
      didAppend = true;
    }
    return didAppend;
  };

  const renderProgressHistory = () => {
    const fullText = progressEntries.join(PROGRESS_ENTRY_SEPARATOR);
    if (fullText.length <= maxProgressChars) {
      return fullText;
    }

    const latestEntry = progressEntries[progressEntries.length - 1] ?? "";
    const maxEntryChars =
      maxProgressChars - OMITTED_PROGRESS_PREFIX.length - PROGRESS_ENTRY_SEPARATOR.length;
    if (maxEntryChars <= 0) {
      return latestEntry.slice(0, maxProgressChars);
    }

    const retained: string[] = [
      latestEntry.length > maxEntryChars ? latestEntry.slice(0, maxEntryChars) : latestEntry,
    ];
    for (let index = progressEntries.length - 2; index >= 0; index -= 1) {
      const candidate = [progressEntries[index], ...retained].join(PROGRESS_ENTRY_SEPARATOR);
      const prefixedCandidate = `${OMITTED_PROGRESS_PREFIX}${PROGRESS_ENTRY_SEPARATOR}${candidate}`;
      if (prefixedCandidate.length > maxProgressChars) {
        continue;
      }
      retained.unshift(progressEntries[index]);
    }
    return `${OMITTED_PROGRESS_PREFIX}${PROGRESS_ENTRY_SEPARATOR}${retained.join(PROGRESS_ENTRY_SEPARATOR)}`;
  };

  return {
    update: (text: string) => {
      if (cleared) {
        return;
      }
      const progressText = text.trim();
      if (!progressText) {
        return;
      }
      if (!appendProgressEntries(progressText)) {
        return;
      }
      const cumulativeProgressText = renderProgressHistory();
      if (!cumulativeProgressText) {
        return;
      }
      hasProgress = true;
      stream.update(cumulativeProgressText);
    },
    clear: async () => {
      if (cleared) {
        return;
      }
      cleared = true;
      if (hasProgress || typeof stream.messageId() === "number") {
        // Clear should leave proof of the latest visible progress state before
        // deleting it. The draft stream's raw clear intentionally cancels pending
        // edits; the progress controller owns the stricter finalization contract.
        await stream.flush();
      }
      await stream.clear();
    },
    messageId: () => stream.messageId(),
  };
}
