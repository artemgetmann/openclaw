import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { listAgentIds, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { listChannelPlugins } from "../channels/plugins/index.js";
import type { ChannelId } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { readJsonBodyWithLimit, requestBodyErrorToText } from "../infra/http-body.js";
import type { MonitorEventEnvelope, MonitorEventTriggerKind } from "../monitor/types.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { buildTelegramUserMonitorEventEnvelope } from "../telegram-user/monitor-event.js";
import type { TelegramUserMessage } from "../telegram-user/types.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { type HookMappingResolved, resolveHookMappings } from "./hooks-mapping.js";
import { resolveAllowedAgentIds } from "./hooks-policy.js";

const DEFAULT_HOOKS_PATH = "/hooks";
const DEFAULT_HOOKS_MAX_BODY_BYTES = 256 * 1024;
const MAX_HOOK_IDEMPOTENCY_KEY_LENGTH = 256;
const monitorEventTriggerKinds = new Set<MonitorEventTriggerKind>([
  "webhook",
  "local_listener",
  "process_exit",
  "browser_observer",
]);

export type HooksConfigResolved = {
  basePath: string;
  token: string;
  maxBodyBytes: number;
  mappings: HookMappingResolved[];
  gmailAccount?: string;
  agentPolicy: HookAgentPolicyResolved;
  sessionPolicy: HookSessionPolicyResolved;
};

export type HookAgentPolicyResolved = {
  defaultAgentId: string;
  knownAgentIds: Set<string>;
  allowedAgentIds?: Set<string>;
};

export type HookSessionPolicyResolved = {
  defaultSessionKey?: string;
  allowRequestSessionKey: boolean;
  allowedSessionKeyPrefixes?: string[];
};

export function resolveHooksConfig(cfg: OpenClawConfig): HooksConfigResolved | null {
  if (cfg.hooks?.enabled !== true) {
    return null;
  }
  const token = cfg.hooks?.token?.trim();
  if (!token) {
    throw new Error("hooks.enabled requires hooks.token");
  }
  const rawPath = cfg.hooks?.path?.trim() || DEFAULT_HOOKS_PATH;
  const withSlash = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const trimmed = withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
  if (trimmed === "/") {
    throw new Error("hooks.path may not be '/'");
  }
  const maxBodyBytes =
    cfg.hooks?.maxBodyBytes && cfg.hooks.maxBodyBytes > 0
      ? cfg.hooks.maxBodyBytes
      : DEFAULT_HOOKS_MAX_BODY_BYTES;
  const mappings = resolveHookMappings(cfg.hooks);
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const knownAgentIds = resolveKnownAgentIds(cfg, defaultAgentId);
  const allowedAgentIds = resolveAllowedAgentIds(cfg.hooks?.allowedAgentIds);
  const defaultSessionKey = resolveSessionKey(cfg.hooks?.defaultSessionKey);
  const allowedSessionKeyPrefixes = resolveAllowedSessionKeyPrefixes(
    cfg.hooks?.allowedSessionKeyPrefixes,
  );
  if (
    defaultSessionKey &&
    allowedSessionKeyPrefixes &&
    !isSessionKeyAllowedByPrefix(defaultSessionKey, allowedSessionKeyPrefixes)
  ) {
    throw new Error("hooks.defaultSessionKey must match hooks.allowedSessionKeyPrefixes");
  }
  if (
    !defaultSessionKey &&
    allowedSessionKeyPrefixes &&
    !isSessionKeyAllowedByPrefix("hook:example", allowedSessionKeyPrefixes)
  ) {
    throw new Error(
      "hooks.allowedSessionKeyPrefixes must include 'hook:' when hooks.defaultSessionKey is unset",
    );
  }
  return {
    basePath: trimmed,
    token,
    maxBodyBytes,
    mappings,
    gmailAccount: normalizeOptionalHookString(cfg.hooks?.gmail?.account),
    agentPolicy: {
      defaultAgentId,
      knownAgentIds,
      allowedAgentIds,
    },
    sessionPolicy: {
      defaultSessionKey,
      allowRequestSessionKey: cfg.hooks?.allowRequestSessionKey === true,
      allowedSessionKeyPrefixes,
    },
  };
}

function resolveKnownAgentIds(cfg: OpenClawConfig, defaultAgentId: string): Set<string> {
  const known = new Set(listAgentIds(cfg));
  known.add(defaultAgentId);
  return known;
}

function resolveSessionKey(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value ? value : undefined;
}

function normalizeSessionKeyPrefix(raw: string): string | undefined {
  const value = raw.trim().toLowerCase();
  return value ? value : undefined;
}

function resolveAllowedSessionKeyPrefixes(raw: string[] | undefined): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const set = new Set<string>();
  for (const prefix of raw) {
    const normalized = normalizeSessionKeyPrefix(prefix);
    if (!normalized) {
      continue;
    }
    set.add(normalized);
  }
  return set.size > 0 ? Array.from(set) : undefined;
}

