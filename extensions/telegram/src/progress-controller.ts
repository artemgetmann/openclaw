import type { InlineKeyboardMarkup } from "@grammyjs/types";
import type { Bot } from "grammy";
import type { TelegramThreadSpec } from "./bot/helpers.js";
import type { TelegramDeleteAuditMetadata } from "./delete-guard.js";
import {
  createTelegramDraftStream,
  type TelegramDraftDurableSendEvent,
  type TelegramDraftPreviewTraceEvent,
  type TelegramDraftStream,
} from "./draft-stream.js";
import {
  buildTelegramWorkLogReplyMarkup,
  registerTelegramWorkLog,
  renderTelegramWorkLog,
} from "./work-log.js";

type ProgressPreview = {
  text: string;
  parseMode?: "HTML";
};

const PROGRESS_ENTRY_SEPARATOR = "\n\n";
const PROGRESS_RENDER_HEADROOM_CHARS = 64;

export type TelegramProgressController = {
  start: (text: string) => void;
  update: (text: string) => void;
  preview: (text: string) => void;
  updatePlan: (text: string) => void;
  clear: (options?: { flushBeforeDelete?: boolean; waitForInFlight?: boolean }) => Promise<void>;
  materialize: () => Promise<number | undefined>;
  retainAsWorkLog: (options?: { toolNames?: readonly string[] }) => Promise<
    | {
        retained: true;
        messageId: number;
        workLogId: string;
      }
    | { retained: false }
  >;
  messageId: () => number | undefined;
  lastText: () => string;
};

