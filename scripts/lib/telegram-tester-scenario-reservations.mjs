import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const RESERVATION_VERSION = 1;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function fingerprintToken(token) {
  return hashToken(token).slice(0, 12);
}

function botIdFromToken(token) {
  const value = token.split(":", 1)[0]?.trim() ?? "";
  return /^\d+$/.test(value) ? value : "bot";
}

function normalizeOwnerString(value, label) {
  const normalized = String(value ?? "").trim();
  if (!isValidOwnerString(normalized)) {
    throw new Error(`${label} must be a non-empty printable string of at most 200 characters.`);
  }
  return normalized;
}

function isValidOwnerString(value) {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim();
  const hasControlCharacter = Array.from(normalized).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
  return Boolean(normalized && normalized.length <= 200 && !hasControlCharacter);
}

function canonicalizeWorktree(worktreePath) {
  const resolved = path.resolve(normalizeOwnerString(worktreePath, "worktreePath"));
  return fs.realpath(resolved).catch(() => resolved);
}

function resolveReservationRoot(customRoot) {
  const value = String(customRoot ?? "").trim();
  return value
    ? path.resolve(value)
    : path.join(os.homedir(), ".openclaw", "telegram-tester-scenario-reservations");
}

export function resolveTelegramTesterScenarioReservationPath(params) {
  const token = normalizeOwnerString(params?.token, "token");
  return path.join(
    resolveReservationRoot(params?.reservationRoot),
    `${botIdFromToken(token)}-${hashToken(token)}.json`,
  );
}

export async function findTelegramTesterScenarioReservation(params) {
  const scenarioId = normalizeOwnerString(params?.scenarioId, "scenarioId");
  const worktreePath = await canonicalizeWorktree(params?.worktreePath);
  const reservationRoot = resolveReservationRoot(params?.reservationRoot);
  let names;
  try {
    names = await fs.readdir(reservationRoot);
  } catch (err) {
    if (err?.code === "ENOENT") {
      return { ok: true, reservation: null };
    }
    throw err;
  }

  const matches = [];
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const reservationPath = path.join(reservationRoot, name);
    const current = await readReservation(reservationPath);
    if (
      current.payload &&
      current.payload.scenarioId === scenarioId &&
      path.resolve(current.payload.worktreePath) === path.resolve(worktreePath)
    ) {
      const canonicalName = `${current.payload.botId}-${current.payload.tokenHash}.json`;
      const fingerprintMatchesHash =
        current.payload.tokenFingerprint === current.payload.tokenHash.slice(0, 12);
      if (name !== canonicalName || !fingerprintMatchesHash) {
        // Discovery must not authenticate a parseable payload independently
        // from its canonical token file. A renamed file or unrelated
        // fingerprint could otherwise pin recovery to one token while acquire
        // writes another canonical file, recreating duplicate ownership.
        return {
          ok: false,
          reason: "reservation_identity_mismatch_manual_recovery_required",
          reservationPaths: [reservationPath],
        };
      }
      matches.push({
        tokenHash: current.payload.tokenHash,
        generation: current.payload.generation,
        reservationPath,
      });
    }
  }

  if (matches.length > 1) {
    // Multiple token files for one scenario/worktree are ambiguous ownership.
    // Never choose one by directory order; an operator must resolve the stale
    // duplicate before assignment can safely continue.
    return {
      ok: false,
      reason: "duplicate_scenario_reservations",
      reservationPaths: matches.map((match) => match.reservationPath),
    };
  }
  return { ok: true, reservation: matches[0] ?? null };
}