function isSessionKeyAllowedByPrefix(sessionKey: string, prefixes: string[]): boolean {
  const normalized = sessionKey.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return prefixes.some((prefix) => normalized.startsWith(prefix));
}

export function extractHookToken(req: IncomingMessage): string | undefined {
  const auth =
    typeof req.headers.authorization === "string" ? req.headers.authorization.trim() : "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (token) {
      return token;
    }
  }
  const headerToken =
    typeof req.headers["x-openclaw-token"] === "string"
      ? req.headers["x-openclaw-token"].trim()
      : "";
  if (headerToken) {
    return headerToken;
  }
  return undefined;
}

export async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const result = await readJsonBodyWithLimit(req, { maxBytes, emptyObjectOnEmpty: true });
  if (result.ok) {
    return result;
  }
  if (result.code === "PAYLOAD_TOO_LARGE") {
    return { ok: false, error: "payload too large" };
  }
  if (result.code === "REQUEST_BODY_TIMEOUT") {
    return { ok: false, error: "request body timeout" };
  }
  if (result.code === "CONNECTION_CLOSED") {
    return { ok: false, error: requestBodyErrorToText("CONNECTION_CLOSED") };
  }
  return { ok: false, error: result.error };
}

export function normalizeHookHeaders(req: IncomingMessage) {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      headers[key.toLowerCase()] = value;
    } else if (Array.isArray(value) && value.length > 0) {
      headers[key.toLowerCase()] = value.join(", ");
    }
  }
  return headers;
}

export function normalizeWakePayload(
  payload: Record<string, unknown>,
):
  | { ok: true; value: { text: string; mode: "now" | "next-heartbeat" } }
  | { ok: false; error: string } {
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) {
    return { ok: false, error: "text required" };
  }
  const mode = payload.mode === "next-heartbeat" ? "next-heartbeat" : "now";
  return { ok: true, value: { text, mode } };
}

export type HookAgentPayload = {
  message: string;
  name: string;
  agentId?: string;
  idempotencyKey?: string;
  wakeMode: "now" | "next-heartbeat";
  sessionKey?: string;
  deliver: boolean;
  channel: HookMessageChannel;
  to?: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
};

export type HookAgentDispatchPayload = Omit<HookAgentPayload, "sessionKey"> & {
  sessionKey: string;
  allowUnsafeExternalContent?: boolean;
};

export type HookMonitorEventPayload = MonitorEventEnvelope & {
  monitorId?: string;
};

const listHookChannelValues = () => ["last", ...listChannelPlugins().map((plugin) => plugin.id)];

export type HookMessageChannel = ChannelId | "last";

const getHookChannelSet = () => new Set<string>(listHookChannelValues());
export const getHookChannelError = () => `channel must be ${listHookChannelValues().join("|")}`;

export function resolveHookChannel(raw: unknown): HookMessageChannel | null {
  if (raw === undefined) {
    return "last";
  }
  if (typeof raw !== "string") {
    return null;
  }
  const normalized = normalizeMessageChannel(raw);
  if (!normalized || !getHookChannelSet().has(normalized)) {
    return null;
  }
  return normalized as HookMessageChannel;
}

