import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../../config/config.js";
import { resolveStateDir } from "../../../config/paths.js";
import { writeJsonAtomic } from "../../../infra/json-files.js";
import { generateSecureUuid } from "../../../infra/secure-random.js";
import type { ReplyPayload } from "../../types.js";
import type { FollowupRun, QueueSettings } from "./types.js";

const STORE_VERSION = 1;
const QUEUE_DIRNAME = "followup-queue";
const CANCELLATION_DIRNAME = "followup-queue-cancellations";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

type DurableFollowupCancellation = {
  version: typeof STORE_VERSION;
  id: string;
  queueKey: string;
  cancelledAt: number;
};

export class DurableFollowupCancelledError extends Error {
  constructor(readonly queueKey: string) {
    super(`Durable followup was cancelled for queue ${queueKey}`);
    this.name = "DurableFollowupCancelledError";
  }
}

export type DurableFollowupRecord = {
  version: typeof STORE_VERSION;
  id: string;
  queueKey: string;
  settings: QueueSettings;
  run: Omit<FollowupRun, "run" | "durableIds" | "deliveryPayloads"> & {
    run: Omit<FollowupRun["run"], "config">;
  };
  /** Present after agent/tool completion and before successful outbound delivery. */
  delivery?: {
    sourceDurableIds: string[];
    payloads: ReplyPayload[];
  };
  /** Cancellation generation already present when this new work began. */
  acceptedCancellationId?: string;
  createdAt: number;
  expiresAt: number;
};

function resolveDurableFollowupDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), QUEUE_DIRNAME);
}

function resolveDurableFollowupPath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveDurableFollowupDir(env), `${id}.json`);
}

function resolveDurableFollowupCancellationDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), CANCELLATION_DIRNAME);
}

function resolveDurableFollowupCancellationPath(
  queueKey: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  // Queue keys can contain provider/user identifiers and path separators. Hash
  // them into an opaque, filesystem-safe name instead of leaking them in state.
  const filename = createHash("sha256").update(queueKey).digest("hex");
  return path.join(resolveDurableFollowupCancellationDir(env), `${filename}.json`);
}

