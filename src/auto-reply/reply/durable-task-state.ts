import { generateSecureUuid } from "../../infra/secure-random.js";
import type { ReplyPayload } from "../types.js";
import { isRenderablePayload, shouldSuppressReasoningPayload } from "./reply-payloads.js";
import { isExplicitAgentTimeoutPayload } from "./timeout-continuation.js";

const EVIDENCE_TEXT_MAX_CHARS = 280;
const TASKS_BY_ID = new Map<string, DurableReplyTaskRecord>();
const TASK_IDS_BY_KEY = new Map<string, Set<string>>();

export type DurableReplyTaskStatus =
  | "running"
  | "timed_out"
  | "exhausted"
  | "completed"
  | "canceled";

export type DurableReplyTaskEvidence = {
  source: "tool_result" | "partial_reply" | "block_reply" | "payload";
  text?: string;
  hasMedia: boolean;
  updatedAt: number;
};

export type DurableReplyTaskRecord = {
  taskId: string;
  sessionKey?: string;
  sessionId?: string;
  status: DurableReplyTaskStatus;
  attemptCount: number;
  maxAttempts: number;
  maxWallClockMs: number;
  startedAt: number;
  updatedAt: number;
  cancelRequested: boolean;
  lastEvidenceSnapshot?: DurableReplyTaskEvidence;
  fallbackHistory: string[];
};

function nowMs(): number {
  return Date.now();
}

function normalizeKey(key?: string): string | undefined {
  const trimmed = key?.trim();
  return trimmed || undefined;
}

function indexTaskKey(key: string | undefined, taskId: string): void {
  const normalized = normalizeKey(key);
  if (!normalized) {
    return;
  }
  const existing = TASK_IDS_BY_KEY.get(normalized) ?? new Set<string>();
  existing.add(taskId);
  TASK_IDS_BY_KEY.set(normalized, existing);
}

function removeTaskIndex(record: DurableReplyTaskRecord): void {
  for (const key of [record.sessionKey, record.sessionId]) {
    const normalized = normalizeKey(key);
    if (!normalized) {
      continue;
    }
    const ids = TASK_IDS_BY_KEY.get(normalized);
    if (!ids) {
      continue;
    }
    ids.delete(record.taskId);
    if (ids.size === 0) {
      TASK_IDS_BY_KEY.delete(normalized);
    }
  }
}