export function resolveHookDeliver(raw: unknown): boolean {
  return raw !== false;
}

function resolveOptionalHookIdempotencyKey(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_HOOK_IDEMPOTENCY_KEY_LENGTH) {
    return undefined;
  }
  return trimmed;
}

export function resolveHookIdempotencyKey(params: {
  payload: Record<string, unknown>;
  headers?: Record<string, string>;
}): string | undefined {
  return (
    resolveOptionalHookIdempotencyKey(params.headers?.["idempotency-key"]) ||
    resolveOptionalHookIdempotencyKey(params.headers?.["x-openclaw-idempotency-key"]) ||
    resolveOptionalHookIdempotencyKey(params.payload.idempotencyKey)
  );
}

function isPlainHookObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeOptionalHookString(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeMonitorEventPayload(
  payload: Record<string, unknown>,
  options?: { idempotencyKey?: string; nowMs?: number },
): { ok: true; value: HookMonitorEventPayload } | { ok: false; error: string } {
  const triggerKind =
    typeof payload.triggerKind === "string"
      ? (payload.triggerKind.trim() as MonitorEventTriggerKind)
      : "";
  if (!monitorEventTriggerKinds.has(triggerKind as MonitorEventTriggerKind)) {
    return {
      ok: false,
      error: "triggerKind must be webhook|local_listener|process_exit|browser_observer",
    };
  }

  const sourceType = normalizeOptionalHookString(payload.sourceType);
  if (!sourceType) {
    return { ok: false, error: "sourceType required" };
  }

  if (!isPlainHookObject(payload.sourceTarget)) {
    return { ok: false, error: "sourceTarget object required" };
  }

  if (payload.evidence !== undefined && !isPlainHookObject(payload.evidence)) {
    return { ok: false, error: "evidence must be an object when provided" };
  }

  const receivedAtMsRaw = payload.receivedAtMs;
  if (
    receivedAtMsRaw !== undefined &&
    !(
      typeof receivedAtMsRaw === "number" &&
      Number.isInteger(receivedAtMsRaw) &&
      receivedAtMsRaw >= 0
    )
  ) {
    return { ok: false, error: "receivedAtMs must be a non-negative integer when provided" };
  }
  const receivedAtMs =
    typeof receivedAtMsRaw === "number" ? receivedAtMsRaw : (options?.nowMs ?? Date.now());
  const idempotencyKey =
    resolveOptionalHookIdempotencyKey(payload.idempotencyKey) ?? options?.idempotencyKey;
  const eventType = normalizeOptionalHookString(payload.eventType);
  const monitorId = normalizeOptionalHookString(payload.monitorId);

  return {
    ok: true,
    value: {
      triggerKind: triggerKind as MonitorEventTriggerKind,
      sourceType,
      sourceTarget: payload.sourceTarget,
      ...(eventType ? { eventType } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(monitorId ? { monitorId } : {}),
      receivedAtMs,
      ...(payload.evidence ? { evidence: payload.evidence } : {}),
    },
  };
}

function firstPlainObject(raw: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(raw)) {
    const first = raw.find(isPlainHookObject);
    return first;
  }
  return isPlainHookObject(raw) ? raw : undefined;
}

function normalizeGmailString(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const value = raw.trim();
  return value ? value : undefined;
}

function normalizeHookNumberishString(raw: unknown): string | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return String(raw);
  }
  if (typeof raw !== "string") {
    return undefined;
  }
  const value = raw.trim();
  return value ? value : undefined;
}

function addGmailEvidenceString(
  evidence: Record<string, unknown>,
  key: string,
  raw: unknown,
): void {
  const value = normalizeGmailString(raw);
  if (value) {
    evidence[key] = value;
  }
}

function normalizeTelegramUserMessageObject(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return firstPlainObject(payload.message) ?? payload;
}

