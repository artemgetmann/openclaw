import type { Bot } from "grammy";
import type { TelegramThreadSpec } from "./bot/helpers.js";
import type { TelegramDeleteAuditMetadata } from "./delete-guard.js";
import {
  createTelegramDraftStream,
  type TelegramDraftDurableSendEvent,
  type TelegramDraftStream,
} from "./draft-stream.js";

type ProgressPreview = {
  text: string;
  parseMode?: "HTML";
};

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
  previewTransport?: "auto" | "message" | "draft";
  replyToMessageId?: number;
  throttleMs?: number;
  minInitialChars?: number;
  deleteAudit?: Partial<
    Pick<
      TelegramDeleteAuditMetadata,
      "accountId" | "callsite" | "classification" | "lane" | "reason" | "sessionId" | "topicId"
    >
  >;
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
    previewTransport: params.previewTransport ?? "auto",
    replyToMessageId: params.replyToMessageId,
    ...(params.throttleMs != null ? { throttleMs: params.throttleMs } : {}),
    minInitialChars: params.minInitialChars,
    deleteAudit: {
      callsite: params.deleteAudit?.callsite ?? "telegram-progress-controller-clear",
      reason: params.deleteAudit?.reason ?? "progress_cleanup",
      accountId: params.deleteAudit?.accountId,
      lane: params.deleteAudit?.lane ?? "answer",
      classification: params.deleteAudit?.classification ?? "progress",
      sessionId: params.deleteAudit?.sessionId,
      topicId: params.deleteAudit?.topicId,
    },
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
    const retained: string[] = [
      latestEntry.length > maxProgressChars ? latestEntry.slice(0, maxProgressChars) : latestEntry,
    ];
    for (let index = progressEntries.length - 2; index >= 0; index -= 1) {
      const candidate = [progressEntries[index], ...retained].join(PROGRESS_ENTRY_SEPARATOR);
      // This text is shown directly in Telegram previews/drafts. Do not add a
      // synthetic "omitted" marker here; users can see it before cleanup, and
      // the final answer delivery owns the durable transcript.
      if (candidate.length > maxProgressChars) {
        continue;
      }
      retained.unshift(progressEntries[index]);
    }
    return retained.join(PROGRESS_ENTRY_SEPARATOR);
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
      // Final-answer delivery owns the durable transcript. Progress cleanup
      // should remove the current preview quickly, not force one last pending
      // edit that can briefly duplicate the final answer before deletion.
      await stream.clear();
    },
    messageId: () => stream.messageId(),
  };
}
