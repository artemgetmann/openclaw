import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { createAsyncLock, readJsonFile, writeJsonAtomic } from "../infra/json-files.js";

export type TelegramRecoveryIncident = {
  phase: "provider-restart" | "gateway-restart-requested" | "exhausted";
  providerRestartAttempts: number;
  reason?: string | null;
  updatedAt: number;
};

export type TelegramRecoveryStateLoadResult = {
  incidents: ReadonlyMap<string, TelegramRecoveryIncident>;
  /** Corruption without a trustworthy account key requires all active accounts to fail closed. */
  hasUnattributedCorruption: boolean;
};

export type TelegramRecoveryStateStore = {
  load: (now?: number) => Promise<TelegramRecoveryStateLoadResult>;
  set: (accountId: string, incident: TelegramRecoveryIncident) => Promise<void>;
  clear: (accountId: string) => Promise<void>;
};

type PersistedTelegramRecoveryIncident = {
  version: 1;
  accountId: string;
  phase: TelegramRecoveryIncident["phase"];
  providerRestartAttempts: number;
  updatedAt: number;
};

const STATE_DIRECTORY = path.join("gateway", "telegram-recovery");
const MAX_ACCOUNT_ID_LENGTH = 256;
const MAX_PROVIDER_RESTART_ATTEMPTS = 100;
const DEFAULT_MAX_RECORD_AGE_MS = 24 * 60 * 60_000;
const DEFAULT_FUTURE_CLOCK_SKEW_MS = 5 * 60_000;

// One gateway process owns these records. A module-level lock orders hot-reload
// monitor instances, while one atomic file per account avoids cross-account
// read/modify/write races and leaves an external replacement either old or new JSON.
const withTelegramRecoveryStateLock = createAsyncLock();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsAsciiControlCharacter(value: string): boolean {
  // Account ids become durable identity and file-key input. Reject the complete
  // ASCII C0 control block (U+0000..U+001F) plus DEL (U+007F) explicitly so the
  // security boundary stays auditable without relying on a control-character regex.
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function normalizeAccountId(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ACCOUNT_ID_LENGTH) {
    return null;
  }
  return containsAsciiControlCharacter(value) ? null : value;
}

function accountKey(accountId: string): string {
  return createHash("sha256").update(accountId).digest("hex");
}

function recoveryReason(phase: TelegramRecoveryIncident["phase"]): string {
  if (phase === "gateway-restart-requested") {
    return "Telegram gateway restart verification restored after gateway lifecycle replacement";
  }
  if (phase === "exhausted") {
    return "Telegram automatic recovery exhausted; manual intervention required";
  }
  return "Telegram provider recovery restored after gateway lifecycle replacement";
}

function resolveIncident(params: {
  raw: unknown;
  expectedAccountKey: string;
  now: number;
  maxRecordAgeMs: number;
  futureClockSkewMs: number;
}):
  | { accountId: string; incident: TelegramRecoveryIncident; normalized: boolean }
  | { accountId: null } {
  if (!isRecord(params.raw)) {
    return { accountId: null };
  }
  const accountId = normalizeAccountId(params.raw.accountId);
  if (!accountId || accountKey(accountId) !== params.expectedAccountKey) {
    return { accountId: null };
  }

  const phase = params.raw.phase;
  const attempts = params.raw.providerRestartAttempts;
  const updatedAt = params.raw.updatedAt;
  const versionValid = params.raw.version === 1;
  const phaseValid =
    phase === "provider-restart" || phase === "gateway-restart-requested" || phase === "exhausted";
  const attemptsValid =
    typeof attempts === "number" &&
    Number.isInteger(attempts) &&
    attempts >= 0 &&
    attempts <= MAX_PROVIDER_RESTART_ATTEMPTS;
  const updatedAtValid =
    typeof updatedAt === "number" && Number.isFinite(updatedAt) && updatedAt > 0;

  if (!versionValid || !phaseValid || !attemptsValid || !updatedAtValid) {
    return {
      accountId,
      incident: {
        phase: "exhausted",
        providerRestartAttempts: attemptsValid ? attempts : 0,
        reason: "Telegram recovery state was invalid; manual intervention required",
        updatedAt: params.now,
      },
      normalized: true,
    };
  }

  const tooFarInFuture = updatedAt > params.now + params.futureClockSkewMs;
  const expired = params.now - updatedAt > params.maxRecordAgeMs;
  if (tooFarInFuture || (expired && phase !== "exhausted")) {
    return {
      accountId,
      incident: {
        phase: "exhausted",
        providerRestartAttempts: attempts,
        reason: tooFarInFuture
          ? "Telegram recovery timestamp was invalid; manual intervention required"
          : "Telegram recovery verification expired; manual intervention required",
        // Preserve a valid old incident boundary so a successful poll after the
        // original incident can clear it. Future timestamps use now so they can
        // never create a terminal state that fresh polling cannot supersede.
        updatedAt: tooFarInFuture ? params.now : updatedAt,
      },
      normalized: true,
    };
  }

  return {
    accountId,
    incident: {
      phase,
      providerRestartAttempts: attempts,
      reason: recoveryReason(phase),
      updatedAt,
    },
    normalized: false,
  };
}

