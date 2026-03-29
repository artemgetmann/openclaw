import { resolveSessionStoreEntry, type SessionEntry } from "../../../src/config/sessions.js";
import { resolveThreadSessionKeys } from "../../../src/routing/session-key.js";
import { buildTelegramDmThreadToken } from "./bot/helpers.js";

type TelegramDmThreadRouting = {
  sessionKey: string;
  legacySessionKeys: string[];
};

function normalizeDistinctSessionKeys(keys: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    const normalized = key.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function resolveTelegramDmThreadSessionRouting(params: {
  baseSessionKey: string;
  chatId: number | string;
  senderId?: number | string | null;
  threadId?: number | string | null;
}): TelegramDmThreadRouting {
  const rawThreadId = params.threadId != null ? String(params.threadId).trim() : "";
  if (!rawThreadId) {
    return { sessionKey: params.baseSessionKey, legacySessionKeys: [] };
  }

  const sessionKey = resolveThreadSessionKeys({
    baseSessionKey: params.baseSessionKey,
    threadId: buildTelegramDmThreadToken({
      chatId: params.chatId,
      senderId: params.senderId,
      threadId: rawThreadId,
    }),
  }).sessionKey;

  const legacyChatThreadSessionKey = resolveThreadSessionKeys({
    baseSessionKey: params.baseSessionKey,
    threadId: `${String(params.chatId).trim()}:${rawThreadId}`,
  }).sessionKey;
  const legacyBareThreadSessionKey = resolveThreadSessionKeys({
    baseSessionKey: params.baseSessionKey,
    threadId: rawThreadId,
  }).sessionKey;

  return {
    sessionKey,
    legacySessionKeys: normalizeDistinctSessionKeys([
      legacyChatThreadSessionKey,
      legacyBareThreadSessionKey,
    ]).filter((candidate) => candidate !== sessionKey),
  };
}

export function resolveTelegramDmThreadStoreEntry(params: {
  store: Record<string, SessionEntry>;
  sessionKey: string;
  legacySessionKeys?: string[];
}): {
  normalizedKey: string;
  existing: SessionEntry | undefined;
  legacyKeys: string[];
} {
  const primary = resolveSessionStoreEntry({
    store: params.store,
    sessionKey: params.sessionKey,
  });
  if (primary.existing) {
    return {
      normalizedKey: primary.normalizedKey,
      existing: primary.existing,
      legacyKeys: normalizeDistinctSessionKeys([
        ...primary.legacyKeys,
        ...(params.legacySessionKeys ?? []),
      ]).filter((candidate) => candidate !== primary.normalizedKey),
    };
  }

  for (const legacySessionKey of params.legacySessionKeys ?? []) {
    const legacy = resolveSessionStoreEntry({
      store: params.store,
      sessionKey: legacySessionKey,
    });
    if (!legacy.existing) {
      continue;
    }
    return {
      normalizedKey: primary.normalizedKey,
      existing: legacy.existing,
      legacyKeys: normalizeDistinctSessionKeys([
        legacy.normalizedKey,
        ...legacy.legacyKeys,
        ...(params.legacySessionKeys ?? []),
      ]).filter((candidate) => candidate !== primary.normalizedKey),
    };
  }

  return {
    normalizedKey: primary.normalizedKey,
    existing: undefined,
    legacyKeys: normalizeDistinctSessionKeys(params.legacySessionKeys ?? []).filter(
      (candidate) => candidate !== primary.normalizedKey,
    ),
  };
}

export function migrateTelegramDmThreadStoreEntry(params: {
  store: Record<string, SessionEntry>;
  sessionKey: string;
  legacySessionKeys?: string[];
}): {
  normalizedKey: string;
  existing: SessionEntry | undefined;
  migrated: boolean;
} {
  const resolved = resolveTelegramDmThreadStoreEntry(params);
  let migrated = false;

  if (resolved.existing && params.store[resolved.normalizedKey] !== resolved.existing) {
    params.store[resolved.normalizedKey] = resolved.existing;
    migrated = true;
  }

  for (const legacyKey of resolved.legacyKeys) {
    if (!Object.prototype.hasOwnProperty.call(params.store, legacyKey)) {
      continue;
    }
    delete params.store[legacyKey];
    migrated = true;
  }

  return {
    normalizedKey: resolved.normalizedKey,
    existing: resolved.existing,
    migrated,
  };
}