export function createTelegramProgressController(params: {
  api: Bot["api"];
  chatId: number;
  maxChars: number;
  stream?: TelegramDraftStream;
  thread?: TelegramThreadSpec | null;
  previewTransport?: "auto" | "message" | "draft";
  replyToMessageId?: number;
  throttleMs?: number;
  minInitialChars?: number;
  activeReplyMarkup?: InlineKeyboardMarkup;
  onDispose?: () => void;
  deleteAudit?: Partial<
    Pick<
      TelegramDeleteAuditMetadata,
      "accountId" | "callsite" | "classification" | "lane" | "reason" | "sessionId" | "topicId"
    >
  >;
  renderText: (text: string) => ProgressPreview;
  onMessageDelivered?: (messageId: number, event: TelegramDraftDurableSendEvent) => void;
  onPreviewAttempt?: (event: TelegramDraftPreviewTraceEvent) => void;
  onPreviewComplete?: (event: TelegramDraftPreviewTraceEvent) => void;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): TelegramProgressController {
  const maxProgressChars = Math.max(
    1,
    params.maxChars > PROGRESS_RENDER_HEADROOM_CHARS * 2
      ? params.maxChars - PROGRESS_RENDER_HEADROOM_CHARS
      : params.maxChars,
  );
  const stream: TelegramDraftStream =
    params.stream ??
    createTelegramDraftStream({
      api: params.api,
      chatId: params.chatId,
      maxChars: params.maxChars,
      thread: params.thread,
      previewTransport: params.previewTransport ?? "auto",
      replyToMessageId: params.replyToMessageId,
      ...(params.throttleMs != null ? { throttleMs: params.throttleMs } : {}),
      minInitialChars: params.minInitialChars,
      replyMarkup: params.activeReplyMarkup,
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
      onPreviewAttempt: params.onPreviewAttempt,
      onPreviewComplete: params.onPreviewComplete,
      log: params.log,
      warn: params.warn,
    });
  let hasProgress = false;
  let cleared = false;
  let lastRenderedProgressText = "";
  const progressEntries: string[] = [];
  const progressEntryKeys = new Set<string>();
  let planEntryIndex: number | undefined;
  let disposed = false;

  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    params.onDispose?.();
  };

  const removeActiveReplyMarkup = async (messageId: number | undefined) => {
    if (!params.activeReplyMarkup || typeof messageId !== "number") {
      return;
    }
    try {
      await params.api.editMessageReplyMarkup(params.chatId, messageId, {
        reply_markup: { inline_keyboard: [] },
      });
    } catch (err) {
      params.warn?.(
        `telegram active run controls cleanup failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };

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

  const upsertPlanEntry = (text: string) => {
    // A plan is one logical Work log entry even though its checklist spans
    // multiple lines. Preserve its original position after the acknowledgment,
    // then replace only that slot as update_plan publishes newer snapshots.
    const planText = text
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n")
      .trim();
    if (!planText) {
      return false;
    }
    const nextKey = normalizeProgressEntryKey(planText);
    if (planEntryIndex == null) {
      planEntryIndex = progressEntries.length;
      progressEntries.push(planText);
      progressEntryKeys.add(nextKey);
      return true;
    }
    const previousPlan = progressEntries[planEntryIndex];
    if (previousPlan === planText) {
      return false;
    }
    if (previousPlan) {
      progressEntryKeys.delete(normalizeProgressEntryKey(previousPlan));
    }
    progressEntries[planEntryIndex] = planText;
    progressEntryKeys.add(nextKey);
    return true;
  };

  const renderProgressHistory = (previewText?: string) => {
    const previewEntry = previewText?.trim();
    const entries = previewEntry ? [...progressEntries, previewEntry] : progressEntries;
    const fullText = entries.join(PROGRESS_ENTRY_SEPARATOR);
    if (fullText.length <= maxProgressChars) {
      return fullText;
    }

    const latestEntry = entries[entries.length - 1] ?? "";
    const truncateEntry = (entry: string) => {
      if (entry.length <= maxProgressChars) {
        return entry;
      }
      const lines = entry.split("\n").filter(Boolean);
      if (lines.length <= 1) {
        return entry.slice(0, maxProgressChars);
      }
      // For a multiline plan snapshot, keep its label plus the newest rows.
      // The newest checklist state is more useful than an arbitrary prefix.
      const firstLine = lines[0] ?? "";
      const retained = [lines.at(-1) ?? ""];
      for (let index = lines.length - 2; index > 0; index -= 1) {
        const candidate = [firstLine, lines[index], ...retained].join("\n");
        if (candidate.length > maxProgressChars) {
          continue;
        }
        retained.unshift(lines[index]);
      }
      const result = [firstLine, ...retained].join("\n");
      if (result.length <= maxProgressChars) {
        return result;
      }
      const tailBudget = Math.max(0, maxProgressChars - firstLine.length - 1);
      const lastLine = retained.at(-1) ?? "";
      return `${firstLine}\n${lastLine.slice(-tailBudget)}`.slice(0, maxProgressChars);
    };
    const retained: string[] = [truncateEntry(latestEntry)];
    for (let index = entries.length - 2; index >= 0; index -= 1) {
      const candidate = [entries[index], ...retained].join(PROGRESS_ENTRY_SEPARATOR);
      // This text is shown directly in Telegram previews/drafts. Do not add a
      // synthetic "omitted" marker here; users can see it before cleanup, and
      // the final answer delivery owns the durable transcript.
      if (candidate.length > maxProgressChars) {
        continue;
      }
      retained.unshift(entries[index]);
    }
    return retained.join(PROGRESS_ENTRY_SEPARATOR);
  };
  const readProgressEntriesForWorkLog = () => {
    if (progressEntries.length > 0) {
      return progressEntries;
    }
    return lastRenderedProgressText
      .split(/\n+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  };

  return {
    start: (text: string) => {
      if (cleared || hasProgress) {
        return;
      }
      const placeholder = text.trim();
      if (!placeholder) {
        return;
      }
      lastRenderedProgressText = placeholder;
      stream.update(placeholder);
    },
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
      lastRenderedProgressText = cumulativeProgressText;
      stream.update(cumulativeProgressText);
    },
    preview: (text: string) => {
      if (cleared) {
        return;
      }
      const progressText = text.trim();
      if (!progressText) {
        return;
      }
      const previewProgressText = renderProgressHistory(progressText);
      if (!previewProgressText) {
        return;
      }
      hasProgress = true;
      lastRenderedProgressText = previewProgressText;
      stream.update(previewProgressText);
    },
    updatePlan: (text: string) => {
      if (cleared) {
        return;
      }
      const progressText = text.trim();
      if (!progressText) {
        return;
      }
      if (!upsertPlanEntry(progressText)) {
        return;
      }
      const cumulativeProgressText = renderProgressHistory();
      if (!cumulativeProgressText) {
        return;
      }
      hasProgress = true;
      lastRenderedProgressText = cumulativeProgressText;
      stream.update(cumulativeProgressText);
    },
    clear: async (options?: { flushBeforeDelete?: boolean; waitForInFlight?: boolean }) => {
      if (cleared) {
        return;
      }
      cleared = true;
      if (options?.flushBeforeDelete !== false) {
        // Normal progress cleanup flushes pending progress edits before
        // deletion so "step 1 -> step 2 -> cleanup" cannot collapse into a
        // stale visible bubble under Telegram preview throttling.
        await stream.flush();
      }
      // Remove the control before deleting the transient bubble. If Telegram
      // rejects the delete, the stale button still cannot stop a later run.
      await removeActiveReplyMarkup(stream.messageId());
      // Final-answer cleanup can explicitly skip in-flight preview edits. At
      // that point the next durable message is the final answer, so deleting
      // the visible progress bubble beats faithfully rendering stale progress.
      try {
        await stream.clear({ waitForInFlight: options?.waitForInFlight });
      } finally {
        dispose();
      }
    },
    materialize: async () => {
      if (cleared || !hasProgress) {
        return undefined;
      }
      // A natural acknowledgment can initially use the progress transport, but
      // a later structured plan must not overwrite it. Flush and materialize
      // the existing text unchanged; ownership moves to a fresh controller only
      // after Telegram confirms this message has a durable identity.
      await stream.flush();
      const messageId = await stream.materialize?.();
      if (typeof messageId !== "number") {
        // materialize() stops the draft stream before it can discover that no
        // durable ID is available. Reopen the same controller generation so the
        // caller's established replacement fallback can still render the plan.
        stream.forceNewMessage();
        return undefined;
      }
      await removeActiveReplyMarkup(messageId);
      cleared = true;
      dispose();
      return messageId;
    },
    retainAsWorkLog: async (options?: { toolNames?: readonly string[] }) => {
      if (cleared || !hasProgress) {
        return { retained: false };
      }
      const workLog = registerTelegramWorkLog({
        progressEntries: readProgressEntriesForWorkLog(),
        // Persist the real structured plan slot only when this controller
        // actually tracked one. Without that metadata, a generic second update
        // would get pinned and could evict fresher progress from Work log.
        pinnedPlanEntry: planEntryIndex != null ? progressEntries[planEntryIndex] : undefined,
        toolNames: options?.toolNames,
      });
      if (!workLog) {
        return { retained: false };
      }
      const collapsed = renderTelegramWorkLog(workLog, false);
      cleared = true;
      // Retention converts the mutable progress bubble in place before final
      // delivery starts. That keeps Telegram ordering stable: Work log first,
      // then a separate final answer message.
      stream.update(collapsed.text);
      await stream.flush();
      const messageId = await stream.materialize?.();
      if (typeof messageId !== "number") {
        return { retained: false };
      }
      try {
        await params.api.editMessageText(params.chatId, messageId, collapsed.text, {
          reply_markup: buildTelegramWorkLogReplyMarkup(collapsed),
        });
      } catch (err) {
        params.warn?.(
          `telegram work log buttons failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        dispose();
      }
      return { retained: true, messageId, workLogId: workLog.id };
    },
    messageId: () => stream.messageId(),
    lastText: () => lastRenderedProgressText,
  };
}
