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
const PROCESSED_MESSAGE_DIRNAME = "followup-queue-processed";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const PROCESSED_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PROCESSED_MESSAGES = 10_000;
export const DURABLE_FOLLOWUP_RETRY_BASE_MS = 1_000;
export const DURABLE_FOLLOWUP_RETRY_MAX_MS = 5 * 60_000;

type ProcessedMessagePruneState = {
  estimatedLiveCount?: number;
  nextExpiryAt?: number;
  writesDuringPrune: number;
  nextExpiryDuringPrune?: number;
  inFlight?: Promise<boolean>;
};

type ProcessedMessagePruneResult = {
  liveCount: number;
  nextExpiryAt?: number;
};

// Startup seeds exact pressure/expiry state. Normal completions then avoid a
// directory scan until the known max-size or TTL boundary actually becomes due.
const processedMessagePruneStates = new Map<string, ProcessedMessagePruneState>();

type DurableFollowupCancellation = {
  version: typeof STORE_VERSION;
  id: string;
  queueKey: string;
  cancelledAt: number;
};

type DurableProcessedMessage = {
  version: typeof STORE_VERSION;
  /** SHA-256 of queue + route + provider message ID; raw identifiers never land here. */
  key: string;
  processedAt: number;
  expiresAt: number;
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
    /** Every original message represented by this carrier, including collect/summary inputs. */
    processedMessageKeys: string[];
    payloads: ReplyPayload[];
  };
  /** Opaque identity used only after successful drain to suppress provider redelivery. */
  processedMessageKey?: string;
  /** Cancellation generation already present when this new work began. */
  acceptedCancellationId?: string;
  /** Optional for compatibility with records written before durable retries. */
  retryCount?: number;
  /** Optional for compatibility; absence means immediately eligible. */
  nextAttemptAt?: number;
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

function resolveDurableProcessedMessageDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), PROCESSED_MESSAGE_DIRNAME);
}

function resolveDurableProcessedMessagePath(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveDurableProcessedMessageDir(env), `${key}.json`);
}

/**
 * Provider message IDs are only unique inside their route/account namespace.
 * Hash the complete tuple so dedupe distinguishes genuinely new messages while
 * the durable receipt directory reveals neither chat IDs nor message IDs.
 */
type DurableFollowupMessageIdentity = Pick<
  FollowupRun,
  | "messageId"
  | "originatingChannel"
  | "originatingTo"
  | "originatingAccountId"
  | "originatingThreadId"
>;

export function buildDurableFollowupMessageKey(
  queueKey: string,
  run: DurableFollowupMessageIdentity,
): string | undefined {
  const messageId = run.messageId?.trim();
  if (!messageId) {
    return undefined;
  }
  const identity = JSON.stringify([
    "queue",
    queueKey,
    run.originatingChannel ?? "",
    run.originatingTo ?? "",
    run.originatingAccountId ?? "",
    run.originatingThreadId == null ? "" : String(run.originatingThreadId),
    messageId,
  ]);
  return createHash("sha256").update(identity).digest("hex");
}