function normalizeTelegramMessageNumber(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeTelegramMessageString(raw: unknown): string | null {
  const value = normalizeHookNumberishString(raw);
  return value ?? null;
}

function normalizeTelegramMessageBoolean(raw: unknown): boolean {
  return raw === true;
}

function normalizeTelegramUsernameChat(raw: unknown): string | undefined {
  const username = normalizeHookNumberishString(raw);
  if (!username) {
    return undefined;
  }
  return username.startsWith("@") ? username : `@${username}`;
}

function buildTelegramUserMessageFromHook(raw: Record<string, unknown>): TelegramUserMessage {
  const directTopic = firstPlainObject(raw.direct_messages_topic);
  const directTopicId =
    normalizeTelegramMessageNumber(directTopic?.topic_id) ??
    normalizeTelegramMessageNumber(raw.direct_messages_topic_id);
  return {
    chat_id: normalizeTelegramMessageNumber(raw.chat_id),
    chat_username: normalizeTelegramMessageString(raw.chat_username),
    chat_title: normalizeTelegramMessageString(raw.chat_title),
    date: normalizeTelegramMessageString(raw.date),
    direct_messages_topic: directTopicId === null ? null : { topic_id: directTopicId },
    direct_messages_topic_id: directTopicId,
    media_kind: normalizeTelegramMessageString(raw.media_kind) as TelegramUserMessage["media_kind"],
    message_id: normalizeTelegramMessageNumber(raw.message_id) ?? 0,
    out: normalizeTelegramMessageBoolean(raw.out),
    reply_to_msg_id: normalizeTelegramMessageNumber(raw.reply_to_msg_id),
    reply_to_top_id: normalizeTelegramMessageNumber(raw.reply_to_top_id),
    sender_id: normalizeTelegramMessageNumber(raw.sender_id),
    text: normalizeTelegramMessageString(raw.text) ?? "",
    thread_anchor: normalizeTelegramMessageNumber(raw.thread_anchor),
  };
}

export function normalizeTelegramUserMonitorEventPayload(
  payload: Record<string, unknown>,
  options?: { idempotencyKey?: string; nowMs?: number },
): { ok: true; value: HookMonitorEventPayload } | { ok: false; error: string } {
  const message = normalizeTelegramUserMessageObject(payload);
  const chat =
    normalizeHookNumberishString(payload.chat) ??
    normalizeHookNumberishString(payload.target) ??
    normalizeHookNumberishString(payload.to) ??
    normalizeTelegramUsernameChat(message.chat_username) ??
    normalizeHookNumberishString(message.chat_id);
  if (!chat) {
    return { ok: false, error: "telegram-user chat required" };
  }

  const messageId =
    normalizeHookNumberishString(message.message_id) ??
    normalizeHookNumberishString(payload.messageId);
  if (!messageId) {
    return { ok: false, error: "telegram-user message_id required" };
  }
  if (message.out === true) {
    return { ok: false, error: "telegram-user monitor events require inbound messages" };
  }

  const accountId =
    normalizeHookNumberishString(payload.accountId) ??
    normalizeHookNumberishString(payload.account);
  const hookMessage = buildTelegramUserMessageFromHook({
    ...message,
    message_id: message.message_id ?? payload.messageId,
    ...(payload.threadAnchor ? { direct_messages_topic_id: payload.threadAnchor } : {}),
    ...(payload.topicAnchor ? { direct_messages_topic_id: payload.topicAnchor } : {}),
    ...(payload.topicId ? { direct_messages_topic_id: payload.topicId } : {}),
  });
  const envelope = buildTelegramUserMonitorEventEnvelope(hookMessage, {
    accountId,
    chat,
    eventType: normalizeGmailString(payload.eventType),
    nowMs: options?.nowMs,
  });
  const idempotencyKey = options?.idempotencyKey ?? envelope.idempotencyKey;

  // The local listener adapter emits the same normalized event envelope as the
  // generic monitor hook. Message content stays evidence, not routing authority.
  return normalizeMonitorEventPayload(
    {
      ...envelope,
      idempotencyKey,
      monitorId: normalizeHookNumberishString(payload.monitorId),
    },
    {
      idempotencyKey,
      nowMs: options?.nowMs,
    },
  );
}

export function normalizeGmailMonitorEventPayload(
  payload: Record<string, unknown>,
  options?: { idempotencyKey?: string; nowMs?: number; configuredAccount?: string },
): { ok: true; value: HookMonitorEventPayload } | { ok: false; error: string } {
  const message =
    firstPlainObject(payload.messages) ?? firstPlainObject(payload.message) ?? payload;
  const account =
    normalizeGmailString(payload.account) ??
    normalizeGmailString(payload.emailAddress) ??
    normalizeGmailString(message.account) ??
    normalizeGmailString(message.emailAddress) ??
    normalizeGmailString(options?.configuredAccount);
  if (!account) {
    return { ok: false, error: "gmail account required" };
  }

  const threadId = normalizeGmailString(message.threadId) ?? normalizeGmailString(payload.threadId);
  if (!threadId) {
    return { ok: false, error: "gmail message threadId required" };
  }

  const messageId =
    normalizeGmailString(message.id) ??
    normalizeGmailString(message.messageId) ??
    normalizeGmailString(payload.messageId);
  const historyId =
    normalizeGmailString(message.historyId) ?? normalizeGmailString(payload.historyId);
  const eventType = normalizeGmailString(payload.eventType) ?? "message.created";
  const derivedIdempotencyKey =
    options?.idempotencyKey ??
    (messageId
      ? `gmail:${account}:${threadId}:${messageId}`
      : historyId
        ? `gmail:${account}:${threadId}:history:${historyId}`
        : undefined);

  const evidence: Record<string, unknown> = {};
  addGmailEvidenceString(evidence, "messageId", messageId);
  addGmailEvidenceString(evidence, "historyId", historyId);
  addGmailEvidenceString(evidence, "from", message.from);
  addGmailEvidenceString(evidence, "subject", message.subject);
  addGmailEvidenceString(evidence, "snippet", message.snippet);
  addGmailEvidenceString(evidence, "body", message.body);

  // The adapter emits the same normalized event envelope as /hooks/monitor-event.
  // Provider content stays in evidence; sourceTarget is only stable routing keys.
  return normalizeMonitorEventPayload(
    {
      triggerKind: "webhook",
      sourceType: "gmail",
      sourceTarget: { account, threadId },
      eventType,
      ...(derivedIdempotencyKey ? { idempotencyKey: derivedIdempotencyKey } : {}),
      ...(Object.keys(evidence).length > 0 ? { evidence } : {}),
    },
    {
      idempotencyKey: derivedIdempotencyKey,
      nowMs: options?.nowMs,
    },
  );
}

export function resolveHookTargetAgentId(
  hooksConfig: HooksConfigResolved,
  agentId: string | undefined,
): string | undefined {
  const raw = agentId?.trim();
  if (!raw) {
    return undefined;
  }
  const normalized = normalizeAgentId(raw);
  if (hooksConfig.agentPolicy.knownAgentIds.has(normalized)) {
    return normalized;
  }
  return hooksConfig.agentPolicy.defaultAgentId;
}

export function isHookAgentAllowed(
  hooksConfig: HooksConfigResolved,
  agentId: string | undefined,
): boolean {
  // Keep backwards compatibility for callers that omit agentId.
  const raw = agentId?.trim();
  if (!raw) {
    return true;
  }
  const allowed = hooksConfig.agentPolicy.allowedAgentIds;
  if (allowed === undefined) {
    return true;
  }
  const resolved = resolveHookTargetAgentId(hooksConfig, raw);
  return resolved ? allowed.has(resolved) : false;
}

export const getHookAgentPolicyError = () => "agentId is not allowed by hooks.allowedAgentIds";
export const getHookSessionKeyRequestPolicyError = () =>
  "sessionKey is disabled for external /hooks/agent payloads; set hooks.allowRequestSessionKey=true to enable";
export const getHookSessionKeyPrefixError = (prefixes: string[]) =>
  `sessionKey must start with one of: ${prefixes.join(", ")}`;

export function resolveHookSessionKey(params: {
  hooksConfig: HooksConfigResolved;
  source: "request" | "mapping";
  sessionKey?: string;
  idFactory?: () => string;
}): { ok: true; value: string } | { ok: false; error: string } {
  const requested = resolveSessionKey(params.sessionKey);
  if (requested) {
    if (params.source === "request" && !params.hooksConfig.sessionPolicy.allowRequestSessionKey) {
      return { ok: false, error: getHookSessionKeyRequestPolicyError() };
    }
    const allowedPrefixes = params.hooksConfig.sessionPolicy.allowedSessionKeyPrefixes;
    if (allowedPrefixes && !isSessionKeyAllowedByPrefix(requested, allowedPrefixes)) {
      return { ok: false, error: getHookSessionKeyPrefixError(allowedPrefixes) };
    }
    return { ok: true, value: requested };
  }

  const defaultSessionKey = params.hooksConfig.sessionPolicy.defaultSessionKey;
  if (defaultSessionKey) {
    return { ok: true, value: defaultSessionKey };
  }

  const generated = `hook:${(params.idFactory ?? randomUUID)()}`;
  const allowedPrefixes = params.hooksConfig.sessionPolicy.allowedSessionKeyPrefixes;
  if (allowedPrefixes && !isSessionKeyAllowedByPrefix(generated, allowedPrefixes)) {
    return { ok: false, error: getHookSessionKeyPrefixError(allowedPrefixes) };
  }
  return { ok: true, value: generated };
}

export function normalizeHookDispatchSessionKey(params: {
  sessionKey: string;
  targetAgentId: string | undefined;
}): string {
  const trimmed = params.sessionKey.trim();
  if (!trimmed || !params.targetAgentId) {
    return trimmed;
  }
  const parsed = parseAgentSessionKey(trimmed);
  if (!parsed) {
    return trimmed;
  }
  const targetAgentId = normalizeAgentId(params.targetAgentId);
  if (parsed.agentId !== targetAgentId) {
    return `agent:${parsed.agentId}:${parsed.rest}`;
  }
  return parsed.rest;
}

export function normalizeAgentPayload(payload: Record<string, unknown>):
  | {
      ok: true;
      value: HookAgentPayload;
    }
  | { ok: false; error: string } {
  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  if (!message) {
    return { ok: false, error: "message required" };
  }
  const nameRaw = payload.name;
  const name = typeof nameRaw === "string" && nameRaw.trim() ? nameRaw.trim() : "Hook";
  const agentIdRaw = payload.agentId;
  const agentId =
    typeof agentIdRaw === "string" && agentIdRaw.trim() ? agentIdRaw.trim() : undefined;
  const idempotencyKey = resolveOptionalHookIdempotencyKey(payload.idempotencyKey);
  const wakeMode = payload.wakeMode === "next-heartbeat" ? "next-heartbeat" : "now";
  const sessionKeyRaw = payload.sessionKey;
  const sessionKey =
    typeof sessionKeyRaw === "string" && sessionKeyRaw.trim() ? sessionKeyRaw.trim() : undefined;
  const channel = resolveHookChannel(payload.channel);
  if (!channel) {
    return { ok: false, error: getHookChannelError() };
  }
  const toRaw = payload.to;
  const to = typeof toRaw === "string" && toRaw.trim() ? toRaw.trim() : undefined;
  const modelRaw = payload.model;
  const model = typeof modelRaw === "string" && modelRaw.trim() ? modelRaw.trim() : undefined;
  if (modelRaw !== undefined && !model) {
    return { ok: false, error: "model required" };
  }
  const deliver = resolveHookDeliver(payload.deliver);
  const thinkingRaw = payload.thinking;
  const thinking =
    typeof thinkingRaw === "string" && thinkingRaw.trim() ? thinkingRaw.trim() : undefined;
  const timeoutRaw = payload.timeoutSeconds;
  const timeoutSeconds =
    typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) && timeoutRaw > 0
      ? Math.floor(timeoutRaw)
      : undefined;
  return {
    ok: true,
    value: {
      message,
      name,
      agentId,
      idempotencyKey,
      wakeMode,
      sessionKey,
      deliver,
      channel,
      to,
      model,
      thinking,
      timeoutSeconds,
    },
  };
}