function truncateEvidenceText(text: string | undefined): string | undefined {
  const normalized = text?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= EVIDENCE_TEXT_MAX_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, EVIDENCE_TEXT_MAX_CHARS - 1).trimEnd()}…`;
}

function payloadHasMedia(payload: ReplyPayload): boolean {
  return Boolean(
    payload.mediaUrl || (Array.isArray(payload.mediaUrls) && payload.mediaUrls.length > 0),
  );
}

function isEvidencePayload(payload: ReplyPayload): boolean {
  if (shouldSuppressReasoningPayload(payload) || !isRenderablePayload(payload)) {
    return false;
  }
  if (isExplicitAgentTimeoutPayload(payload)) {
    return false;
  }
  return Boolean(truncateEvidenceText(payload.text) || payloadHasMedia(payload));
}

export function startDurableReplyTask(params: {
  sessionKey?: string;
  sessionId?: string;
  maxAttempts: number;
  maxWallClockMs: number;
}): DurableReplyTaskRecord {
  const timestamp = nowMs();
  const record: DurableReplyTaskRecord = {
    taskId: generateSecureUuid(),
    sessionKey: normalizeKey(params.sessionKey),
    sessionId: normalizeKey(params.sessionId),
    status: "running",
    attemptCount: 0,
    maxAttempts: Math.max(1, Math.floor(params.maxAttempts)),
    maxWallClockMs: Math.max(1, Math.floor(params.maxWallClockMs)),
    startedAt: timestamp,
    updatedAt: timestamp,
    cancelRequested: false,
    fallbackHistory: [],
  };
  TASKS_BY_ID.set(record.taskId, record);
  indexTaskKey(record.sessionKey, record.taskId);
  indexTaskKey(record.sessionId, record.taskId);
  return record;
}

export function recordDurableTaskAttemptStart(record: DurableReplyTaskRecord): void {
  record.attemptCount += 1;
  record.status = "running";
  record.updatedAt = nowMs();
}

export function recordDurableTaskTimeout(record: DurableReplyTaskRecord): void {
  record.status = "timed_out";
  record.updatedAt = nowMs();
}

export function recordDurableTaskEvidence(
  record: DurableReplyTaskRecord,
  source: DurableReplyTaskEvidence["source"],
  payload: ReplyPayload,
): void {
  if (!isEvidencePayload(payload)) {
    return;
  }
  record.lastEvidenceSnapshot = {
    source,
    text: truncateEvidenceText(payload.text),
    hasMedia: payloadHasMedia(payload),
    updatedAt: nowMs(),
  };
  record.updatedAt = record.lastEvidenceSnapshot.updatedAt;
}

export function recordDurableTaskPayloadEvidence(
  record: DurableReplyTaskRecord,
  payloads: ReplyPayload[] | undefined,
): void {
  for (const payload of payloads ?? []) {
    recordDurableTaskEvidence(record, "payload", payload);
  }
}

export function recordDurableTaskFallbackNotice(
  record: DurableReplyTaskRecord,
  notice: string,
): boolean {
  const normalized = notice.replace(/\s+/g, " ").trim();
  if (!normalized || record.fallbackHistory.includes(normalized)) {
    return false;
  }
  record.fallbackHistory.push(normalized);
  record.updatedAt = nowMs();
  return true;
}

export function canStartAnotherDurableTaskAttempt(
  record: DurableReplyTaskRecord,
): { ok: true } | { ok: false; reason: "canceled" | "attempts" | "wall_clock" } {
  if (record.cancelRequested) {
    return { ok: false, reason: "canceled" };
  }
  if (record.attemptCount >= record.maxAttempts) {
    return { ok: false, reason: "attempts" };
  }
  if (nowMs() - record.startedAt >= record.maxWallClockMs) {
    return { ok: false, reason: "wall_clock" };
  }
  return { ok: true };
}

export function completeDurableReplyTask(record: DurableReplyTaskRecord): void {
  record.status = "completed";
  record.updatedAt = nowMs();
  removeTaskIndex(record);
}

export function exhaustDurableReplyTask(record: DurableReplyTaskRecord): void {
  record.status = record.cancelRequested ? "canceled" : "exhausted";
  record.updatedAt = nowMs();
  removeTaskIndex(record);
}

export function cancelDurableReplyTasksForKeys(keys: Array<string | undefined>): number {
  const taskIds = new Set<string>();
  for (const key of keys) {
    const normalized = normalizeKey(key);
    if (!normalized) {
      continue;
    }
    for (const taskId of TASK_IDS_BY_KEY.get(normalized) ?? []) {
      taskIds.add(taskId);
    }
  }

  for (const taskId of taskIds) {
    const record = TASKS_BY_ID.get(taskId);
    if (!record) {
      continue;
    }
    record.cancelRequested = true;
    record.status = "canceled";
    record.updatedAt = nowMs();
  }
  return taskIds.size;
}

export function formatDurableTaskExhaustedFailure(record: DurableReplyTaskRecord): ReplyPayload {
  const evidence = record.lastEvidenceSnapshot;
  const reason =
    record.status === "canceled" || record.cancelRequested
      ? "The task was stopped before another attempt could start."
      : `I hit the task safety budget after ${record.attemptCount}/${record.maxAttempts} attempts.`;
  const evidenceLine = evidence
    ? ` Last evidence: ${evidence.text ?? (evidence.hasMedia ? "media was produced" : "work was observed")}.`
    : "";
  return {
    text: `${reason}${evidenceLine} Next step: send a narrower follow-up or ask me to continue from the current session.`,
    isError: true,
  };
}

export function getDurableReplyTaskForTest(taskId: string): DurableReplyTaskRecord | undefined {
  return TASKS_BY_ID.get(taskId);
}

export function resetDurableReplyTasksForTest(): void {
  TASKS_BY_ID.clear();
  TASK_IDS_BY_KEY.clear();
}