function persistedRecord(
  accountId: string,
  incident: TelegramRecoveryIncident,
): PersistedTelegramRecoveryIncident {
  const normalizedAccountId = normalizeAccountId(accountId);
  if (!normalizedAccountId) {
    throw new Error("invalid Telegram recovery account id");
  }
  if (
    (incident.phase !== "provider-restart" &&
      incident.phase !== "gateway-restart-requested" &&
      incident.phase !== "exhausted") ||
    !Number.isInteger(incident.providerRestartAttempts) ||
    incident.providerRestartAttempts < 0 ||
    incident.providerRestartAttempts > MAX_PROVIDER_RESTART_ATTEMPTS ||
    !Number.isFinite(incident.updatedAt) ||
    incident.updatedAt <= 0
  ) {
    throw new Error("invalid Telegram recovery incident");
  }
  return {
    version: 1,
    accountId: normalizedAccountId,
    phase: incident.phase,
    providerRestartAttempts: incident.providerRestartAttempts,
    updatedAt: incident.updatedAt,
  };
}

export function resolveTelegramRecoveryStatePath(stateDir: string, accountId: string): string {
  return path.join(stateDir, STATE_DIRECTORY, `${accountKey(accountId)}.json`);
}

export function createTelegramRecoveryStateStore(options?: {
  stateDir?: string;
  maxRecordAgeMs?: number;
  futureClockSkewMs?: number;
}): TelegramRecoveryStateStore {
  const stateDir = options?.stateDir ?? resolveStateDir();
  const directory = path.join(stateDir, STATE_DIRECTORY);
  const maxRecordAgeMs = Math.max(0, options?.maxRecordAgeMs ?? DEFAULT_MAX_RECORD_AGE_MS);
  const futureClockSkewMs = Math.max(0, options?.futureClockSkewMs ?? DEFAULT_FUTURE_CLOCK_SKEW_MS);

  return {
    load: async (now = Date.now()) =>
      await withTelegramRecoveryStateLock(async () => {
        let entries: string[];
        try {
          entries = await fs.readdir(directory);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return { incidents: new Map(), hasUnattributedCorruption: false };
          }
          throw err;
        }

        const incidents = new Map<string, TelegramRecoveryIncident>();
        let hasUnattributedCorruption = false;
        for (const entry of entries) {
          if (!entry.endsWith(".json")) {
            continue;
          }
          const filePath = path.join(directory, entry);
          const raw = await readJsonFile<unknown>(filePath);
          const resolved = resolveIncident({
            raw,
            expectedAccountKey: entry.slice(0, -".json".length),
            now,
            maxRecordAgeMs,
            futureClockSkewMs,
          });
          if (!resolved.accountId) {
            hasUnattributedCorruption = true;
            // Quarantine unreadable/unkeyed data so it cannot repeatedly grant
            // or deny restart authority. The current lifecycle still fails closed.
            await fs.rename(filePath, `${filePath}.${randomUUID()}.invalid`).catch(() => undefined);
            continue;
          }
          incidents.set(resolved.accountId, resolved.incident);
          if (resolved.normalized) {
            await writeJsonAtomic(
              filePath,
              persistedRecord(resolved.accountId, resolved.incident),
              { mode: 0o600, ensureDirMode: 0o700, trailingNewline: true },
            );
          }
        }
        return { incidents, hasUnattributedCorruption };
      }),
    set: async (accountId, incident) => {
      await withTelegramRecoveryStateLock(async () => {
        await writeJsonAtomic(
          resolveTelegramRecoveryStatePath(stateDir, accountId),
          // Reasons intentionally stay in memory: arbitrary error text can carry
          // credentials, while restart authority needs only phase/count/time.
          persistedRecord(accountId, incident),
          { mode: 0o600, ensureDirMode: 0o700, trailingNewline: true },
        );
      });
    },
    clear: async (accountId) => {
      await withTelegramRecoveryStateLock(async () => {
        await fs.rm(resolveTelegramRecoveryStatePath(stateDir, accountId), { force: true });
      });
    },
  };
}
