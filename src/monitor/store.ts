import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { resolveSessionGoalAutonomy } from "../config/sessions/goals.js";
import type { CronSchedule } from "../cron/types.js";
import { expandHomePrefix } from "../infra/home-dir.js";
import { CONFIG_DIR } from "../utils.js";
import { resolveMonitorNotificationPolicy } from "./notifications.js";
import type {
  MonitorCreateInput,
  MonitorActionPolicy,
  MonitorDisclosure,
  MonitorGoalSnapshot,
  MonitorListenerEvidence,
  MonitorEventEnvelope,
  MonitorNotificationPolicy,
  MonitorRecord,
  MonitorSourceTarget,
  MonitorStoreFile,
  MonitorUpdatePatch,
} from "./types.js";
import { MONITOR_INSTRUCTIONS_MAX_LENGTH } from "./types.js";

export const DEFAULT_MONITOR_DIR = path.join(CONFIG_DIR, "monitors");
export const DEFAULT_MONITOR_STORE_PATH = path.join(DEFAULT_MONITOR_DIR, "monitors.json");

const serializedStoreCache = new Map<string, string>();
const monitorStoreWriteLocks = new Map<string, Promise<void>>();
const MAX_LISTENER_EVIDENCE_IDENTIFIER_LENGTH = 512;

/**
 * Keep the durable task contract bounded even for trusted direct callers.
 * Gateway creation rejects over-limit input; this defensive trim preserves the
 * store invariant for callers that bypass the protocol schema.
 */
export function normalizeMonitorInstructions(instructions: string): string {
  // JSON Schema maxLength counts Unicode code points, while String.slice
  // counts UTF-16 units and can split a valid non-BMP character in half.
  return Array.from(instructions.trim()).slice(0, MONITOR_INSTRUCTIONS_MAX_LENGTH).join("");
}

type MonitorIdentityInput = {
  agentId: string;
  sourceType: string;
  sourceTarget: MonitorSourceTarget;
  actionPolicy?: MonitorActionPolicy;
  purposeLabel?: string;
};

function normalizeIdentityValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeIdentityValue(item));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .toSorted()
        .map((key) => [key, normalizeIdentityValue(record[key])]),
    );
  }
  return value;
}

export function createMonitorIdentityKey(input: MonitorIdentityInput): string {
  // Keep identity intentionally narrow: this dedupes the same active watcher
  // without merging different response policies or user-visible purposes.
  return JSON.stringify({
    agentId: input.agentId.trim(),
    sourceType: input.sourceType.trim(),
    sourceTarget: normalizeIdentityValue(input.sourceTarget),
    actionPolicy: input.actionPolicy ?? "notify_draft",
    purposeLabel: input.purposeLabel?.trim() ?? "",
  });
}

export function findActiveMonitorByIdentity(
  store: MonitorStoreFile,
  input: MonitorIdentityInput,
): MonitorRecord | undefined {
  const identityKey = createMonitorIdentityKey(input);
  return store.monitors.find(
    (monitor) =>
      (monitor.status === "active" || monitor.status === "degraded") &&
      createMonitorIdentityKey({
        agentId: monitor.agentId,
        sourceType: monitor.sourceType,
        sourceTarget: monitor.sourceTarget,
        actionPolicy: monitor.actionPolicy,
        purposeLabel: monitor.name,
      }) === identityKey,
  );
}

export function resolveMonitorStorePath(opts?: { storePath?: string; cronStorePath?: string }) {
  const explicit = opts?.storePath?.trim();
  if (explicit) {
    if (explicit.startsWith("~")) {
      return path.resolve(expandHomePrefix(explicit));
    }
    return path.resolve(explicit);
  }
  const cronStorePath = opts?.cronStorePath?.trim();
  if (cronStorePath) {
    return path.join(path.dirname(path.resolve(cronStorePath)), "monitors.json");
  }
  return DEFAULT_MONITOR_STORE_PATH;
}

export async function loadMonitorStore(storePath: string): Promise<MonitorStoreFile> {
  try {
    const raw = await fs.promises.readFile(storePath, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON5.parse(raw);
    } catch (err) {
      throw new Error(`Failed to parse monitor store at ${storePath}: ${String(err)}`, {
        cause: err,
      });
    }
    const parsedRecord =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    const monitors = Array.isArray(parsedRecord.monitors)
      ? (parsedRecord.monitors as MonitorRecord[])
      : [];
    const pendingEvents = Array.isArray(parsedRecord.pendingEvents)
      ? (parsedRecord.pendingEvents as MonitorStoreFile["pendingEvents"])?.filter(Boolean)
      : undefined;
    const store = {
      version: 1 as const,
      monitors: monitors.filter(Boolean),
      ...(pendingEvents?.length ? { pendingEvents } : {}),
    };
    serializedStoreCache.set(storePath, JSON.stringify(store, null, 2));
    return store;
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      serializedStoreCache.delete(storePath);
      return { version: 1, monitors: [] };
    }
    throw err;
  }
}

export async function withMonitorStoreWriteLock<T>(
  storePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = monitorStoreWriteLocks.get(storePath) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.catch(() => undefined).then(() => gate);
  monitorStoreWriteLocks.set(storePath, current);

  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (monitorStoreWriteLocks.get(storePath) === current) {
      monitorStoreWriteLocks.delete(storePath);
    }
  }
}

async function setSecureFileMode(filePath: string): Promise<void> {
  await fs.promises.chmod(filePath, 0o600).catch(() => undefined);
}

