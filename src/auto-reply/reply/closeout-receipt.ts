import { createHash } from "node:crypto";
import { updateSessionStoreEntry } from "../../config/sessions/store.js";
import type { SessionCloseoutReceipt } from "../../config/sessions/types.js";
import type { ReplyPayload } from "../types.js";

const NONE_VALUES = new Set(["none", "nothing", "n/a", "not applicable", "no remaining work"]);
const FIELD_PATTERN =
  /(?:^|\n)Outcome:\s*([\s\S]*?)\nRemaining:\s*([\s\S]*?)\nOwner:\s*([\s\S]*?)\nNext action:\s*([\s\S]*?)(?=\n(?:#{1,6}\s|Outcome:|Remaining:|Owner:|Next action:)|$)/i;

const CLOSEOUT_SIGNALS: Array<[string, RegExp]> = [
  ["completed", /\b(?:completed|finished|done)\b/i],
  ["blocked", /\bblocked\b/i],
  ["merged", /\b(?:merged|closed)\b/i],
  ["handoff", /\b(?:handed off|handoff|new owner|ownership moved)\b/i],
  ["archive", /\b(?:safe to archive|archive this chat|keep this chat open)\b/i],
  ["remaining-work", /\b(?:remaining work|what remains|next steps?|follow-?up)\b/i],
];

function cleanField(value: string): string {
  return value.replace(/^[-*]\s+/gm, "").trim();
}

function splitRemaining(value: string): string[] {
  const cleaned = cleanField(value);
  if (!cleaned || NONE_VALUES.has(cleaned.toLowerCase())) {
    return [];
  }
  const lines = cleaned
    .split(/\n|;/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines.slice(0, 12) : [cleaned];
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function extractCloseoutReceipt(
  text: string,
  options: { sessionId?: string; now?: number } = {},
): SessionCloseoutReceipt | null {
  const match = text.match(FIELD_PATTERN);
  if (!match) {
    return null;
  }
  const outcome = cleanField(match[1] ?? "");
  const remainingRaw = cleanField(match[2] ?? "");
  const remaining = splitRemaining(remainingRaw);
  const owner = cleanField(match[3] ?? "");
  const nextAction = cleanField(match[4] ?? "");
  if (!outcome || !remainingRaw || !owner || !nextAction) {
    return null;
  }
  return {
    schemaVersion: 1,
    outcome: outcome.slice(0, 2_000),
    remaining: remaining.map((item) => item.slice(0, 1_000)),
    owner: owner.slice(0, 1_000),
    nextAction: nextAction.slice(0, 2_000),
    sourceTextSha256: hashText(text),
    ...(options.sessionId ? { sourceSessionId: options.sessionId } : {}),
    updatedAt: options.now ?? Date.now(),
  };
}

export function findLikelyCloseoutSignals(text: string): string[] {
  return CLOSEOUT_SIGNALS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function latestText(payloads: ReplyPayload[]): string | null {
  for (let index = payloads.length - 1; index >= 0; index -= 1) {
    const text = payloads[index]?.text?.trim();
    if (text) {
      return text;
    }
  }
  return null;
}

export async function recordCloseoutReceipt(params: {
  storePath: string;
  sessionKey: string;
  sessionId?: string;
  payloads: ReplyPayload[];
  now?: number;
}): Promise<SessionCloseoutReceipt | null> {
  const text = latestText(params.payloads);
  if (!text) {
    return null;
  }
  const now = params.now ?? Date.now();
  const receipt = extractCloseoutReceipt(text, { sessionId: params.sessionId, now });
  const signals = findLikelyCloseoutSignals(text);
  if (!receipt && signals.length === 0) {
    return null;
  }
  const sourceTextSha256 = hashText(text);
  let didPersist = false;
  await updateSessionStoreEntry({
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    update: async (entry) => {
      // Delivery can finish after a reset replaces the session behind this
      // key. Never attach the old answer's state to the replacement session.
      if (params.sessionId && entry.sessionId !== params.sessionId) {
        return null;
      }
      didPersist = true;
      return {
        // A newer ambiguous closeout supersedes the old receipt. Clear it so
        // triage cannot combine stale ownership with the new review-needed flag.
        closeoutReceipt: receipt ?? undefined,
        closeoutReceiptAudit: {
          status: receipt ? "present" : "review-needed",
          sourceTextSha256,
          signals,
          updatedAt: now,
        },
      };
    },
  });
  return didPersist ? receipt : null;
}