async function isDurableProcessedMessageKey(
  key: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): Promise<boolean> {
  if (!key) {
    return false;
  }
  const filePath = resolveDurableProcessedMessagePath(key, env);
  try {
    const parsed = JSON.parse(
      await fs.readFile(filePath, "utf8"),
    ) as Partial<DurableProcessedMessage>;
    if (
      parsed.version === STORE_VERSION &&
      parsed.key === key &&
      typeof parsed.expiresAt === "number" &&
      parsed.expiresAt > now
    ) {
      return true;
    }
    // Expired or malformed receipts cannot suppress a genuinely new delivery.
    await fs.rm(filePath, { force: true });
    return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

export async function isDurableFollowupMessageProcessed(params: {
  queueKey: string;
  run: DurableFollowupMessageIdentity;
  env?: NodeJS.ProcessEnv;
  now?: number;
}): Promise<boolean> {
  return isDurableProcessedMessageKey(
    buildDurableFollowupMessageKey(params.queueKey, params.run),
    params.env,
    params.now,
  );
}

/**
 * Suppress provider redelivery while the first accepted copy is still live.
 *
 * Telegram serializes one route before reaching this gate, so the read followed
 * by the direct-turn durable write cannot race another copy in the same topic.
 * Completed records use the cheaper receipt lookup above.
 */
export async function isDurableFollowupMessagePending(params: {
  queueKey: string;
  run: DurableFollowupMessageIdentity;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const key = buildDurableFollowupMessageKey(params.queueKey, params.run);
  if (!key) {
    return false;
  }
  const records = await loadDurableFollowups({ env: params.env });
  return records.some(
    (record) =>
      record.queueKey === params.queueKey &&
      (record.processedMessageKey === key ||
        (Array.isArray(record.delivery?.processedMessageKeys) &&
          record.delivery.processedMessageKeys.includes(key))),
  );
}

async function pruneDurableProcessedMessages(
  env: NodeJS.ProcessEnv,
  now: number,
): Promise<ProcessedMessagePruneResult> {
  const dir = resolveDurableProcessedMessageDir(env);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { liveCount: 0 };
    }
    throw err;
  }

  const live: Array<{ name: string; processedAt: number; expiresAt: number }> = [];
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(dir, name);
    try {
      const parsed = JSON.parse(
        await fs.readFile(filePath, "utf8"),
      ) as Partial<DurableProcessedMessage>;
      if (
        parsed.version !== STORE_VERSION ||
        typeof parsed.key !== "string" ||
        typeof parsed.processedAt !== "number" ||
        typeof parsed.expiresAt !== "number" ||
        parsed.expiresAt <= now
      ) {
        await fs.rm(filePath, { force: true });
        continue;
      }
      live.push({ name, processedAt: parsed.processedAt, expiresAt: parsed.expiresAt });
    } catch {
      await fs.rm(filePath, { force: true }).catch(() => undefined);
    }
  }

  // Keep the newest bounded set. Cleanup is intentionally independent of raw
  // provider identifiers because filenames and file contents are opaque hashes.
  const sorted = live.toSorted(
    (a, b) => b.processedAt - a.processedAt || b.name.localeCompare(a.name),
  );
  const kept = sorted.slice(0, MAX_PROCESSED_MESSAGES);
  const overflow = sorted.slice(MAX_PROCESSED_MESSAGES);
  await Promise.all(overflow.map(({ name }) => fs.rm(path.join(dir, name), { force: true })));
  const nextExpiryAt = kept.reduce<number | undefined>(
    (earliest, receipt) =>
      earliest === undefined ? receipt.expiresAt : Math.min(earliest, receipt.expiresAt),
    undefined,
  );
  return { liveCount: kept.length, nextExpiryAt };
}

async function maybePruneDurableProcessedMessages(
  env: NodeJS.ProcessEnv,
  now: number,
  writtenReceiptCount: number,
): Promise<void> {
  const dir = resolveDurableProcessedMessageDir(env);
  const state = processedMessagePruneStates.get(dir) ?? { writesDuringPrune: 0 };
  processedMessagePruneStates.set(dir, state);
  if (writtenReceiptCount > 0) {
    const writtenExpiryAt = now + PROCESSED_MESSAGE_TTL_MS;
    if (state.inFlight) {
      // A write may land after the scan captured its directory snapshot. Count
      // it conservatively so the completed scan cannot understate pressure.
      state.writesDuringPrune += writtenReceiptCount;
      state.nextExpiryDuringPrune = Math.min(
        state.nextExpiryDuringPrune ?? writtenExpiryAt,
        writtenExpiryAt,
      );
    } else {
      // Missing startup state deliberately starts at the limit, forcing one
      // lazy scan instead of assuming an inherited directory is empty.
      state.estimatedLiveCount =
        (state.estimatedLiveCount ?? MAX_PROCESSED_MESSAGES) + writtenReceiptCount;
      state.nextExpiryAt = Math.min(state.nextExpiryAt ?? writtenExpiryAt, writtenExpiryAt);
    }
  }

  while (
    state.estimatedLiveCount === undefined ||
    state.estimatedLiveCount > MAX_PROCESSED_MESSAGES ||
    (state.nextExpiryAt !== undefined && state.nextExpiryAt <= now)
  ) {
    // Concurrent completions share the scan. The owner loops again if enough
    // additional writes landed while that scan was in progress.
    if (state.inFlight) {
      if (!(await state.inFlight)) {
        return;
      }
      continue;
    }

    state.writesDuringPrune = 0;
    state.nextExpiryDuringPrune = undefined;
    let prune: Promise<boolean>;
    prune = pruneDurableProcessedMessages(env, now)
      .then((result) => {
        state.estimatedLiveCount = result.liveCount + state.writesDuringPrune;
        state.nextExpiryAt = [result.nextExpiryAt, state.nextExpiryDuringPrune]
          .filter((value): value is number => value !== undefined)
          .reduce<number | undefined>(
            (earliest, value) => (earliest === undefined ? value : Math.min(earliest, value)),
            undefined,
          );
        return true;
      })
      .catch(() => false)
      .finally(() => {
        if (state.inFlight === prune) {
          state.inFlight = undefined;
        }
      });
    state.inFlight = prune;
    if (!(await prune)) {
      // Receipt publication is already durable. Leave pressure/expiry due so
      // a later successful publication retries storage hygiene.
      return;
    }
  }
}

