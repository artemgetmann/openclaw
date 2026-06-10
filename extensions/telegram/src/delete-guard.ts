import { createHash } from "node:crypto";
import type { Bot } from "grammy";
import { createSubsystemLogger } from "../../../src/logging/subsystem.js";
import type { TelegramThreadSpec } from "./bot/helpers.js";

export const TELEGRAM_DELETE_ENABLE_ENV = "OPENCLAW_TELEGRAM_ENABLE_DELETES";

type TelegramDeleteApi = Pick<Bot["api"], "deleteMessage">;

export type TelegramDeleteSafetyMode = "operator_opt_in" | "deterministic_cleanup";

export type TelegramDeleteAuditMetadata = {
  callsite: string;
  reason: string;
  chatId: string | number;
  messageId: number;
  safetyMode?: TelegramDeleteSafetyMode;
  accountId?: string | null;
  lane?: string;
  classification?: string;
  sessionId?: string;
  topicId?: string | number;
  thread?: TelegramThreadSpec | null;
};

export type TelegramDeleteAuditEvent =
  | "delete_suppressed"
  | "delete_attempt"
  | "delete_success"
  | "delete_failure";

export type TelegramDeleteAuditLogger = {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
};

export type GuardedTelegramDeleteResult =
  | { ok: true; deleted: true; suppressed?: false }
  | { ok: true; deleted: false; suppressed: true };

const deleteAuditLogger = createSubsystemLogger("telegram/delete-audit");

// Deletes are destructive and customer-visible. Arbitrary operator/model/tool
// deletes need a hard env opt-in that is separate from normal Telegram action
// exposure, so merely enabling an action surface cannot silently erase history.
function normalizeOptIn(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function areTelegramDeletesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return normalizeOptIn(env[TELEGRAM_DELETE_ENABLE_ENV]);
}

function resolveSafetyMode(value: TelegramDeleteSafetyMode | undefined): TelegramDeleteSafetyMode {
  return value ?? "operator_opt_in";
}

function isDeleteAllowed(params: {
  safetyMode: TelegramDeleteSafetyMode;
  env?: NodeJS.ProcessEnv;
}): boolean {
  // Deterministic cleanup is restricted to code-owned transient message ids
  // captured from the current preview/progress lifecycle. It preserves the
  // desired UX without letting model-authored delete tools erase arbitrary
  // Telegram messages.
  if (params.safetyMode === "deterministic_cleanup") {
    return true;
  }
  return areTelegramDeletesEnabled(params.env);
}

function hashIdentifier(value: string | number | null | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }
  const normalized = String(value).trim();
  if (!normalized) {
    return undefined;
  }
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `sha256:${digest}`;
}

function sanitizeMessageId(messageId: number): number {
  if (!Number.isFinite(messageId)) {
    return 0;
  }
  return Math.trunc(messageId);
}

export function buildTelegramDeleteAuditFields(
  event: TelegramDeleteAuditEvent,
  metadata: TelegramDeleteAuditMetadata,
  error?: unknown,
): Record<string, unknown> {
  const safetyMode = resolveSafetyMode(metadata.safetyMode);
  const threadId = metadata.thread?.id ?? metadata.topicId;
  const fields: Record<string, unknown> = {
    event,
    callsite: metadata.callsite,
    reason: metadata.reason,
    safetyMode,
    chatIdHash: hashIdentifier(metadata.chatId),
    messageId: sanitizeMessageId(metadata.messageId),
  };
  const accountIdHash = hashIdentifier(metadata.accountId);
  if (accountIdHash) {
    fields.accountIdHash = accountIdHash;
  }
  if (metadata.lane) {
    fields.lane = metadata.lane;
  }
  if (metadata.classification) {
    fields.classification = metadata.classification;
  }
  // Session keys can include raw chat ids. Hash them for correlation without
  // reintroducing the identity we intentionally remove from chatIdHash.
  const sessionIdHash = hashIdentifier(metadata.sessionId);
  if (sessionIdHash) {
    fields.sessionIdHash = sessionIdHash;
  }
  if (threadId != null) {
    fields.threadId = String(threadId);
  }
  if (error != null) {
    fields.error = error instanceof Error ? error.message : String(error);
  }
  return fields;
}

function logTelegramDeleteAuditEvent(params: {
  logger: TelegramDeleteAuditLogger;
  event: TelegramDeleteAuditEvent;
  metadata: TelegramDeleteAuditMetadata;
  error?: unknown;
}) {
  const fields = buildTelegramDeleteAuditFields(params.event, params.metadata, params.error);
  const message = `telegram delete audit: ${params.event}`;
  if (params.event === "delete_failure" || params.event === "delete_suppressed") {
    params.logger.warn(message, fields);
    return;
  }
  params.logger.info(message, fields);
}

export async function guardedTelegramDeleteMessage(params: {
  api: TelegramDeleteApi;
  chatId: string | number;
  messageId: number;
  audit: Omit<TelegramDeleteAuditMetadata, "chatId" | "messageId">;
  env?: NodeJS.ProcessEnv;
  logger?: TelegramDeleteAuditLogger;
}): Promise<GuardedTelegramDeleteResult> {
  const metadata: TelegramDeleteAuditMetadata = {
    ...params.audit,
    chatId: params.chatId,
    messageId: sanitizeMessageId(params.messageId),
  };
  const safetyMode = resolveSafetyMode(metadata.safetyMode);
  const logger = params.logger ?? deleteAuditLogger;
  if (!isDeleteAllowed({ safetyMode, env: params.env })) {
    logTelegramDeleteAuditEvent({
      logger,
      event: "delete_suppressed",
      metadata,
    });
    return { ok: true, deleted: false, suppressed: true };
  }
  logTelegramDeleteAuditEvent({
    logger,
    event: "delete_attempt",
    metadata,
  });
  try {
    await params.api.deleteMessage(params.chatId, metadata.messageId);
    logTelegramDeleteAuditEvent({
      logger,
      event: "delete_success",
      metadata,
    });
    return { ok: true, deleted: true };
  } catch (err) {
    logTelegramDeleteAuditEvent({
      logger,
      event: "delete_failure",
      metadata,
      error: err,
    });
    throw err;
  }
}
