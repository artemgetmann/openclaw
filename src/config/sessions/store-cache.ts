import type { SessionEntry } from "./types.js";

type SessionStoreCacheEntry = {
  loadedAt: number;
  storePath: string;
  mtimeMs?: number;
  sizeBytes?: number;
  serialized: string;
};

const SESSION_STORE_CACHE = new Map<string, SessionStoreCacheEntry>();
const SESSION_STORE_SERIALIZED_CACHE = new Map<string, string>();

export function clearSessionStoreCaches(): void {
  SESSION_STORE_CACHE.clear();
  SESSION_STORE_SERIALIZED_CACHE.clear();
}

export function invalidateSessionStoreCache(storePath: string): void {
  SESSION_STORE_CACHE.delete(storePath);
  SESSION_STORE_SERIALIZED_CACHE.delete(storePath);
}

export function getSerializedSessionStore(storePath: string): string | undefined {
  return SESSION_STORE_SERIALIZED_CACHE.get(storePath);
}

export function setSerializedSessionStore(storePath: string, serialized?: string): void {
  if (serialized === undefined) {
    SESSION_STORE_SERIALIZED_CACHE.delete(storePath);
    return;
  }
  SESSION_STORE_SERIALIZED_CACHE.set(storePath, serialized);
}

export function dropSessionStoreObjectCache(storePath: string): void {
  SESSION_STORE_CACHE.delete(storePath);
}

export function readSessionStoreCache(params: {
  storePath: string;
  ttlMs: number;
  mtimeMs?: number;
  sizeBytes?: number;
}): Record<string, SessionEntry> | null {
  const cached = SESSION_STORE_CACHE.get(params.storePath);
  if (!cached) {
    return null;
  }
  const now = Date.now();
  if (now - cached.loadedAt > params.ttlMs) {
    invalidateSessionStoreCache(params.storePath);
    return null;
  }
  if (params.mtimeMs !== cached.mtimeMs || params.sizeBytes !== cached.sizeBytes) {
    invalidateSessionStoreCache(params.storePath);
    return null;
  }
  try {
    // Keep the cache as serialized JSON instead of a live object graph. Session
    // stores can contain hundreds of repeated skill snapshots, and V8's
    // structured clone deserializer can monopolize the gateway event loop for
    // tens of seconds on those large graphs. Parsing the known-good JSON still
    // returns an isolated mutable copy without retaining or cloning that graph.
    const parsed: unknown = JSON.parse(cached.serialized);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      invalidateSessionStoreCache(params.storePath);
      return null;
    }
    return parsed as Record<string, SessionEntry>;
  } catch {
    invalidateSessionStoreCache(params.storePath);
    return null;
  }
}

export function writeSessionStoreCache(params: {
  storePath: string;
  mtimeMs?: number;
  sizeBytes?: number;
  serialized: string;
}): void {
  SESSION_STORE_CACHE.set(params.storePath, {
    loadedAt: Date.now(),
    storePath: params.storePath,
    mtimeMs: params.mtimeMs,
    sizeBytes: params.sizeBytes,
    serialized: params.serialized,
  });
  SESSION_STORE_SERIALIZED_CACHE.set(params.storePath, params.serialized);
}