/** Startup maintenance for the bounded processed-message receipt directory. */
export async function cleanupDurableProcessedMessages(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): Promise<void> {
  const result = await pruneDurableProcessedMessages(env, now);
  processedMessagePruneStates.set(resolveDurableProcessedMessageDir(env), {
    estimatedLiveCount: result.liveCount,
    nextExpiryAt: result.nextExpiryAt,
    writesDuringPrune: 0,
  });
}

async function persistDurableProcessedMessageKeys(
  keys: Iterable<string>,
  env: NodeJS.ProcessEnv,
  now: number,
): Promise<number> {
  const uniqueKeys = [...new Set(keys)];
  await Promise.all(
    uniqueKeys.map((key) => {
      const receipt: DurableProcessedMessage = {
        version: STORE_VERSION,
        key,
        processedAt: now,
        expiresAt: now + PROCESSED_MESSAGE_TTL_MS,
      };
      return writeJsonAtomic(resolveDurableProcessedMessagePath(key, env), receipt, {
        mode: 0o600,
        ensureDirMode: 0o700,
        trailingNewline: true,
      });
    }),
  );
  return uniqueKeys.length;
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
  /**
   * Optional terminal envelope written in the same atomic record as acceptance.
   * Direct turns use this to avoid ever exposing replayable input between
   * acceptance and restart-blocker staging.
   */
  deliveryPayloads?: ReplyPayload[];
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
  const processedMessageKey = buildDurableFollowupMessageKey(params.queueKey, params.run);
  const record: DurableFollowupRecord = {
    version: STORE_VERSION,
    id,
    queueKey: params.queueKey,
    settings: params.settings,
    run: { ...safeFollowupRun, durableId: id, run: safeRunConfig },
    ...(params.deliveryPayloads !== undefined
      ? {
          delivery: {
            sourceDurableIds: [id],
            processedMessageKeys: processedMessageKey ? [processedMessageKey] : [],
            payloads: params.deliveryPayloads,
          },
        }
      : {}),
    processedMessageKey,
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
    durableRetryCount: record.retryCount,
    durableNextAttemptAt: record.nextAttemptAt,
    durableExpiresAt: record.expiresAt,
    // Presence, including an empty array, means agent/tool execution completed.
    deliveryPayloads: record.delivery?.payloads,
    run: { ...record.run.run, config },
  };
}

export type DurableFollowupRetryUpdate = {
  id: string;
  retryCount: number;
  nextAttemptAt: number;
  expiresAt: number;
};

/**
 * Persist the retry clock before the drain is re-armed.
 *
 * Backoff metadata contains no route/provider identifiers or credentials. The
 * cap prevents unbounded sleeps while the record TTL remains the terminal
 * boundary. Older records simply begin at attempt zero.
 */
