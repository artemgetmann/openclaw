import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { withFileLock } from "../infra/file-lock.js";
import { expandHomePrefix } from "../infra/home-dir.js";
import { resolveMonitorStorePath } from "./store.js";

export const LISTENER_HEALTH_FILENAME = "listener-health.json";
const MAX_ERROR_LENGTH = 512;
const FAILURE_THRESHOLD = 3;
const STALE_INTERVALS = 3;
const MIN_STALE_AFTER_MS = 30_000;

export type ListenerHealthService = "telegram-user" | "whatsapp";
export type ListenerHealthState = "healthy" | "degraded" | "stale" | "unknown";
export type ListenerHealthTransition = "degraded" | "recovered" | null;

export type ListenerHealthOwner = {
  pid?: number;
  profile?: string;
  startedAtMs?: number;
};

export type ListenerHealthRecord = {
  consecutiveFailures: number;
  lastError: string | null;
  lastRoutedEventAtMs: number | null;
  lastSuccessfulCheckAtMs: number | null;
  lastTransition: ListenerHealthTransition;
  owner: ListenerHealthOwner;
  pollIntervalMs: number;
  service: ListenerHealthService;
  state: ListenerHealthState;
  updatedAtMs: number;
};

type ListenerHealthStore = {
  records: Partial<Record<ListenerHealthService, ListenerHealthRecord>>;
  version: 1;
};

export type ListenerHealthSnapshot = {
  record: ListenerHealthRecord;
  state: ListenerHealthState;
  transition: ListenerHealthTransition;
};

const HEALTH_LOCK_OPTIONS = {
  retries: { retries: 20, factor: 1.2, minTimeout: 5, maxTimeout: 50, randomize: true },
  stale: 10_000,
};

function resolvePath(raw: string): string {
  return path.resolve(raw.startsWith("~") ? expandHomePrefix(raw) : raw);
}

export function resolveListenerHealthStorePath(
  opts: {
    cronStorePath?: string;
    env?: NodeJS.ProcessEnv;
    healthStorePath?: string;
    monitorStorePath?: string;
  } = {},
): string {
  if (opts.healthStorePath?.trim()) {
    return resolvePath(opts.healthStorePath.trim());
  }
  if (opts.monitorStorePath?.trim() || opts.cronStorePath?.trim()) {
    const monitorStorePath = resolveMonitorStorePath({
      cronStorePath: opts.cronStorePath,
      storePath: opts.monitorStorePath,
    });
    return path.join(path.dirname(monitorStorePath), LISTENER_HEALTH_FILENAME);
  }

  // Do not use the module-level default monitor path here. Status commands can
  // inspect a non-default profile in the same process, so the active env must
  // decide which profile state directory owns this health record.
  return path.join(resolveStateDir(opts.env), "monitors", LISTENER_HEALTH_FILENAME);
}

function sanitizeOwner(owner: ListenerHealthOwner): ListenerHealthOwner {
  return {
    ...(Number.isSafeInteger(owner.pid) && (owner.pid ?? 0) > 0 ? { pid: owner.pid } : {}),
    ...(owner.profile?.trim() ? { profile: owner.profile.trim().slice(0, 128) } : {}),
    ...(Number.isFinite(owner.startedAtMs) && (owner.startedAtMs ?? 0) >= 0
      ? { startedAtMs: owner.startedAtMs }
      : {}),
  };
}

export function sanitizeListenerHealthError(error: unknown): string {
  const value = String(error).toLowerCase();
  const operationalReason = value.match(/\b(read_error|lookup_error|dispatch_error)\b/)?.[1];
  if (operationalReason) {
    return operationalReason;
  }
  const fatalClass = value.match(/\bpoll_failed:([a-z0-9_-]{1,64})\b/)?.[1];
  return (fatalClass ? `poll_failed:${fatalClass}` : "listener_check_failed").slice(
    0,
    MAX_ERROR_LENGTH,
  );
}

export function classifyFatalListenerHealthError(error: unknown): string {
  // Exception messages can contain backend paths, selectors, tokens, or even
  // remote message text. Persist only the local error class, which is enough
  // to distinguish a crash from an ordinary per-monitor failure.
  const name = error instanceof Error ? error.name : "unknown";
  const safeName =
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "")
      .slice(0, 64) || "unknown";
  return `poll_failed:${safeName}`;
}

