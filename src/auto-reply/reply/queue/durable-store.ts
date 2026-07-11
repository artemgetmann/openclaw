import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../../config/config.js";
import { resolveStateDir } from "../../../config/paths.js";
import { writeJsonAtomic } from "../../../infra/json-files.js";
import { generateSecureUuid } from "../../../infra/secure-random.js";
import type { FollowupRun, QueueSettings } from "./types.js";

const STORE_VERSION = 1;
const QUEUE_DIRNAME = "followup-queue";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export type DurableFollowupRecord = {
  version: typeof STORE_VERSION;
  id: string;
  queueKey: string;
  settings: QueueSettings;
  run: Omit<FollowupRun, "run"> & { run: Omit<FollowupRun["run"], "config"> };
  createdAt: number;
  expiresAt: number;
};

function resolveDurableFollowupDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), QUEUE_DIRNAME);
}

function resolveDurableFollowupPath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveDurableFollowupDir(env), `${id}.json`);
}

/**
 * Write the complete replay input before the transport update is acknowledged.
 * The atomic rename means a crash leaves either the old state or the full new
 * record, never a truncated JSON file that looks successfully accepted.
 */
export async function persistDurableFollowup(params: {
  queueKey: string;
  settings: QueueSettings;
  run: FollowupRun;
  now?: number;
  ttlMs?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<DurableFollowupRecord> {
  const now = params.now ?? Date.now();
  const id = params.run.durableId?.trim() || generateSecureUuid();
  // Config may contain bot tokens and provider credentials. Recovery reloads
  // current config instead of duplicating secrets in this queue directory.
  const { config: _sensitiveConfig, ...safeRunConfig } = params.run.run;
  const record: DurableFollowupRecord = {
    version: STORE_VERSION,
    id,
    queueKey: params.queueKey,
    settings: params.settings,
    run: { ...params.run, durableId: id, run: safeRunConfig },
    createdAt: now,
    expiresAt: now + Math.max(1, params.ttlMs ?? DEFAULT_TTL_MS),
  };
  await writeJsonAtomic(resolveDurableFollowupPath(id, params.env), record, {
    mode: 0o600,
    ensureDirMode: 0o700,
    trailingNewline: true,
  });
  return record;
}

export function hydrateDurableFollowup(
  record: DurableFollowupRecord,
  config: OpenClawConfig,
): FollowupRun {
  return { ...record.run, run: { ...record.run.run, config } };
}

export async function ackDurableFollowup(
  id: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const cleaned = id?.trim();
  if (!cleaned) {
    return;
  }
  await fs.rm(resolveDurableFollowupPath(cleaned, env), { force: true });
}

function isDurableFollowupRecord(value: unknown): value is DurableFollowupRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<DurableFollowupRecord>;
  return (
    record.version === STORE_VERSION &&
    typeof record.id === "string" &&
    typeof record.queueKey === "string" &&
    Boolean(record.settings) &&
    Boolean(record.run) &&
    typeof record.expiresAt === "number"
  );
}

export async function loadDurableFollowups(params?: {
  now?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<DurableFollowupRecord[]> {
  const env = params?.env ?? process.env;
  const now = params?.now ?? Date.now();
  const dir = resolveDurableFollowupDir(env);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const records: DurableFollowupRecord[] = [];
  for (const name of names.toSorted()) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(dir, name);
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
      if (!isDurableFollowupRecord(parsed) || parsed.expiresAt <= now) {
        await fs.rm(filePath, { force: true });
        continue;
      }
      records.push(parsed);
    } catch {
      // A malformed record cannot be replayed safely. Quarantine-by-deletion
      // avoids blocking every later recovery scan on the same corrupt file.
      await fs.rm(filePath, { force: true }).catch(() => undefined);
    }
  }
  return records.toSorted((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}