export async function scheduleDurableFollowupRetries(params: {
  ids: Iterable<string | undefined>;
  now?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<{ scheduled: DurableFollowupRetryUpdate[]; terminalIds: string[] }> {
  const env = params.env ?? process.env;
  const now = params.now ?? Date.now();
  const scheduled: DurableFollowupRetryUpdate[] = [];
  const terminalIds: string[] = [];
  for (const id of new Set(params.ids)) {
    const cleaned = id?.trim();
    if (!cleaned) {
      continue;
    }
    const filePath = resolveDurableFollowupPath(cleaned, env);
    let record: DurableFollowupRecord;
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
      if (!isDurableFollowupRecord(parsed)) {
        await fs.rm(filePath, { force: true });
        terminalIds.push(cleaned);
        continue;
      }
      record = parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw err;
    }
    if (record.expiresAt <= now || isDurableFollowupRecordCancelled(record, env)) {
      await fs.rm(filePath, { force: true });
      terminalIds.push(record.id);
      continue;
    }
    const retryCount = Math.max(0, Math.floor(record.retryCount ?? 0)) + 1;
    const exponentialDelay = DURABLE_FOLLOWUP_RETRY_BASE_MS * 2 ** Math.min(30, retryCount - 1);
    const delayMs = Math.min(DURABLE_FOLLOWUP_RETRY_MAX_MS, exponentialDelay);
    const nextAttemptAt = Math.min(record.expiresAt, now + delayMs);
    const updated: DurableFollowupRecord = { ...record, retryCount, nextAttemptAt };
    await writeJsonAtomic(filePath, updated, {
      mode: 0o600,
      ensureDirMode: 0o700,
      trailingNewline: true,
    });
    scheduled.push({ id: record.id, retryCount, nextAttemptAt, expiresAt: record.expiresAt });
  }
  return { scheduled, terminalIds };
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
  const sourceRecords: DurableFollowupRecord[] = [];
  for (const id of sourceDurableIds) {
    try {
      const parsed = JSON.parse(
        await fs.readFile(resolveDurableFollowupPath(id, env), "utf8"),
      ) as unknown;
      if (isDurableFollowupRecord(parsed)) {
        carrier ??= parsed;
        sourceRecords.push(parsed);
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
    delivery: {
      sourceDurableIds,
      // Covered inputs are removed before outbound delivery. Preserve every
      // constituent's opaque identity on the carrier so successful completion
      // can publish receipts for collect/summarize batches, not just one file.
      processedMessageKeys: [
        ...new Set(
          sourceRecords.flatMap((source) => [
            source.processedMessageKey,
            ...(source.delivery?.processedMessageKeys ?? []),
          ]),
        ),
      ].filter((key): key is string => Boolean(key)),
      payloads: params.payloads,
    },
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

/**
 * Remove a known-successful prefix from a durable delivery-only carrier.
 *
 * The suffix is replaced atomically before another payload is routed, so both
 * immediate retry and startup recovery resume at the first undelivered item.
 * Provider acceptance followed by a crash before this checkpoint is still
 * ambiguous; local durability cannot provide cross-provider exactly-once send.
 */
export async function checkpointDurableFollowupDelivery(
  id: string | undefined,
  completedPayloadCount = 1,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DurableFollowupRecord | undefined> {
  const cleaned = id?.trim();
  const count = Math.max(0, Math.floor(completedPayloadCount));
  if (!cleaned || count === 0) {
    return undefined;
  }
  const filePath = resolveDurableFollowupPath(cleaned, env);
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  if (!isDurableFollowupRecord(parsed) || !parsed.delivery) {
    throw new Error(`Durable followup delivery checkpoint lost carrier ${cleaned}`);
  }
  if (isDurableFollowupRecordCancelled(parsed, env)) {
    await ackDurableFollowup(parsed.id, env);
    throw new DurableFollowupCancelledError(parsed.queueKey);
  }
  const updated: DurableFollowupRecord = {
    ...parsed,
    delivery: {
      ...parsed.delivery,
      payloads: parsed.delivery.payloads.slice(count),
    },
  };
  await writeJsonAtomic(filePath, updated, {
    mode: 0o600,
    ensureDirMode: 0o700,
    trailingNewline: true,
  });
  // Cancellation can race the atomic replacement. Remove a carrier rewritten
  // after the cancellation scan instead of resurrecting cancelled delivery.
  if (isDurableFollowupRecordCancelled(updated, env)) {
    await ackDurableFollowup(updated.id, env);
    throw new DurableFollowupCancelledError(updated.queueKey);
  }
  return updated;
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
  return records.find((record) => {
    const stagedIds = new Set(record.delivery?.sourceDurableIds ?? []);
    // A collect/summary retry can expand while an older outbound payload is
    // waiting for delivery. Reuse only the exact completed turn: intersection
    // matching would send stale output and let the drain acknowledge inputs
    // that the completed agent turn never represented.
    return stagedIds.size === wanted.size && [...stagedIds].every((id) => wanted.has(id));
  });
}

/**
 * Load a staged carrier by its own durable ID.
 *
 * Queue restoration places the carrier itself at the FIFO head while its
 * `sourceDurableIds` can also name inputs folded into an overflow summary and
 * therefore absent from `queue.items`. This intentionally differs from the
 * exact source-set lookup above: callers already know the persisted carrier
 * identity and must not infer it from a possibly expanded retry wrapper.
 */
export async function loadDurableFollowupDeliveryCarrier(
  id: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DurableFollowupRecord | undefined> {
  const cleaned = id?.trim();
  if (!cleaned) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(
      await fs.readFile(resolveDurableFollowupPath(cleaned, env), "utf8"),
    ) as unknown;
    return isDurableFollowupRecord(parsed) && parsed.delivery ? parsed : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
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
 * Complete a successfully drained record without reopening the Telegram offset
 * race. Receipts land before queue input deletion, so a crash or provider
 * redelivery after delivery but before cursor persistence cannot run a second
 * agent turn. Plain `ackDurableFollowup` remains cancellation/drop semantics.
 */
export async function completeDurableFollowup(
  id: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const cleaned = id?.trim();
  if (!cleaned) {
    return;
  }
  const filePath = resolveDurableFollowupPath(cleaned, env);
  let record: DurableFollowupRecord | undefined;
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    if (isDurableFollowupRecord(parsed)) {
      record = parsed;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
    return;
  }
  if (!record) {
    await fs.rm(filePath, { force: true });
    return;
  }

  const now = Date.now();
  const processedMessageKeys = [
    ...new Set([record.processedMessageKey, ...(record.delivery?.processedMessageKeys ?? [])]),
  ].filter((key): key is string => Boolean(key));
  const writtenReceiptCount = await persistDurableProcessedMessageKeys(
    processedMessageKeys,
    env,
    now,
  );

  // Once every receipt is durable, a leftover input file is harmless: restore
  // checks the same receipts before enqueue. Best-effort cleanup avoids turning
  // a post-delivery unlink failure into an immediate duplicate provider send.
  await Promise.all(
    [cleaned, ...(record.delivery?.sourceDurableIds ?? [])].map((sourceId) =>
      fs.rm(resolveDurableFollowupPath(sourceId, env), { force: true }).catch(() => undefined),
    ),
  );
  // Receipt publication is the correctness boundary; pruning is storage hygiene.
  // Startup prunes unconditionally, then successful writes amortize later scans.
  await maybePruneDurableProcessedMessages(env, now, writtenReceiptCount);
}

export async function isDurableFollowupRecordProcessed(
  record: DurableFollowupRecord,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const keys = [
    ...new Set([record.processedMessageKey, ...(record.delivery?.processedMessageKeys ?? [])]),
  ].filter((key): key is string => Boolean(key));
  if (keys.length === 0) {
    return false;
  }
  const processed = await Promise.all(keys.map((key) => isDurableProcessedMessageKey(key, env)));
  if (!processed.some(Boolean)) {
    return false;
  }
  // Publishing several constituent receipts cannot be one filesystem atomic
  // operation. Any landed receipt proves this carrier passed successful drain;
  // repair the missing siblings before suppressing restore/redelivery. If that
  // repair fails, startup/enqueue fails closed instead of rerunning side effects.
  const now = Date.now();
  const writtenReceiptCount = await persistDurableProcessedMessageKeys(keys, env, now);
  await maybePruneDurableProcessedMessages(env, now, writtenReceiptCount);
  return true;
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
    (record.retryCount === undefined ||
      (typeof record.retryCount === "number" &&
        Number.isFinite(record.retryCount) &&
        record.retryCount >= 0)) &&
    (record.nextAttemptAt === undefined ||
      (typeof record.nextAttemptAt === "number" && Number.isFinite(record.nextAttemptAt))) &&
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
