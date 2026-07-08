import type { MonitorEventEnvelope } from "../monitor/types.js";
import { normalizeWhatsAppLidJid, normalizeWhatsAppTarget } from "./normalize.js";
import type { WacliReplyLookupResult, WacliLatestInboundReply } from "./wacli-reconciliation.js";

export type WacliMonitorEventOptions = {
  accountId?: string;
  eventType?: string;
  nowMs?: number;
};

function readOptionalString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function addEvidenceValue(target: Record<string, unknown>, key: string, value: unknown) {
  const normalized = readOptionalString(value);
  if (normalized) {
    target[key] = normalized;
  }
}

function buildWacliMonitorEvidence(reply: WacliLatestInboundReply): Record<string, unknown> {
  const evidence: Record<string, unknown> = {
    messageId: reply.msgId,
    chatJid: reply.chatJid,
    fromMe: reply.fromMe,
    hasRenderableContent: reply.hasRenderableContent,
  };

  // Message contents and sender-provided labels are evidence for the resumed
  // monitor session, not routing authority. The router should only trust stable
  // chat/account keys in sourceTarget.
  const evidenceEntries: Array<[string, unknown]> = [
    ["senderJid", reply.senderJid],
    ["timestamp", reply.ts],
    ["text", reply.text],
    ["mediaType", reply.mediaType],
    ["mediaCaption", reply.mediaCaption],
    ["displayText", reply.displayText],
    ["effectiveText", reply.effectiveText],
    ["chatName", reply.chatName],
    ["senderName", reply.senderName],
  ];
  for (const [key, value] of evidenceEntries) {
    addEvidenceValue(evidence, key, value);
  }
  return evidence;
}

export function buildWacliMonitorEventEnvelope(
  lookup: WacliReplyLookupResult,
  options: WacliMonitorEventOptions = {},
): MonitorEventEnvelope {
  const reply = lookup.latestInboundReply;
  if (!reply) {
    throw new Error(`No actionable inbound WhatsApp reply for ${lookup.target}`);
  }

  const routeTarget = normalizeWhatsAppLidJid(lookup.target)
    ? undefined
    : (normalizeWhatsAppTarget(lookup.target) ?? lookup.target);
  const sourceTarget: Record<string, unknown> = {
    chatJid: reply.chatJid,
    ...(routeTarget ? { target: routeTarget } : {}),
    ...(options.accountId ? { accountId: options.accountId } : {}),
  };

  return {
    triggerKind: "local_listener",
    sourceType: "whatsapp",
    sourceTarget,
    eventType: options.eventType ?? "message.created",
    idempotencyKey: `whatsapp:${options.accountId ?? "default"}:${
      routeTarget ?? reply.chatJid
    }:${reply.chatJid}:${reply.msgId}`,
    receivedAtMs: options.nowMs ?? Date.now(),
    evidence: buildWacliMonitorEvidence(reply),
  };
}
