import { normalizeStoreSessionKey, resolveSessionStoreEntry, updateSessionStore } from "./store.js";
import {
  mergeSessionEntryPreserveActivity,
  type SessionEntry,
  type SessionPendingRestartConfirmation,
} from "./types.js";

export const DEFAULT_PENDING_RESTART_CONFIRMATION_TTL_MS = 5 * 60_000;

export const RESTART_CONFIRMATION_RECOMMENDED_PROMPT =
  "This will interrupt other tasks that you have running in other chats. Restart now?";

export type PendingRestartConfirmationStatus =
  | "ready"
  | "missing-session"
  | "missing-confirmation"
  | "expired"
  | "awaiting-next-user-turn";

function isFiniteEpochMs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function normalizePendingRestartConfirmation(
  value: unknown,
): SessionPendingRestartConfirmation | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = value as {
    scope?: unknown;
    requestedAt?: unknown;
    expiresAt?: unknown;
  };
  if (candidate.scope !== "gateway-restart-capable") {
    return undefined;
  }
  if (!isFiniteEpochMs(candidate.requestedAt) || !isFiniteEpochMs(candidate.expiresAt)) {
    return undefined;
  }
  if (candidate.expiresAt <= candidate.requestedAt) {
    return undefined;
  }
  return {
    scope: candidate.scope,
    requestedAt: candidate.requestedAt,
    expiresAt: candidate.expiresAt,
  };
}

export function createPendingRestartConfirmation(params?: {
  now?: number;
  ttlMs?: number;
}): SessionPendingRestartConfirmation {
  const now = params?.now ?? Date.now();
  const ttlMs =
    typeof params?.ttlMs === "number" && Number.isFinite(params.ttlMs) && params.ttlMs > 0
      ? Math.floor(params.ttlMs)
      : DEFAULT_PENDING_RESTART_CONFIRMATION_TTL_MS;
  return {
    scope: "gateway-restart-capable",
    requestedAt: now,
    expiresAt: now + ttlMs,
  };
}

export function readPendingRestartConfirmation(
  entry?: Pick<SessionEntry, "pendingRestartConfirmation"> | null,
  now = Date.now(),
): SessionPendingRestartConfirmation | undefined {
  const pending = normalizePendingRestartConfirmation(entry?.pendingRestartConfirmation);
  if (!pending) {
    return undefined;
  }
  if (pending.expiresAt <= now) {
    return undefined;
  }
  return pending;
}

export function writePendingRestartConfirmation(
  entry: SessionEntry,
  pending: SessionPendingRestartConfirmation,
): SessionEntry {
  return mergeSessionEntryPreserveActivity(entry, {
    pendingRestartConfirmation: pending,
  });
}

export function clearPendingRestartConfirmation(entry: SessionEntry): SessionEntry {
  if (!Object.hasOwn(entry, "pendingRestartConfirmation")) {
    return entry;
  }
  const next = { ...entry };
  delete next.pendingRestartConfirmation;
  return next;
}

export function expirePendingRestartConfirmation(
  entry: SessionEntry,
  now = Date.now(),
): SessionEntry {
  return readPendingRestartConfirmation(entry, now)
    ? entry
    : clearPendingRestartConfirmation(entry);
}

export function getPendingRestartConfirmationStatus(
  entry: SessionEntry | undefined,
  now = Date.now(),
): PendingRestartConfirmationStatus {
  if (!entry) {
    return "missing-session";
  }
  const rawPending = normalizePendingRestartConfirmation(entry.pendingRestartConfirmation);
  if (!rawPending) {
    return "missing-confirmation";
  }
  if (rawPending.expiresAt <= now) {
    return "expired";
  }
  // Require a later inbound turn than the one where the assistant armed the gate.
  if ((entry.updatedAt ?? 0) <= rawPending.requestedAt) {
    return "awaiting-next-user-turn";
  }
  return "ready";
}

export async function recordPendingRestartConfirmationForSession(params: {
  storePath: string;
  sessionKey: string;
  now?: number;
  ttlMs?: number;
}): Promise<SessionEntry | null> {
  const now = params.now ?? Date.now();
  const pending = createPendingRestartConfirmation({
    now,
    ttlMs: params.ttlMs,
  });
  return await updateSessionStore(
    params.storePath,
    (store) => {
      const resolved = resolveSessionStoreEntry({
        store,
        sessionKey: params.sessionKey,
      });
      const existing = resolved.existing;
      if (!existing) {
        return null;
      }
      const next = writePendingRestartConfirmation(existing, pending);
      store[resolved.normalizedKey] = next;
      for (const legacyKey of resolved.legacyKeys) {
        delete store[legacyKey];
      }
      return next;
    },
    { activeSessionKey: normalizeStoreSessionKey(params.sessionKey) },
  );
}

export async function consumePendingRestartConfirmationForSession(params: {
  storePath: string;
  sessionKey: string;
  now?: number;
}): Promise<{ status: PendingRestartConfirmationStatus; entry?: SessionEntry }> {
  const now = params.now ?? Date.now();
  return await updateSessionStore(
    params.storePath,
    (store) => {
      const resolved = resolveSessionStoreEntry({
        store,
        sessionKey: params.sessionKey,
      });
      const existing = resolved.existing;
      const status = getPendingRestartConfirmationStatus(existing, now);
      if (!existing) {
        return { status };
      }
      const next =
        status === "ready" || status === "expired"
          ? clearPendingRestartConfirmation(existing)
          : existing;
      if (next !== existing) {
        store[resolved.normalizedKey] = next;
        for (const legacyKey of resolved.legacyKeys) {
          delete store[legacyKey];
        }
      }
      return { status, entry: next };
    },
    { activeSessionKey: normalizeStoreSessionKey(params.sessionKey) },
  );
}