export async function saveMonitorStore(storePath: string, store: MonitorStoreFile) {
  const storeDir = path.dirname(storePath);
  await fs.promises.mkdir(storeDir, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(storeDir, 0o700).catch(() => undefined);
  const json = JSON.stringify(store, null, 2);
  const cached = serializedStoreCache.get(storePath);
  if (cached === json) {
    return;
  }
  const tmp = `${storePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await fs.promises.writeFile(tmp, json, { encoding: "utf-8", mode: 0o600 });
  await setSecureFileMode(tmp);
  await fs.promises.rename(tmp, storePath).catch(async (err) => {
    const code = (err as { code?: string }).code;
    if (code === "EPERM" || code === "EEXIST") {
      await fs.promises.copyFile(tmp, storePath);
      await fs.promises.unlink(tmp).catch(() => undefined);
      return;
    }
    throw err;
  });
  await setSecureFileMode(storePath);
  serializedStoreCache.set(storePath, json);
}

export function buildMonitorDisclosure(input: {
  purpose?: string;
  name?: string;
  sourceType: string;
  sourceTarget: MonitorSourceTarget;
  cadence: CronSchedule;
  expiryAt?: string;
  stopCondition?: string;
  actionPolicy: MonitorActionPolicy;
  goal?: MonitorGoalSnapshot;
  notificationPolicy?: MonitorNotificationPolicy;
}): MonitorDisclosure {
  const notificationPolicy = resolveMonitorNotificationPolicy(input.notificationPolicy);
  return {
    purpose: input.purpose?.trim() || input.name?.trim() || `${input.sourceType.trim()} monitor`,
    source: { type: input.sourceType.trim(), target: input.sourceTarget },
    checkCadence: input.cadence,
    noChangeCadence: {
      noticeAfterChecks: notificationPolicy.unchangedNoticeAfterChecks,
      reminderIntervalMs: notificationPolicy.unchangedReminderIntervalMs,
    },
    expiryAt: input.expiryAt?.trim() || null,
    stopCondition: input.stopCondition?.trim() || null,
    autonomy: resolveSessionGoalAutonomy(input.goal),
    actionPolicy: input.actionPolicy,
  };
}

export function createMonitorRecord(input: MonitorCreateInput, nowMs: number): MonitorRecord {
  const actionPolicy = input.actionPolicy ?? "notify_draft";
  const notificationPolicy = resolveMonitorNotificationPolicy(input.notificationPolicy);
  const instructions = normalizeMonitorInstructions(input.instructions);
  return {
    monitorId: input.monitorId ?? randomBytes(12).toString("hex"),
    agentId: input.agentId,
    ...(input.name?.trim() ? { name: input.name.trim() } : {}),
    instructions,
    originSessionKey: input.originSessionKey,
    ...(input.originDelivery ? { originDelivery: input.originDelivery } : {}),
    ...(input.watchDelivery ? { watchDelivery: input.watchDelivery } : {}),
    monitorSessionKey: input.monitorSessionKey,
    sourceType: input.sourceType.trim(),
    sourceTarget: input.sourceTarget,
    cadence: input.cadence,
    trigger: input.trigger ?? { kind: "schedule", cadence: input.cadence },
    ...(input.expiryAt?.trim() ? { expiryAt: input.expiryAt.trim() } : {}),
    ...(input.stopCondition?.trim() ? { stopCondition: input.stopCondition.trim() } : {}),
    actionPolicy,
    ...(input.goal ? { goal: input.goal } : {}),
    notificationPolicy,
    notificationState: { consecutiveUnchangedChecks: 0 },
    disclosure: buildMonitorDisclosure({ ...input, actionPolicy, notificationPolicy }),
    status: "active",
    ...(input.lastCheckpoint ? { lastCheckpoint: input.lastCheckpoint } : {}),
    cronJobId: input.cronJobId,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
}

export function findMonitor(store: MonitorStoreFile, monitorId: string) {
  return store.monitors.find((monitor) => monitor.monitorId === monitorId);
}

export function updateMonitorRecord(
  monitor: MonitorRecord,
  patch: MonitorUpdatePatch,
  nowMs: number,
): MonitorRecord {
  return {
    ...monitor,
    ...patch,
    updatedAtMs: nowMs,
  };
}

function readBoundedIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized && normalized.length <= MAX_LISTENER_EVIDENCE_IDENTIFIER_LENGTH
    ? normalized
    : undefined;
}

/**
 * Extract only a small listener receipt from an already-routed event. Inbound
 * evidence is never routing authority and may contain private message content.
 */
export function createMonitorListenerEvidence(
  event: MonitorEventEnvelope,
  nowMs: number,
): MonitorListenerEvidence | undefined {
  if (event.triggerKind !== "local_listener") {
    return undefined;
  }
  const sourceType = event.sourceType.trim().toLowerCase();
  if (sourceType !== "telegram-user" && sourceType !== "whatsapp") {
    return undefined;
  }

  const idempotencyKey = readBoundedIdentifier(event.idempotencyKey);
  const receivedAtMs = event.receivedAtMs;
  if (!idempotencyKey) {
    return undefined;
  }

  return {
    sourceKind: "local_listener",
    sourceType,
    idempotencyKeyHash: createHash("sha256").update(idempotencyKey).digest("hex"),
    receivedAtMs:
      typeof receivedAtMs === "number" && Number.isSafeInteger(receivedAtMs) && receivedAtMs >= 0
        ? receivedAtMs
        : nowMs,
    updatedAtMs: nowMs,
  };
}