function parseReservation(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed?.version !== RESERVATION_VERSION ||
      typeof parsed.tokenHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(parsed.tokenHash) ||
      typeof parsed.tokenFingerprint !== "string" ||
      !/^[a-f0-9]{12}$/u.test(parsed.tokenFingerprint) ||
      typeof parsed.botId !== "string" ||
      !/^(?:bot|\d+)$/u.test(parsed.botId) ||
      !isValidOwnerString(parsed.scenarioId) ||
      !isValidOwnerString(parsed.worktreePath) ||
      !path.isAbsolute(parsed.worktreePath) ||
      typeof parsed.generation !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
        parsed.generation,
      ) ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.updatedAt !== "string" ||
      typeof parsed.expiresAt !== "string" ||
      (parsed.requiresSafeReuseFence !== undefined &&
        typeof parsed.requiresSafeReuseFence !== "boolean")
    ) {
      return null;
    }
    if (
      !Number.isFinite(Date.parse(parsed.createdAt)) ||
      !Number.isFinite(Date.parse(parsed.updatedAt)) ||
      !Number.isFinite(Date.parse(parsed.expiresAt)) ||
      Date.parse(parsed.createdAt) > Date.parse(parsed.updatedAt) ||
      Date.parse(parsed.updatedAt) > Date.parse(parsed.expiresAt)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeReservationAtomic(reservationPath, payload) {
  const tempPath = `${reservationPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    await fs.rename(tempPath, reservationPath);
    await fs.chmod(reservationPath, 0o600);
  } catch (err) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
}

async function withReservationLock(reservationPath, fn) {
  await fs.mkdir(path.dirname(reservationPath), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(reservationPath), 0o700).catch(() => {});
  const lockPath = `${reservationPath}.lock`;
  const ownerPath = path.join(lockPath, "owner.json");

  // A directory create is the transaction boundary: exactly one contender can
  // own the token-specific lock. Crash-persistent locks deliberately fail
  // closed and require operator inspection; automatic unlinking creates a
  // read/remove race where one process can delete a newer process's lock.
  try {
    await fs.mkdir(lockPath, { mode: 0o700 });
  } catch (err) {
    if (err?.code === "EEXIST") {
      return {
        ok: false,
        reason: "reservation_lock_present_manual_recovery_required",
        lockPath,
      };
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
    return await fn();
  } finally {
    // No second owner can replace this directory until it is removed, so
    // recursive cleanup cannot unlink a concurrently acquired successor.
    await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}

async function readReservation(reservationPath) {
  try {
    const raw = await fs.readFile(reservationPath, "utf8");
    return { exists: true, payload: parseReservation(raw) };
  } catch (err) {
    if (err?.code === "ENOENT") {
      return { exists: false, payload: null };
    }
    throw err;
  }
}

function readLastEnvValue(content, key) {
  let value = "";
  const pattern = new RegExp(`^[\\t ]*(?:export[\\t ]+)?${key}[\\t ]*=[\\t ]*(.*)$`);
  for (const line of content.split(/\r?\n/gu)) {
    const match = line.match(pattern);
    if (match) {
      value = match[1].trim().replace(/^(["'])(.*)\1$/u, "$2");
    }
  }
  return value;
}

async function clearExactReservationEnv(params) {
  const content = await fs.readFile(params.envLocalPath, "utf8");
  const expected = {
    TELEGRAM_BOT_TOKEN: params.token,
    OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID: params.scenarioId,
    OPENCLAW_TELEGRAM_TESTER_RESERVATION_GENERATION: params.generation,
    OPENCLAW_TELEGRAM_TESTER_TOKEN_HASH: hashToken(params.token),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (readLastEnvValue(content, key) !== value) {
      return { ok: false, reason: "env_owner_mismatch" };
    }
  }

  const clearedKeys = new Set([
    "TELEGRAM_BOT_TOKEN",
    "OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID",
    "OPENCLAW_TELEGRAM_TESTER_RESERVATION_GENERATION",
    "OPENCLAW_TELEGRAM_TESTER_TOKEN_HASH",
    "OPENCLAW_TELEGRAM_SAFE_REUSE_GENERATION",
    "OPENCLAW_TELEGRAM_SAFE_REUSE_TOKEN_HASH",
    "OPENCLAW_TELEGRAM_SAFE_REUSE_ACCOUNT_ID",
  ]);
  const lines = content.split(/\r?\n/gu);
  const kept = lines.filter((line) => {
    for (const key of clearedKeys) {
      if (new RegExp(`^[\\t ]*(?:export[\\t ]+)?${key}[\\t ]*=`).test(line)) {
        return false;
      }
    }
    return true;
  });
  const next = kept.join("\n").replace(/^\n+/u, "");
  const tempPath = `${params.envLocalPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, next, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await fs.rename(tempPath, params.envLocalPath);
    await fs.chmod(params.envLocalPath, 0o600);
  } catch (err) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
  return { ok: true };
}

async function clearLegacyTokenEnv(params) {
  const content = await fs.readFile(params.envLocalPath, "utf8");
  if (readLastEnvValue(content, "TELEGRAM_BOT_TOKEN") !== params.token) {
    return { ok: false, reason: "env_owner_mismatch" };
  }
  // A partial modern owner file is not a legacy assignment. Clearing it as
  // legacy state could orphan a durable reservation after an interrupted
  // migration or publication, so require all reservation credentials absent.
  for (const key of [
    "OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID",
    "OPENCLAW_TELEGRAM_TESTER_RESERVATION_GENERATION",
    "OPENCLAW_TELEGRAM_TESTER_TOKEN_HASH",
  ]) {
    if (readLastEnvValue(content, key)) {
      return { ok: false, reason: "legacy_env_has_reservation_metadata" };
    }
  }

  const clearedKeys = new Set([
    "TELEGRAM_BOT_TOKEN",
    "OPENCLAW_TELEGRAM_SAFE_REUSE_GENERATION",
    "OPENCLAW_TELEGRAM_SAFE_REUSE_TOKEN_HASH",
    "OPENCLAW_TELEGRAM_SAFE_REUSE_ACCOUNT_ID",
  ]);
  const kept = content.split(/\r?\n/gu).filter((line) => {
    for (const key of clearedKeys) {
      if (new RegExp(`^[\\t ]*(?:export[\\t ]+)?${key}[\\t ]*=`).test(line)) {
        return false;
      }
    }
    return true;
  });
  const next = kept.join("\n").replace(/^\n+/u, "");
  const tempPath = `${params.envLocalPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, next, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await fs.rename(tempPath, params.envLocalPath);
    await fs.chmod(params.envLocalPath, 0o600);
  } catch (err) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
  return { ok: true };
}

export async function acquireTelegramTesterScenarioReservation(params) {
  const token = normalizeOwnerString(params?.token, "token");
  const scenarioId = normalizeOwnerString(params?.scenarioId, "scenarioId");
  const worktreePath = await canonicalizeWorktree(params?.worktreePath);
  const nowMs = Number.isFinite(params?.nowMs) ? Number(params.nowMs) : Date.now();
  const ttlMs =
    Number.isFinite(params?.ttlMs) && Number(params.ttlMs) > 0
      ? Number(params.ttlMs)
      : DEFAULT_TTL_MS;
  const reservationPath = resolveTelegramTesterScenarioReservationPath({
    token,
    reservationRoot: params?.reservationRoot,
  });
  const tokenHash = hashToken(token);

  return withReservationLock(reservationPath, async () => {
    // Re-evaluate the PID lease after acquiring the reservation lock. A
    // snapshot from before the lock can miss a runtime that starts between
    // candidate selection and reservation creation.
    const pollingLeaseEvidence =
      typeof params?.hasActivePollingLease === "function"
        ? await params.hasActivePollingLease()
        : params?.hasActivePollingLease;
    const activePollingLeaseEntries = Array.isArray(pollingLeaseEvidence)
      ? pollingLeaseEvidence
      : [];
    const pollingLeaseStatusKnown =
      Array.isArray(pollingLeaseEvidence) || typeof pollingLeaseEvidence === "boolean";
    const hasActivePollingLease = Array.isArray(pollingLeaseEvidence)
      ? activePollingLeaseEntries.length > 0
      : Boolean(pollingLeaseEvidence);
    const current = await readReservation(reservationPath);
    if (current.exists && !current.payload) {
      // Unknown state is never evidence that a bot is free. An operator must
      // inspect/remove malformed state explicitly instead of silently
      // transferring a production-capable tester identity.
      return { ok: false, reason: "malformed_reservation", reservationPath };
    }

    const existing = current.payload;
    if (
      existing &&
      (existing.tokenHash !== tokenHash ||
        existing.tokenFingerprint !== fingerprintToken(token) ||
        existing.botId !== botIdFromToken(token))
    ) {
      return { ok: false, reason: "malformed_reservation", reservationPath };
    }

    const sameOwner =
      existing &&
      existing.scenarioId === scenarioId &&
      path.resolve(existing.worktreePath) === path.resolve(worktreePath);
    const everyActiveLeaseMatchesOwner =
      activePollingLeaseEntries.length > 0 &&
      activePollingLeaseEntries.every(
        (entry) =>
          typeof entry?.worktreePath === "string" &&
          path.resolve(entry.worktreePath) === path.resolve(worktreePath),
      );
    const expectedGeneration = String(params?.expectedGeneration ?? "").trim();
    const expectedTokenHash = String(params?.expectedTokenHash ?? "").trim();
    const expired = existing ? Date.parse(existing.expiresAt) <= nowMs : false;
    if (
      sameOwner &&
      params?.requireExpectedOwner === true &&
      (!expectedGeneration ||
        !/^[a-f0-9]{64}$/u.test(expectedTokenHash) ||
        existing.generation !== expectedGeneration ||
        tokenHash !== expectedTokenHash)
    ) {
      // The local owner file is the restart credential. Silently adopting the
      // global generation would let stale/copied metadata cross an ABA reuse
      // boundary and impersonate a newer scenario incarnation.
      return {
        ok: false,
        reason: "owner_generation_mismatch",
        reservationPath,
      };
    }
    if (sameOwner && expired && params?.requireExpectedOwner === true) {
      // Reclaim would publish a new global generation while the current local
      // owner file still authenticates the old one. An interruption between
      // those writes strands both. Make the transition explicit: canonical
      // release clears the exact old generation, then ensure creates a fresh
      // fenced reservation from unassigned state.
      return {
        ok: false,
        reason: "expired_owner_release_required",
        reservationPath,
      };
    }
    if (sameOwner && !expired && (!hasActivePollingLease || everyActiveLeaseMatchesOwner)) {
      // A running process in this exact scenario/worktree may call ensure
      // again. A live PID lease is compatible only when both the durable
      // reservation and the current lease registry prove the same worktree.
      const refreshed = {
        ...existing,
        updatedAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + ttlMs).toISOString(),
      };
      await writeReservationAtomic(reservationPath, refreshed);
      return {
        ok: true,
        action: "resumed",
        reason: "same_scenario_owner",
        generation: existing.generation,
        reservationPath,
        safeReuseRequired: false,
        safeReuseEnabled: existing.requiresSafeReuseFence !== false,
      };
    }
    if (hasActivePollingLease) {
      return {
        ok: false,
        reason:
          existing && Date.parse(existing.expiresAt) <= nowMs
            ? "expired_but_leased"
            : "leased_elsewhere",
        reservationPath,
      };
    }
    if (existing && !expired) {
      return {
        ok: false,
        reason: "reserved_elsewhere",
        reservationPath,
        owner: {
          scenarioId: existing.scenarioId,
          worktreePath: existing.worktreePath,
          generation: existing.generation,
          expiresAt: existing.expiresAt,
        },
      };
    }
    if (existing && !pollingLeaseStatusKnown) {
      // Expiry is only one half of the reclaim proof. A live polling lease
      // means the old runtime may still dispatch messages, so time alone can
      // never authorize a transfer.
      return {
        ok: false,
        reason: "expired_but_leased",
        reservationPath,
      };
    }

    const createdAt = new Date(nowMs).toISOString();
    const payload = {
      version: RESERVATION_VERSION,
      tokenHash,
      tokenFingerprint: fingerprintToken(token),
      botId: botIdFromToken(token),
      scenarioId,
      worktreePath,
      generation: crypto.randomUUID(),
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(nowMs + ttlMs).toISOString(),
      requiresSafeReuseFence: true,
    };
    await writeReservationAtomic(reservationPath, payload);
    return {
      ok: true,
      action: existing ? "reclaimed_expired" : "created",
      reason: existing ? "expired_without_polling_lease" : "unreserved",
      generation: payload.generation,
      reservationPath,
      safeReuseRequired: true,
      safeReuseEnabled: true,
    };
  });
}

export async function releaseLegacyTelegramTesterTokenAssignment(params) {
  const token = normalizeOwnerString(params?.token, "token");
  const envLocalPath = path.resolve(normalizeOwnerString(params?.envLocalPath, "envLocalPath"));
  const reservationPath = resolveTelegramTesterScenarioReservationPath({
    token,
    reservationRoot: params?.reservationRoot,
  });

  return withReservationLock(reservationPath, async () => {
    const current = await readReservation(reservationPath);
    // Legacy cleanup is authorized only by the exact local token claim and the
    // absence of durable reservation state. Any reservation, including
    // malformed state, belongs to the modern fail-closed recovery path.
    if (current.exists) {
      return {
        ok: false,
        reason: current.payload ? "reservation_present" : "malformed_reservation",
        reservationPath,
      };
    }
    const envResult = await clearLegacyTokenEnv({ envLocalPath, token });
    if (!envResult.ok) {
      return { ok: false, reason: envResult.reason, reservationPath };
    }
    return { ok: true, reason: "legacy_assignment_released", reservationPath };
  });
}

export async function releaseTelegramTesterScenarioReservation(params) {
  const token = normalizeOwnerString(params?.token, "token");
  const scenarioId = normalizeOwnerString(params?.scenarioId, "scenarioId");
  const worktreePath = await canonicalizeWorktree(params?.worktreePath);
  const generation = normalizeOwnerString(params?.generation, "generation");
  const reservationPath = resolveTelegramTesterScenarioReservationPath({
    token,
    reservationRoot: params?.reservationRoot,
  });

  return withReservationLock(reservationPath, async () => {
    const current = await readReservation(reservationPath);
    if (!current.exists) {
      if (params?.envLocalPath) {
        const envResult = await clearExactReservationEnv({
          envLocalPath: path.resolve(params.envLocalPath),
          token,
          scenarioId,
          generation,
        });
        if (!envResult.ok) {
          return { ok: false, reason: envResult.reason, reservationPath };
        }
      }
      return { ok: true, reason: "already_absent", reservationPath };
    }
    if (!current.payload) {
      return { ok: false, reason: "malformed_reservation", reservationPath };
    }
    const exactOwner =
      current.payload.tokenHash === hashToken(token) &&
      current.payload.scenarioId === scenarioId &&
      path.resolve(current.payload.worktreePath) === path.resolve(worktreePath) &&
      current.payload.generation === generation;
    if (!exactOwner) {
      return { ok: false, reason: "owner_mismatch", reservationPath };
    }

    if (params?.envLocalPath) {
      // Clear the local claim first while the global reservation lock is held.
      // A crash after this rename leaves an over-reserved bot (safe/manual
      // recovery), never an available bot whose stale env still looks owned.
      const envResult = await clearExactReservationEnv({
        envLocalPath: path.resolve(params.envLocalPath),
        token,
        scenarioId,
        generation,
      });
      if (!envResult.ok) {
        return { ok: false, reason: envResult.reason, reservationPath };
      }
    }
    await fs.rm(reservationPath);
    return { ok: true, reason: "released", reservationPath };
  });
}