function loadDurableFollowupCancellationSync(
  queueKey: string,
  env: NodeJS.ProcessEnv = process.env,
): DurableFollowupCancellation | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(resolveDurableFollowupCancellationPath(queueKey, env), "utf8"),
    ) as Partial<DurableFollowupCancellation>;
    if (
      parsed.version === STORE_VERSION &&
      typeof parsed.id === "string" &&
      parsed.queueKey === queueKey &&
      typeof parsed.cancelledAt === "number"
    ) {
      return parsed as DurableFollowupCancellation;
    }
    throw new Error(`Invalid durable followup cancellation for queue ${queueKey}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

export function isDurableFollowupRecordCancelled(
  record: Pick<DurableFollowupRecord, "queueKey" | "createdAt" | "acceptedCancellationId">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const cancellation = loadDurableFollowupCancellationSync(record.queueKey, env);
  if (!cancellation) {
    return false;
  }
  if (record.acceptedCancellationId === cancellation.id) {
    return false;
  }
  // Parsed restart records that do not name the accepted generation are older
  // work. Equality favors explicit cancellation so a timestamp tie cannot
  // resurrect work after the user asked to clear the session.
  return record.createdAt <= cancellation.cancelledAt;
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
  const cancellationAtStart = loadDurableFollowupCancellationSync(params.queueKey, params.env);
  const now = params.now ?? Date.now();
  const id = params.run.durableId?.trim() || generateSecureUuid();
  // Config may contain bot tokens and provider credentials. Recovery reloads
  // current config instead of duplicating secrets in this queue directory.
  const { config: _sensitiveConfig, ...safeRunConfig } = params.run.run;
  const {
    durableIds: _syntheticDurableIds,
    deliveryPayloads: _stagedDeliveryPayloads,
    ...safeFollowupRun
  } = params.run;
  const record: DurableFollowupRecord = {
    version: STORE_VERSION,
    id,
    queueKey: params.queueKey,
    settings: params.settings,
    run: { ...safeFollowupRun, durableId: id, run: safeRunConfig },
    acceptedCancellationId: cancellationAtStart?.id,
    createdAt: now,
    expiresAt: now + Math.max(1, params.ttlMs ?? DEFAULT_TTL_MS),
  };
  await writeJsonAtomic(resolveDurableFollowupPath(id, params.env), record, {
    mode: 0o600,
    ensureDirMode: 0o700,
    trailingNewline: true,
  });
  // Cancellation can run while the atomic write is in flight. Re-check after
  // rename so a late record cannot land behind the cancellation scan.
  const cancellationAfterWrite = loadDurableFollowupCancellationSync(record.queueKey, params.env);
  if (cancellationAfterWrite?.id !== cancellationAtStart?.id) {
    await ackDurableFollowup(record.id, params.env);
    throw new DurableFollowupCancelledError(record.queueKey);
  }
  return record;
}

export function hydrateDurableFollowup(
  record: DurableFollowupRecord,
  config: OpenClawConfig,
): FollowupRun {
  return {
    ...record.run,
    durableId: record.id,
    durableIds: record.delivery?.sourceDurableIds,
    deliveryPayloads: record.delivery?.payloads,
    run: { ...record.run.run, config },
  };
}

function normalizeDurableIds(run: FollowupRun): string[] {
  return [...new Set([run.durableId, ...(run.durableIds ?? [])])].filter((id): id is string =>
    Boolean(id?.trim()),
  );
}

/**
 * Atomically transition durable agent input into delivery-only output.
 *
 * The carrier reuses one constituent record, while `sourceDurableIds` covers
 * the rest. Recovery suppresses those covered input records, so a crash cannot
 * replay the completed model turn merely because a collect wrapper represented
 * several files. Runtime config remains excluded from the rewritten record.
 */
export async function persistDurableFollowupDelivery(params: {
  run: FollowupRun;
  payloads: ReplyPayload[];
  env?: NodeJS.ProcessEnv;
}): Promise<DurableFollowupRecord | undefined> {
  const sourceDurableIds = normalizeDurableIds(params.run);
  if (sourceDurableIds.length === 0) {
    return undefined;
  }
  const env = params.env ?? process.env;
  let carrier: DurableFollowupRecord | undefined;
  for (const id of sourceDurableIds) {
    try {
      const parsed = JSON.parse(
        await fs.readFile(resolveDurableFollowupPath(id, env), "utf8"),
      ) as unknown;
      if (isDurableFollowupRecord(parsed)) {
        carrier = parsed;
        break;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
  if (!carrier) {
    throw new Error("Durable followup delivery transition lost its input record");
  }
  // Cancellation can publish its cutoff after the carrier is read but before
  // this transition writes. Stop here when possible; the post-write check
  // below closes the unavoidable async-write window and removes a late carrier.
  if (isDurableFollowupRecordCancelled(carrier, env)) {
    await ackDurableFollowup(carrier.id, env);
    throw new DurableFollowupCancelledError(carrier.queueKey);
  }
  const record: DurableFollowupRecord = {
    ...carrier,
    // This is the exact user-facing outbound envelope, including channelData
    // required by adapters (Slack blocks, Telegram flags, etc.). It may contain
    // generated user content, but never runtime config/auth: those remain only
    // in `FollowupRun.run.config`, which the disk schema excludes above.
    delivery: { sourceDurableIds, payloads: params.payloads },
  };
  await writeJsonAtomic(resolveDurableFollowupPath(record.id, env), record, {
    mode: 0o600,
    ensureDirMode: 0o700,
    trailingNewline: true,
  });
  // The carrier is now the sole durable owner. Remove covered inputs before
  // the first provider call so acknowledging the carrier can never reveal and
  // replay an older constituent record.
  await removeCoveredInputRecords(record, env);
  // `ackDurableFollowupsForQueueSync` first publishes its cutoff, then scans
  // files. It can race both the carrier rewrite and covered-input cleanup, so
  // this must remain the final await before returning a routable delivery.
  // Deleting here handles a carrier rewritten after the cancellation scan.
  if (isDurableFollowupRecordCancelled(record, env)) {
    await ackDurableFollowup(record.id, env);
    throw new DurableFollowupCancelledError(record.queueKey);
  }
  return record;
}

async function removeCoveredInputRecords(
  record: DurableFollowupRecord,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await Promise.all(
    (record.delivery?.sourceDurableIds ?? [])
      .filter((id) => id !== record.id)
      .map((id) => fs.rm(resolveDurableFollowupPath(id, env), { force: true })),
  );
}

/** Find an already-completed delivery stage for an in-memory retry wrapper. */
export async function loadDurableFollowupDelivery(
  sourceIds: Iterable<string>,
): Promise<DurableFollowupRecord | undefined> {
  const wanted = new Set([...sourceIds].filter((id) => id.trim()));
  if (wanted.size === 0) {
    return undefined;
  }
  const records = await loadDurableFollowups();
  return records.find((record) => record.delivery?.sourceDurableIds.some((id) => wanted.has(id)));
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

/**
 * Explicit cancellation is intentionally synchronous: callers already rely on
 * `clearFollowupQueue` completing before they abort/reset the surrounding
 * session. Removing each durable record before RAM state disappears prevents
 * an immediate restart from resurrecting work the user explicitly cancelled.
 */
export function ackDurableFollowupsSync(
  ids: Iterable<string | undefined>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const id of new Set(ids)) {
    const cleaned = id?.trim();
    if (!cleaned) {
      continue;
    }
    rmSync(resolveDurableFollowupPath(cleaned, env), { force: true });
  }
}

/**
 * Cancel every on-disk record for a session queue, including records not yet
 * restored into RAM after startup. The directory scan is synchronous for the
 * same reason as ID acknowledgement: explicit cancellation must be durable
 * before its existing synchronous API returns.
 */
export function ackDurableFollowupsForQueueSync(
  queueKey: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const cleanedKey = queueKey.trim();
  if (!cleanedKey) {
    return;
  }
  const cancellation: DurableFollowupCancellation = {
    version: STORE_VERSION,
    id: generateSecureUuid(),
    queueKey: cleanedKey,
    cancelledAt: Date.now(),
  };
  const cancellationDir = resolveDurableFollowupCancellationDir(env);
  const cancellationPath = resolveDurableFollowupCancellationPath(cleanedKey, env);
  const temporaryPath = `${cancellationPath}.${generateSecureUuid()}.tmp`;
  // Publish the cutoff before scanning records. A persist already in flight
  // will observe it after rename; restore also enforces it after a crash.
  mkdirSync(cancellationDir, { recursive: true, mode: 0o700 });
  writeFileSync(temporaryPath, `${JSON.stringify(cancellation)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, cancellationPath);
  const dir = resolveDurableFollowupDir(env);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return;
    }
    throw err;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(dir, name);
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
      if (isDurableFollowupRecord(parsed) && parsed.queueKey === cleanedKey) {
        rmSync(filePath, { force: true });
      }
    } catch (err) {
      // Another successful drain may remove a file between scan and read.
      // Any other failure must reach the cancellation caller instead of
      // pretending disk state is clean.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    } catch {
      // A malformed record cannot be replayed safely. Quarantine-by-deletion
      // avoids blocking every later recovery scan on the same corrupt file.
      await fs.rm(filePath, { force: true }).catch(() => undefined);
      continue;
    }
    if (!isDurableFollowupRecord(parsed) || parsed.expiresAt <= now) {
      await fs.rm(filePath, { force: true });
      continue;
    }
    // Read cancellation state outside the malformed-record catch. A corrupt or
    // unreadable tombstone must stop recovery, not silently delete valid work.
    if (isDurableFollowupRecordCancelled(parsed, env)) {
      await fs.rm(filePath, { force: true });
      continue;
    }
    records.push(parsed);
  }
  const coveredInputIds = new Set<string>();
  for (const record of records) {
    // Also finish an interrupted carrier transition before exposing it to the
    // recovery runner. Failure aborts restore rather than risking agent replay.
    await removeCoveredInputRecords(record, env);
    for (const id of record.delivery?.sourceDurableIds ?? []) {
      if (id !== record.id) {
        coveredInputIds.add(id);
      }
    }
  }
  return records
    .filter((record) => !coveredInputIds.has(record.id))
    .toSorted((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}
