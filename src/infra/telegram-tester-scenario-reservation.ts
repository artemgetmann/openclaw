import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type ReservationPayload = {
  version: 1;
  tokenHash: string;
  tokenFingerprint: string;
  botId: string;
  scenarioId: string;
  worktreePath: string;
  generation: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

export class TelegramTesterScenarioReservationConflictError extends Error {
  readonly reservationPath: string;

  constructor(params: { reservationPath: string; reason: string }) {
    super(`Telegram tester scenario reservation rejected runtime startup (${params.reason}).`);
    this.name = "TelegramTesterScenarioReservationConflictError";
    this.reservationPath = params.reservationPath;
  }
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function botIdFromToken(token: string): string {
  const value = token.split(":", 1)[0]?.trim() ?? "";
  return /^\d+$/.test(value) ? value : "bot";
}

function fingerprintToken(token: string): string {
  return hashToken(token).slice(0, 12);
}

export function resolveTelegramTesterScenarioReservationPath(params: {
  token: string;
  reservationRoot?: string;
}): string {
  const root = params.reservationRoot?.trim()
    ? path.resolve(params.reservationRoot.trim())
    : path.join(os.homedir(), ".openclaw", "telegram-tester-scenario-reservations");
  return path.join(root, `${botIdFromToken(params.token)}-${hashToken(params.token)}.json`);
}

export async function hasTelegramTesterScenarioReservationState(params: {
  token: string;
  reservationRoot?: string;
}): Promise<boolean> {
  const filePath = resolveTelegramTesterScenarioReservationPath(params);
  for (const candidate of [filePath, `${filePath}.lock`]) {
    try {
      await fs.access(candidate);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
  return false;
}

export async function withTelegramTesterScenarioReservationGuard<T>(params: {
  token: string;
  reservationRoot?: string;
  fn: () => Promise<T>;
}): Promise<T> {
  const filePath = resolveTelegramTesterScenarioReservationPath(params);
  const lockPath = `${filePath}.lock`;
  const ownerPath = path.join(lockPath, "owner.json");
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(filePath), 0o700).catch(() => {});
  try {
    await fs.mkdir(lockPath, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new TelegramTesterScenarioReservationConflictError({
        reservationPath: filePath,
        reason: "reservation_lock_present_manual_recovery_required",
      });
    }
    throw err;
  }

  try {
    await fs.writeFile(
      ownerPath,
      `${JSON.stringify({
        version: 1,
        pid: process.pid,
        createdAt: new Date().toISOString(),
      })}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    return await params.fn();
  } finally {
    // The lock directory cannot be replaced while it exists, so this cleanup
    // cannot remove a concurrently acquired successor.
    await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}

function parseReservation(raw: string): ReservationPayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ReservationPayload>;
    if (
      parsed.version !== 1 ||
      !isValidOwnerString(parsed.scenarioId) ||
      !isValidOwnerString(parsed.worktreePath) ||
      !path.isAbsolute(parsed.worktreePath) ||
      !isValidOwnerString(parsed.generation) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
        parsed.generation,
      ) ||
      typeof parsed.tokenHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(parsed.tokenHash) ||
      typeof parsed.tokenFingerprint !== "string" ||
      !/^[a-f0-9]{12}$/u.test(parsed.tokenFingerprint) ||
      typeof parsed.botId !== "string" ||
      !/^(?:bot|\d+)$/u.test(parsed.botId) ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.updatedAt !== "string" ||
      typeof parsed.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.createdAt)) ||
      !Number.isFinite(Date.parse(parsed.updatedAt)) ||
      !Number.isFinite(Date.parse(parsed.expiresAt)) ||
      Date.parse(parsed.createdAt) > Date.parse(parsed.updatedAt) ||
      Date.parse(parsed.updatedAt) > Date.parse(parsed.expiresAt)
    ) {
      return null;
    }
    return parsed as ReservationPayload;
  } catch {
    return null;
  }
}

function isValidOwnerString(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) {
    return false;
  }
  return !Array.from(normalized).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

async function canonicalizeWorktree(worktreePath: string): Promise<string> {
  const resolved = path.resolve(worktreePath.trim());
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

export async function validateTelegramTesterScenarioReservation(params: {
  token: string;
  scenarioId?: string | null;
  generation?: string | null;
  tokenHash?: string | null;
  worktree?: string | null;
  reservationRoot?: string;
}): Promise<"unreserved" | "owned"> {
  const filePath = resolveTelegramTesterScenarioReservationPath({
    token: params.token,
    reservationRoot: params.reservationRoot,
  });
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return "unreserved";
    }
    throw err;
  }

  const payload = parseReservation(raw);
  if (!payload) {
    throw new TelegramTesterScenarioReservationConflictError({
      reservationPath: filePath,
      reason: "malformed_reservation",
    });
  }
  const scenarioId = params.scenarioId?.trim() ?? "";
  const generation = params.generation?.trim() ?? "";
  const claimedTokenHash = params.tokenHash?.trim() ?? "";
  const worktree = params.worktree?.trim() ?? "";
  if (!scenarioId || !generation || !claimedTokenHash || !worktree) {
    throw new TelegramTesterScenarioReservationConflictError({
      reservationPath: filePath,
      reason: "runtime_owner_metadata_missing",
    });
  }

  const expectedTokenHash = hashToken(params.token);
  const [actualWorktree, expectedWorktree] = await Promise.all([
    canonicalizeWorktree(worktree),
    canonicalizeWorktree(payload.worktreePath),
  ]);
  if (
    payload.tokenHash !== expectedTokenHash ||
    payload.tokenFingerprint !== fingerprintToken(params.token) ||
    payload.botId !== botIdFromToken(params.token) ||
    claimedTokenHash !== expectedTokenHash ||
    payload.scenarioId !== scenarioId ||
    payload.generation !== generation ||
    actualWorktree !== expectedWorktree
  ) {
    throw new TelegramTesterScenarioReservationConflictError({
      reservationPath: filePath,
      reason: "runtime_owner_mismatch",
    });
  }
  return "owned";
}
