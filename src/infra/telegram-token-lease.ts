import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getProcessStartTime, isPidAlive } from "../shared/pid-alive.js";
import { resolveProcessScopedMap } from "../shared/process-scoped-map.js";

type TelegramTokenLeasePayload = {
  version: 1;
  pid: number;
  starttime: number | null;
  createdAt: string;
  tokenHash: string;
  tokenFingerprint: string;
  botId: string | null;
  accountId: string | null;
  configPath: string | null;
  worktree: string | null;
};

type HeldLease = {
  count: number;
  leasePath: string;
  payload: TelegramTokenLeasePayload;
  releasePromise?: Promise<void>;
};

export type TelegramTokenLeaseOwner = {
  pid: number | null;
  starttime: number | null;
  createdAt: string | null;
  tokenFingerprint: string | null;
  botId: string | null;
  accountId: string | null;
  configPath: string | null;
  worktree: string | null;
};

export type TelegramTokenLease = {
  leasePath: string;
  owner: TelegramTokenLeaseOwner;
  release: () => Promise<void>;
};

export class TelegramTokenLeaseConflictError extends Error {
  readonly leasePath: string;
  readonly owner: TelegramTokenLeaseOwner;

  constructor(params: { leasePath: string; owner: TelegramTokenLeaseOwner }) {
    const ownerBits = [
      params.owner.botId ? `bot=${params.owner.botId}` : null,
      params.owner.accountId ? `account=${params.owner.accountId}` : null,
      params.owner.pid != null ? `pid=${params.owner.pid}` : null,
      params.owner.worktree ? `worktree=${params.owner.worktree}` : null,
      params.owner.configPath ? `config=${params.owner.configPath}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    super(
      `Telegram bot token lease already owned by another runtime${ownerBits ? ` (${ownerBits})` : ""}.`,
    );
    this.name = "TelegramTokenLeaseConflictError";
    this.leasePath = params.leasePath;
    this.owner = params.owner;
  }
}

const HELD_LEASES_KEY = Symbol.for("openclaw.telegramTokenLeases");
const REGISTERED_EXIT_CLEANUP_KEY = Symbol.for("openclaw.telegramTokenLeases.cleanup");
const HELD_LEASES = resolveProcessScopedMap<HeldLease>(HELD_LEASES_KEY);

function maskTelegramTokenFingerprint(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 12);
}

function hashTelegramToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function parseBotId(token: string): string | null {
  const prefix = token.split(":", 1)[0]?.trim() ?? "";
  return /^[0-9]+$/.test(prefix) ? prefix : null;
}

function resolveLeaseRoot(customRoot?: string): string {
  if (customRoot?.trim()) {
    return path.resolve(customRoot.trim());
  }
  return path.join(os.homedir(), ".openclaw", "telegram-token-leases");
}

function buildLeasePath(params: { token: string; leaseRoot?: string }): string {
  const tokenHash = hashTelegramToken(params.token);
  const botId = parseBotId(params.token) ?? "bot";
  return path.join(resolveLeaseRoot(params.leaseRoot), `${botId}-${tokenHash}.json`);
}

function parsePayload(raw: string): TelegramTokenLeasePayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<TelegramTokenLeasePayload>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const pid =
      typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0
        ? parsed.pid
        : null;
    if (parsed.version !== 1 || pid === null) {
      return null;
    }
    return {
      version: 1,
      pid,
      starttime: typeof parsed.starttime === "number" ? parsed.starttime : null,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
      tokenHash: typeof parsed.tokenHash === "string" ? parsed.tokenHash : "",
      tokenFingerprint: typeof parsed.tokenFingerprint === "string" ? parsed.tokenFingerprint : "",
      botId: typeof parsed.botId === "string" ? parsed.botId : null,
      accountId: typeof parsed.accountId === "string" ? parsed.accountId : null,
      configPath: typeof parsed.configPath === "string" ? parsed.configPath : null,
      worktree: typeof parsed.worktree === "string" ? parsed.worktree : null,
    };
  } catch {
    return null;
  }
}

function toOwner(payload: TelegramTokenLeasePayload | null): TelegramTokenLeaseOwner {
  return {
    pid: payload?.pid ?? null,
    starttime: payload?.starttime ?? null,
    createdAt: payload?.createdAt || null,
    tokenFingerprint: payload?.tokenFingerprint || null,
    botId: payload?.botId ?? null,
    accountId: payload?.accountId ?? null,
    configPath: payload?.configPath ?? null,
    worktree: payload?.worktree ?? null,
  };
}

function isSameOwner(params: {
  currentPid: number;
  currentStarttime: number | null;
  payload: TelegramTokenLeasePayload;
}): boolean {
  if (params.payload.pid !== params.currentPid) {
    return false;
  }
  if (
    params.currentStarttime !== null &&
    params.payload.starttime !== null &&
    params.payload.starttime !== params.currentStarttime
  ) {
    return false;
  }
  return true;
}

function isActiveOwner(payload: TelegramTokenLeasePayload): boolean {
  if (!isPidAlive(payload.pid)) {
    return false;
  }
  if (payload.starttime === null) {
    return true;
  }
  const activeStarttime = getProcessStartTime(payload.pid);
  if (activeStarttime === null) {
    return true;
  }
  return activeStarttime === payload.starttime;
}

function registerExitCleanupOnce() {
  const proc = process as NodeJS.Process & {
    [REGISTERED_EXIT_CLEANUP_KEY]?: boolean;
  };
  if (proc[REGISTERED_EXIT_CLEANUP_KEY]) {
    return;
  }
  proc[REGISTERED_EXIT_CLEANUP_KEY] = true;

  const releaseSync = () => {
    for (const [, held] of HELD_LEASES) {
      try {
        fsSync.rmSync(held.leasePath, { force: true });
      } catch {
        // Best effort cleanup on process exit.
      }
    }
    HELD_LEASES.clear();
  };

  process.on("exit", releaseSync);
  for (const signal of ["SIGINT", "SIGTERM", "SIGQUIT", "SIGABRT"] as const) {
    process.on(signal, () => {
      releaseSync();
      process.exit(128);
    });
  }
}

async function releaseHeldLease(leasePath: string, held: HeldLease): Promise<void> {
  const current = HELD_LEASES.get(leasePath);
  if (current !== held) {
    return;
  }
  held.count -= 1;
  if (held.count > 0) {
    return;
  }
  if (held.releasePromise) {
    await held.releasePromise;
    return;
  }
  HELD_LEASES.delete(leasePath);
  held.releasePromise = (async () => {
    try {
      const raw = await fs.readFile(held.leasePath, "utf8");
      const payload = parsePayload(raw);
      if (
        payload &&
        isSameOwner({
          currentPid: held.payload.pid,
          currentStarttime: held.payload.starttime,
          payload,
        })
      ) {
        await fs.rm(held.leasePath, { force: true });
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        throw err;
      }
    }
  })();
  await held.releasePromise;
}

export async function acquireTelegramTokenLease(params: {
  token: string;
  accountId?: string | null;
  configPath?: string | null;
  worktree?: string | null;
  leaseRoot?: string;
}): Promise<TelegramTokenLease> {
  const token = params.token.trim();
  if (!token) {
    throw new Error("Telegram bot token required for lease acquisition.");
  }

  registerExitCleanupOnce();

  const leasePath = buildLeasePath({ token, leaseRoot: params.leaseRoot });
  const currentPid = process.pid;
  const currentStarttime = getProcessStartTime(currentPid);
  const payload: TelegramTokenLeasePayload = {
    version: 1,
    pid: currentPid,
    starttime: currentStarttime,
    createdAt: new Date().toISOString(),
    tokenHash: hashTelegramToken(token),
    tokenFingerprint: maskTelegramTokenFingerprint(token),
    botId: parseBotId(token),
    accountId: params.accountId?.trim() || null,
    configPath: params.configPath?.trim() || process.env.OPENCLAW_CONFIG_PATH?.trim() || null,
    worktree: params.worktree?.trim() || process.cwd(),
  };

  const held = HELD_LEASES.get(leasePath);
  if (held) {
    held.count += 1;
    return {
      leasePath,
      owner: toOwner(held.payload),
      release: async () => await releaseHeldLease(leasePath, held),
    };
  }

  await fs.mkdir(path.dirname(leasePath), { recursive: true });

  for (;;) {
    try {
      const handle = await fs.open(leasePath, "wx");
      try {
        await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      const nextHeld: HeldLease = {
        count: 1,
        leasePath,
        payload,
      };
      HELD_LEASES.set(leasePath, nextHeld);
      return {
        leasePath,
        owner: toOwner(payload),
        release: async () => await releaseHeldLease(leasePath, nextHeld),
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") {
        throw err;
      }

      let existingRaw = "";
      try {
        existingRaw = await fs.readFile(leasePath, "utf8");
      } catch (readErr) {
        const readCode = (readErr as NodeJS.ErrnoException)?.code;
        if (readCode === "ENOENT") {
          continue;
        }
        throw readErr;
      }
      const existingPayload = parsePayload(existingRaw);
      if (!existingPayload || !isActiveOwner(existingPayload)) {
        try {
          await fs.rm(leasePath, { force: true });
          continue;
        } catch (removeErr) {
          const removeCode = (removeErr as NodeJS.ErrnoException)?.code;
          if (removeCode === "ENOENT") {
            continue;
          }
          throw removeErr;
        }
      }
      if (
        isSameOwner({
          currentPid,
          currentStarttime,
          payload: existingPayload,
        })
      ) {
        const nextHeld: HeldLease = {
          count: 1,
          leasePath,
          payload: existingPayload,
        };
        HELD_LEASES.set(leasePath, nextHeld);
        return {
          leasePath,
          owner: toOwner(existingPayload),
          release: async () => await releaseHeldLease(leasePath, nextHeld),
        };
      }
      throw new TelegramTokenLeaseConflictError({
        leasePath,
        owner: toOwner(existingPayload),
      });
    }
  }
}
