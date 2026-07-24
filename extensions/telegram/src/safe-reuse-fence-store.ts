import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../../../src/config/paths.js";
import { writeJsonAtomic } from "../../../src/infra/json-files.js";

const STORE_VERSION = 1;
const SAFE_REUSE_GENERATION_ENV = "OPENCLAW_TELEGRAM_SAFE_REUSE_GENERATION";
const SAFE_REUSE_TOKEN_HASH_ENV = "OPENCLAW_TELEGRAM_SAFE_REUSE_TOKEN_HASH";
const SAFE_REUSE_ACCOUNT_ID_ENV = "OPENCLAW_TELEGRAM_SAFE_REUSE_ACCOUNT_ID";

type TelegramSafeReuseFenceReceipt = {
  version: 1;
  generation: string;
  tokenHash: string;
  accountId: string;
  completedAt: string;
  lastUpdateId: number | null;
};

function normalizeAccountId(accountId?: string): string {
  const value = accountId?.trim() || "default";
  return value.replace(/[^a-z0-9._-]+/gi, "_");
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function receiptPath(accountId: string | undefined, env: NodeJS.ProcessEnv): string {
  return path.join(
    resolveStateDir(env, os.homedir),
    "telegram",
    `safe-reuse-fence-${normalizeAccountId(accountId)}.json`,
  );
}

function isValidGeneration(value: string): boolean {
  return value.length >= 8 && value.length <= 200 && /^[a-z0-9._:-]+$/iu.test(value);
}

export function resolveTelegramSafeReuseFenceRequest(params: {
  botToken: string;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): { generation: string } | null {
  const env = params.env ?? process.env;
  const generation = String(env[SAFE_REUSE_GENERATION_ENV] ?? "").trim();
  if (!generation) {
    return null;
  }
  if (!isValidGeneration(generation)) {
    throw new Error(`${SAFE_REUSE_GENERATION_ENV} is malformed; refusing Telegram polling.`);
  }
  const scopedTokenHash = String(env[SAFE_REUSE_TOKEN_HASH_ENV] ?? "").trim();
  const scopedAccountId = String(env[SAFE_REUSE_ACCOUNT_ID_ENV] ?? "").trim();
  if (!/^[a-f0-9]{64}$/u.test(scopedTokenHash) || !scopedAccountId) {
    throw new Error("Telegram safe-reuse scope is missing or malformed; refusing polling.");
  }

  // One gateway process may host named Telegram accounts. Only the exact
  // reserved tester bot/account is allowed to consume this generation; other
  // accounts keep their own cursor and webhook lifecycle untouched.
  if (
    hashToken(params.botToken) !== scopedTokenHash ||
    normalizeAccountId(params.accountId) !== normalizeAccountId(scopedAccountId)
  ) {
    return null;
  }
  return { generation };
}

function parseReceipt(raw: string): TelegramSafeReuseFenceReceipt | null {
  try {
    const parsed = JSON.parse(raw) as Partial<TelegramSafeReuseFenceReceipt>;
    if (
      parsed.version !== STORE_VERSION ||
      typeof parsed.generation !== "string" ||
      typeof parsed.tokenHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(parsed.tokenHash) ||
      typeof parsed.accountId !== "string" ||
      typeof parsed.completedAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.completedAt)) ||
      (parsed.lastUpdateId !== null &&
        (!Number.isSafeInteger(parsed.lastUpdateId) || Number(parsed.lastUpdateId) < 0))
    ) {
      return null;
    }
    return parsed as TelegramSafeReuseFenceReceipt;
  } catch {
    return null;
  }
}

export async function hasCompletedTelegramSafeReuseFence(params: {
  accountId?: string;
  botToken: string;
  generation: string;
  persistedLastUpdateId: number | null;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const tokenHash = hashToken(params.botToken);
  const accountId = normalizeAccountId(params.accountId);
  try {
    const raw = await fs.readFile(receiptPath(params.accountId, params.env ?? process.env), "utf8");
    const receipt = parseReceipt(raw);
    // Both fields are required. A worktree may reuse its state directory for
    // another tester bot later, and a generation alone must never bless that
    // bot's unrelated backlog.
    const matchesOwner =
      receipt?.generation === params.generation &&
      receipt.tokenHash === tokenHash &&
      receipt.accountId === accountId;
    if (!matchesOwner) {
      return false;
    }
    // A non-empty tail is safe only while its durable cutoff is still active.
    // Missing/ignored/rewound offset state must repeat the transport-only
    // fence instead of trusting a receipt that can no longer suppress backlog.
    return (
      receipt.lastUpdateId === null ||
      (params.persistedLastUpdateId !== null &&
        params.persistedLastUpdateId >= receipt.lastUpdateId)
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

export async function writeCompletedTelegramSafeReuseFence(params: {
  accountId?: string;
  botToken: string;
  generation: string;
  lastUpdateId: number | null;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const tokenHash = hashToken(params.botToken);
  if (!isValidGeneration(params.generation)) {
    throw new Error("Cannot persist Telegram safe-reuse fence for malformed bot identity.");
  }
  if (
    params.lastUpdateId !== null &&
    (!Number.isSafeInteger(params.lastUpdateId) || params.lastUpdateId < 0)
  ) {
    throw new Error("Cannot persist Telegram safe-reuse fence with an invalid update id.");
  }
  const accountId = normalizeAccountId(params.accountId);
  const filePath = receiptPath(params.accountId, params.env ?? process.env);
  await writeJsonAtomic(
    filePath,
    {
      version: STORE_VERSION,
      generation: params.generation,
      tokenHash,
      accountId,
      completedAt: new Date().toISOString(),
      lastUpdateId: params.lastUpdateId,
    } satisfies TelegramSafeReuseFenceReceipt,
    {
      mode: 0o600,
      trailingNewline: true,
      ensureDirMode: 0o700,
    },
  );
}
