import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { expandHomePrefix } from "../infra/home-dir.js";
import { CONFIG_DIR } from "../utils.js";
import type {
  MonitorCreateInput,
  MonitorRecord,
  MonitorStoreFile,
  MonitorUpdatePatch,
} from "./types.js";

export const DEFAULT_MONITOR_DIR = path.join(CONFIG_DIR, "monitors");
export const DEFAULT_MONITOR_STORE_PATH = path.join(DEFAULT_MONITOR_DIR, "monitors.json");

const serializedStoreCache = new Map<string, string>();

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
    const store = { version: 1 as const, monitors: monitors.filter(Boolean) };
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

export function createMonitorRecord(input: MonitorCreateInput, nowMs: number): MonitorRecord {
  return {
    monitorId: input.monitorId ?? randomBytes(12).toString("hex"),
    agentId: input.agentId,
    ...(input.name?.trim() ? { name: input.name.trim() } : {}),
    originSessionKey: input.originSessionKey,
    ...(input.originDelivery ? { originDelivery: input.originDelivery } : {}),
    monitorSessionKey: input.monitorSessionKey,
    sourceType: input.sourceType.trim(),
    sourceTarget: input.sourceTarget,
    cadence: input.cadence,
    ...(input.expiryAt?.trim() ? { expiryAt: input.expiryAt.trim() } : {}),
    ...(input.stopCondition?.trim() ? { stopCondition: input.stopCondition.trim() } : {}),
    actionPolicy: input.actionPolicy ?? "notify_draft",
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