function emptyRecord(service: ListenerHealthService, pollIntervalMs: number): ListenerHealthRecord {
  return {
    consecutiveFailures: 0,
    lastError: null,
    lastRoutedEventAtMs: null,
    lastSuccessfulCheckAtMs: null,
    lastTransition: null,
    owner: {},
    pollIntervalMs,
    service,
    state: "unknown",
    updatedAtMs: 0,
  };
}

function deriveState(
  record: ListenerHealthRecord,
  nowMs: number,
  pollIntervalMs: number,
): ListenerHealthState {
  if (record.consecutiveFailures >= FAILURE_THRESHOLD) {
    return "degraded";
  }
  if (record.lastSuccessfulCheckAtMs === null) {
    return "unknown";
  }
  // Three missed intervals distinguishes a genuinely frozen loop from normal
  // scheduler jitter without masking a dead one-second managed listener.
  const staleAfterMs = Math.max(MIN_STALE_AFTER_MS, Math.max(1, pollIntervalMs) * STALE_INTERVALS);
  if (nowMs - record.lastSuccessfulCheckAtMs >= staleAfterMs) {
    return "stale";
  }
  return "healthy";
}

async function loadStore(storePath: string): Promise<ListenerHealthStore> {
  try {
    const parsed = JSON.parse(await fs.readFile(storePath, "utf8")) as Partial<ListenerHealthStore>;
    return {
      records: parsed.records && typeof parsed.records === "object" ? parsed.records : {},
      version: 1,
    };
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      return { records: {}, version: 1 };
    }
    throw err;
  }
}

async function saveStore(storePath: string, store: ListenerHealthStore): Promise<void> {
  const dir = path.dirname(storePath);
  // mkdir applies 0700 only when creating the directory. Never chmod an
  // existing explicit monitor-store parent whose ownership semantics are not
  // ours to rewrite.
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tempPath = `${storePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.chmod(tempPath, 0o600).catch(() => undefined);
    await fs.rename(tempPath, storePath);
    await fs.chmod(storePath, 0o600).catch(() => undefined);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export async function readListenerHealth(params: {
  nowMs?: number;
  pollIntervalMs: number;
  service: ListenerHealthService;
  storePath: string;
}): Promise<ListenerHealthSnapshot> {
  const store = await loadStore(params.storePath);
  const record =
    store.records[params.service] ?? emptyRecord(params.service, params.pollIntervalMs);
  return {
    record,
    state: deriveState(record, params.nowMs ?? Date.now(), params.pollIntervalMs),
    transition: null,
  };
}

export async function updateListenerHealth(params: {
  check: "failure" | "success";
  error?: unknown;
  nowMs?: number;
  owner: ListenerHealthOwner;
  pollIntervalMs: number;
  routedEvent?: boolean;
  service: ListenerHealthService;
  storePath: string;
}): Promise<ListenerHealthSnapshot> {
  // Create only a missing directory with private permissions before the shared
  // file-lock helper creates its sidecar. Existing explicit parents are left
  // untouched because they may have intentional broader ownership semantics.
  await fs.mkdir(path.dirname(params.storePath), { recursive: true, mode: 0o700 });
  return await withFileLock(params.storePath, HEALTH_LOCK_OPTIONS, async () => {
    const nowMs = params.nowMs ?? Date.now();
    const store = await loadStore(params.storePath);
    const previous =
      store.records[params.service] ?? emptyRecord(params.service, params.pollIntervalMs);
    const previousState = deriveState(previous, nowMs, params.pollIntervalMs);
    const record: ListenerHealthRecord = {
      ...previous,
      owner: sanitizeOwner(params.owner),
      pollIntervalMs: params.pollIntervalMs,
      updatedAtMs: nowMs,
      ...(params.check === "success"
        ? {
            consecutiveFailures: 0,
            lastError: null,
            lastRoutedEventAtMs: params.routedEvent ? nowMs : previous.lastRoutedEventAtMs,
            lastSuccessfulCheckAtMs: nowMs,
          }
        : {
            consecutiveFailures: previous.consecutiveFailures + 1,
            lastError: sanitizeListenerHealthError(params.error),
          }),
    };
    const state = deriveState(record, nowMs, params.pollIntervalMs);
    const transition: ListenerHealthTransition =
      state === "degraded" && previousState !== "degraded"
        ? "degraded"
        : state === "healthy" && (previousState === "degraded" || previousState === "stale")
          ? "recovered"
          : null;
    record.state = state;
    record.lastTransition = transition;
    store.records[params.service] = record;
    await saveStore(params.storePath, store);
    return { record, state, transition };
  });
}
