import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getProcessStartTime, isPidAlive } from "../shared/pid-alive.js";

const LOCK_POLL_INTERVAL_MS = 25;
const LOCK_HANDOFF_GRACE_MS = 1_000;
const OWNER_START_REFRESH_MS = 500;

export class OpenComputerUseLockTimeoutError extends Error {
  override readonly name = "OpenComputerUseLockTimeoutError";
}

type LockPayload = {
  command: string;
  createdAt: string;
  identity: string;
  orderKey: string;
  pid: number;
  phase: "acquired" | "waiting";
  processStartIdentity?: string;
  token: string;
  version: 2;
};

type OwnerState =
  | "dead"
  | "invalid"
  | "live"
  | "live-unverified"
  | "missing"
  | "orphaned"
  | "pid-reused";

type LockOwnerSnapshot = {
  alive?: boolean;
  ageMs?: number;
  auxiliaryPaths?: string[];
  command?: string;
  identity?: string;
  path?: string;
  phase?: "acquired" | "waiting";
  pid?: number;
  processStartIdentity?: string;
  state: OwnerState;
  token?: string;
  orderKey?: string;
};

type LockTransition = {
  elapsedMs: number;
  owner: LockOwnerSnapshot;
  phase: "acquired" | "legacy-observed" | "observed" | "reclaimed" | "released";
};

type ProcessIdentityCacheEntry = {
  checkedAtMs: number;
  identity: string | undefined;
};

const processIdentityCache = new Map<number, ProcessIdentityCacheEntry>();

async function canonicalCommand(command: string): Promise<string> {
  // App bundles are normally invoked by absolute executable path. realpath
  // makes symlinks to the same binary converge while PATH shims retain an
  // explicit stable identity in diagnostics.
  if (command.includes(path.sep)) {
    const resolved = path.resolve(command);
    return await fs.realpath(resolved).catch(() => resolved);
  }
  return `PATH:${command}`;
}

function readProcessStartIdentity(pid: number, nowMs: number): string | undefined {
  const cached = processIdentityCache.get(pid);
  if (cached && nowMs - cached.checkedAtMs < OWNER_START_REFRESH_MS) {
    return cached.identity;
  }

  const linuxStartTime = getProcessStartTime(pid);
  let identity = linuxStartTime === null ? undefined : `linux:${linuxStartTime}`;
  if (!identity && process.platform === "darwin") {
    // macOS does not expose /proc start ticks. `lstart` binds a PID to its
    // process generation; a failed/ambiguous lookup remains fail-closed.
    const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 1_000,
    });
    const value = result.status === 0 ? result.stdout.trim() : "";
    identity = value ? `darwin:${value}` : undefined;
  }
  processIdentityCache.set(pid, { checkedAtMs: nowMs, identity });
  return identity;
}

async function readOwner(ownerPath: string, nowMs: number): Promise<LockOwnerSnapshot> {
  try {
    const [raw, stat] = await Promise.all([fs.readFile(ownerPath, "utf8"), fs.stat(ownerPath)]);
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (
      parsed.version !== 2 ||
      typeof parsed.pid !== "number" ||
      typeof parsed.token !== "string" ||
      typeof parsed.identity !== "string" ||
      typeof parsed.command !== "string" ||
      typeof parsed.orderKey !== "string" ||
      typeof parsed.createdAt !== "string" ||
      (parsed.phase !== "waiting" && parsed.phase !== "acquired")
    ) {
      return { state: "invalid", path: ownerPath, ageMs: Math.max(0, nowMs - stat.mtimeMs) };
    }

    const alive = isPidAlive(parsed.pid);
    const currentStartIdentity = alive ? readProcessStartIdentity(parsed.pid, nowMs) : undefined;
    const state: OwnerState = !alive
      ? "dead"
      : !parsed.processStartIdentity || !currentStartIdentity
        ? "live-unverified"
        : parsed.processStartIdentity === currentStartIdentity
          ? "live"
          : "pid-reused";
    const createdAtMs = Date.parse(parsed.createdAt);
    return {
      state,
      alive,
      pid: parsed.pid,
      token: parsed.token,
      identity: parsed.identity,
      command: parsed.command,
      processStartIdentity: parsed.processStartIdentity,
      path: ownerPath,
      phase: parsed.phase,
      orderKey: parsed.orderKey,
      ageMs: Number.isFinite(createdAtMs) ? Math.max(0, nowMs - createdAtMs) : undefined,
    };
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return { state: "missing", path: ownerPath };
    }
    return { state: "invalid", path: ownerPath };
  }
}

async function readLegacyOwner(lockPath: string, nowMs: number): Promise<LockOwnerSnapshot> {
  try {
    const stat = await fs.lstat(lockPath);
    if (stat.isDirectory()) {
      const names = await fs.readdir(lockPath);
      if (names.length === 0) {
        return { state: "orphaned", path: lockPath, ageMs: Math.max(0, nowMs - stat.mtimeMs) };
      }
      const markerName = names.find((name) => /^owner-[0-9a-f-]+\.json$/.test(name));
      const acquiredCandidateName = markerName ? `${markerName}.acquired` : undefined;
      const recognizedNames = new Set(
        [markerName, acquiredCandidateName].filter((name): name is string => Boolean(name)),
      );
      if (!markerName || names.some((name) => !recognizedNames.has(name))) {
        return { state: "invalid", path: lockPath, ageMs: Math.max(0, nowMs - stat.mtimeMs) };
      }
      const markerPath = path.join(lockPath, markerName);
      const owner = await readOwner(markerPath, nowMs);
      return {
        ...owner,
        ...(acquiredCandidateName && names.includes(acquiredCandidateName)
          ? { auxiliaryPaths: [path.join(lockPath, acquiredCandidateName)] }
          : {}),
      };
    }

    // A file belongs to v1. It has no token-bound shared-path mutation, so it
    // always fails closed and is never removed, regardless of liveness.
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (typeof parsed.pid !== "number" || typeof parsed.createdAt !== "string") {
      return { state: "invalid", path: lockPath, ageMs: Math.max(0, nowMs - stat.mtimeMs) };
    }
    const alive = isPidAlive(parsed.pid);
    return {
      state: alive ? "live-unverified" : "dead",
      alive,
      pid: parsed.pid,
      path: lockPath,
      ageMs: Math.max(0, nowMs - Date.parse(parsed.createdAt)),
    };
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return { state: "missing", path: lockPath };
    }
    return { state: "invalid", path: lockPath };
  }
}

async function removeOwnedLegacySentinel(input: {
  legacyPath: string;
  markerPath: string;
  pid: number;
  token: string;
}): Promise<void> {
  const marker = await readOwner(input.markerPath, Date.now());
  if (marker.state === "missing") {
    const names = await fs.readdir(input.legacyPath);
    if (names.length !== 0) {
      throw new Error(
        `OpenComputerUse legacy sentinel contains unexpected owners: ${names.join(",")}`,
      );
    }
    await fs.rmdir(input.legacyPath);
    return;
  }
  if (marker.token !== input.token || marker.pid !== input.pid) {
    throw new Error(
      `OpenComputerUse legacy sentinel ownership changed before cleanup: lockPath=${input.legacyPath} ownerPid=${marker.pid ?? "none"}`,
    );
  }
  // The directory continues blocking v1 open("wx") callers while its exact
  // token marker is removed. rmdir then exposes the namespace atomically.
  await fs.rm(input.markerPath);
  await fs.rmdir(input.legacyPath);
}

function formatLockTimeout(input: {
  command: string;
  identity: string;
  lockPath: string;
  owner: LockOwnerSnapshot;
  transitions: LockTransition[];
  waitBudgetMs: number;
  waitElapsedMs: number;
}): string {
  return [
    `Timed out waiting ${input.waitBudgetMs}ms for exclusive OpenComputerUse access.`,
    `lockPath=${input.lockPath}`,
    `command=${JSON.stringify(input.command)}`,
    `socketIdentity=${JSON.stringify(input.identity)}`,
    `ownerPid=${input.owner.pid ?? "none"}`,
    `ownerIdentity=${JSON.stringify(input.owner.identity ?? "unknown")}`,
    `ownerCommand=${JSON.stringify(input.owner.command ?? "unknown")}`,
    `ownerAlive=${input.owner.alive === undefined ? "unknown" : input.owner.alive}`,
    `ownerState=${input.owner.state}`,
    `ownerStartIdentity=${JSON.stringify(input.owner.processStartIdentity ?? "unavailable")}`,
    `waitElapsedMs=${input.waitElapsedMs}`,
    `waitBudgetMs=${input.waitBudgetMs}`,
    `transitions=${JSON.stringify(input.transitions)}`,
  ].join(" ");
}

export async function resolveOpenComputerUseLockTarget(
  command: string,
  socketIdentity?: string,
): Promise<string> {
  const identity = socketIdentity?.trim() || (await canonicalCommand(command));
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return path.join(os.tmpdir(), "openclaw-gui-control", `open-computer-use-${digest}`);
}

function compareOwners(left: LockOwnerSnapshot, right: LockOwnerSnapshot): number {
  if (left.phase === "acquired" && right.phase !== "acquired") {
    return -1;
  }
  if (right.phase === "acquired" && left.phase !== "acquired") {
    return 1;
  }
  const order = (left.orderKey ?? "").localeCompare(right.orderKey ?? "");
  return order || (left.path ?? "").localeCompare(right.path ?? "");
}

async function acquireCrossProcessLock(input: {
  command: string;
  executionTimeoutMs: number;
  explicitLockTimeoutMs?: number;
  identity: string;
  lockTarget: string;
  startedAtMs: number;
}): Promise<{ release: () => Promise<void> }> {
  const token = randomUUID();
  const queuePath = `${input.lockTarget}.queue`;
  const legacyPath = `${input.lockTarget}.lock`;
  // hrtime is a host-wide monotonic clock on supported Node platforms. Unlike
  // Date.now(), it preserves publication order for contenders born within the
  // same wall-clock millisecond.
  const orderKey = process.hrtime.bigint().toString().padStart(20, "0");
  const ownerPath = path.join(queuePath, `${orderKey}-${process.pid}-${token}.json`);
  const candidatePath = `${ownerPath}.candidate`;
  const acquiredCandidatePath = `${ownerPath}.acquired`;
  const legacyCandidatePath = `${legacyPath}.${token}.candidate`;
  const legacyMarkerName = `owner-${token}.json`;
  const legacyCandidateMarkerPath = path.join(legacyCandidatePath, legacyMarkerName);
  const legacyMarkerPath = path.join(legacyPath, legacyMarkerName);
  const legacyAcquiredCandidatePath = `${legacyMarkerPath}.acquired`;
  let ownsLegacySentinel = false;
  const processStartIdentity = readProcessStartIdentity(process.pid, Date.now());
  const payload: LockPayload = {
    version: 2,
    pid: process.pid,
    token,
    identity: input.identity,
    orderKey,
    command: input.command,
    createdAt: new Date().toISOString(),
    phase: "waiting",
    ...(processStartIdentity ? { processStartIdentity } : {}),
  };
  const transitions: LockTransition[] = [];
  const predecessorKeys = new Set<string>();
  const selfOwner: LockOwnerSnapshot = {
    state: "live",
    path: ownerPath,
    phase: "waiting",
    orderKey,
    pid: process.pid,
    token,
  };
  const notePredecessor = (owner: LockOwnerSnapshot) => {
    if (owner.path === ownerPath || owner.state === "missing") {
      return;
    }
    predecessorKeys.add(owner.token ?? owner.path ?? `pid:${owner.pid ?? "unknown"}`);
  };
  const waitBudgetMs = () =>
    input.explicitLockTimeoutMs ??
    (predecessorKeys.size + 1) * input.executionTimeoutMs + LOCK_HANDOFF_GRACE_MS;
  let lastTransitionKey = "";
  const record = (phase: LockTransition["phase"], owner: LockOwnerSnapshot) => {
    const key = `${phase}:${owner.path}:${owner.state}:${owner.pid}:${owner.token}`;
    if (key === lastTransitionKey) {
      return;
    }
    lastTransitionKey = key;
    transitions.push({ elapsedMs: Date.now() - input.startedAtMs, phase, owner });
  };

  await fs.mkdir(queuePath, { recursive: true });
  try {
    // Publish a complete contender atomically. Every contender has a unique,
    // token-bound path, so stale cleanup can never name or unlink a successor.
    // Keep the whole sequence inside the cleanup scope: once link() publishes
    // ownerPath, any later setup failure must remove that live-looking record.
    await fs.writeFile(candidatePath, JSON.stringify(payload), { flag: "wx", mode: 0o600 });
    await fs.link(candidatePath, ownerPath);
    await fs.rm(candidatePath);
    // Let already-racing contenders publish before ordering the initial queue.
    // A genuinely later contender will instead observe this contender's
    // `acquired` phase and can never outrank the incumbent.
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_INTERVAL_MS));

    while (true) {
      const nowMs = Date.now();
      const legacyOwner = await readLegacyOwner(legacyPath, nowMs);
      const reclaimableV2Directory =
        (legacyOwner.state === "dead" || legacyOwner.state === "pid-reused") &&
        legacyOwner.path !== undefined &&
        path.dirname(legacyOwner.path) === legacyPath;
      if (reclaimableV2Directory) {
        // Multiple successors can observe the same dead marker. Every mutation
        // is idempotent for expected loser races; ENOTEMPTY means another
        // contender or an unexpected entry still owns the directory.
        for (const auxiliaryPath of legacyOwner.auxiliaryPaths ?? []) {
          await fs.rm(auxiliaryPath, { force: true });
        }
        await fs.rm(legacyOwner.path as string, { force: true });
        try {
          await fs.rmdir(legacyPath);
          record("reclaimed", legacyOwner);
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code !== "ENOENT" && code !== "ENOTEMPTY") {
            throw error;
          }
        }
        continue;
      }
      if (legacyOwner.state === "orphaned") {
        // An empty directory can only be a partially cleaned v2 sentinel. It
        // still excludes v1 callers while rmdir completes.
        try {
          await fs.rmdir(legacyPath);
          record("reclaimed", legacyOwner);
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code !== "ENOENT" && code !== "ENOTEMPTY") {
            throw error;
          }
        }
        continue;
      }
      if (legacyOwner.state !== "missing") {
        // Never reclaim a shared legacy pathname. Dead and invalid v1 records
        // also fail closed because an old caller could replace that pathname
        // between inspection and removal.
        record("legacy-observed", legacyOwner);
        notePredecessor(legacyOwner);
      } else {
        const names = (await fs.readdir(queuePath)).filter((name) => name.endsWith(".json"));
        const owners: LockOwnerSnapshot[] = [];
        for (const name of names) {
          const contenderPath = path.join(queuePath, name);
          const owner = await readOwner(contenderPath, nowMs);
          if (owner.state === "dead" || owner.state === "pid-reused") {
            // This path embeds the observed token and is never reused. Removing
            // it cannot affect a live successor, unlike a shared lock pathname.
            await fs.rm(contenderPath, { force: true });
            record("reclaimed", owner);
            continue;
          }
          if (owner.state !== "missing") {
            owners.push(owner);
          }
        }
        owners.sort(compareOwners);
        for (const contender of owners) {
          if (compareOwners(contender, selfOwner) < 0) {
            notePredecessor(contender);
          }
        }
        const owner = owners[0] ?? { state: "missing" as const };
        if (owner.path === ownerPath) {
          try {
            // Publish a complete, non-empty directory atomically. v1 open("wx")
            // treats it as occupied, while v2 can later reclaim only its unique
            // token marker and then rmdir the still-exclusive namespace.
            await fs.mkdir(legacyCandidatePath, { mode: 0o700 });
            await fs.writeFile(legacyCandidateMarkerPath, JSON.stringify(payload), {
              flag: "wx",
              mode: 0o600,
            });
            await fs.rename(legacyCandidatePath, legacyPath);
            ownsLegacySentinel = true;
          } catch (error) {
            await fs.rm(legacyCandidatePath, { recursive: true, force: true });
            if (await fs.stat(legacyPath).catch(() => undefined)) {
              record("legacy-observed", await readLegacyOwner(legacyPath, Date.now()));
              await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_INTERVAL_MS));
              continue;
            }
            throw error;
          }
          payload.phase = "acquired";
          await fs.writeFile(legacyAcquiredCandidatePath, JSON.stringify(payload), {
            flag: "wx",
            mode: 0o600,
          });
          await fs.rename(legacyAcquiredCandidatePath, legacyMarkerPath);
          await fs.writeFile(acquiredCandidatePath, JSON.stringify(payload), {
            flag: "wx",
            mode: 0o600,
          });
          await fs.rename(acquiredCandidatePath, ownerPath);
          record("acquired", owner);
          return {
            release: async () => {
              const current = await readOwner(ownerPath, Date.now());
              if (current.token !== token || current.pid !== process.pid) {
                throw new Error(
                  `OpenComputerUse lock ownership changed before release: lockPath=${ownerPath} ownerPid=${current.pid ?? "none"}`,
                );
              }
              // Each cleanup is retried once. A transient partial failure must
              // not leave a live same-PID queue record that blocks this process.
              try {
                await fs.rm(ownerPath, { force: true });
              } catch {
                await fs.rm(ownerPath, { force: true });
              }
              const removeLegacySentinel = async () =>
                await removeOwnedLegacySentinel({
                  legacyPath,
                  markerPath: legacyMarkerPath,
                  pid: process.pid,
                  token,
                });
              try {
                await removeLegacySentinel();
              } catch (error) {
                if ((error as { code?: string }).code !== "ENOENT") {
                  // Retry only a failed cleanup. An unconditional second pass can
                  // race a successor that has already published its own sentinel.
                  await removeLegacySentinel().catch(async (retryError: unknown) => {
                    if ((retryError as { code?: string }).code !== "ENOENT") {
                      throw retryError;
                    }
                  });
                }
              }
              record("released", { state: "missing", path: ownerPath });
            },
          };
        }
        record("observed", owner);
      }

      const currentWaitBudgetMs = waitBudgetMs();
      if (nowMs >= input.startedAtMs + currentWaitBudgetMs) {
        const legacyOwner = await readLegacyOwner(legacyPath, nowMs);
        const queueOwners = await Promise.all(
          (await fs.readdir(queuePath))
            .filter((name) => name.endsWith(".json") && path.join(queuePath, name) !== ownerPath)
            .map((name) => readOwner(path.join(queuePath, name), nowMs)),
        );
        queueOwners.sort(compareOwners);
        const finalOwner =
          legacyOwner.state !== "missing"
            ? legacyOwner
            : (queueOwners.find((owner) => owner.state !== "missing") ?? {
                state: "missing" as const,
              });
        throw new OpenComputerUseLockTimeoutError(
          formatLockTimeout({
            command: input.command,
            identity: input.identity,
            lockPath: queuePath,
            owner: finalOwner,
            transitions,
            waitElapsedMs: nowMs - input.startedAtMs,
            waitBudgetMs: currentWaitBudgetMs,
          }),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_INTERVAL_MS));
    }
  } catch (error) {
    await fs.rm(ownerPath, { force: true }).catch(() => undefined);
    if (ownsLegacySentinel) {
      await fs.rm(legacyAcquiredCandidatePath, { force: true }).catch(() => undefined);
      await removeOwnedLegacySentinel({
        legacyPath,
        markerPath: legacyMarkerPath,
        pid: process.pid,
        token,
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    await fs.rm(candidatePath, { force: true }).catch(() => undefined);
    await fs.rm(acquiredCandidatePath, { force: true }).catch(() => undefined);
    await fs.rm(legacyAcquiredCandidatePath, { force: true }).catch(() => undefined);
    await fs.rm(legacyCandidatePath, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Serialize one complete OCU transaction by its resolved app-agent socket. */
export async function withOpenComputerUseLock<T>(input: {
  command: string;
  lockTimeoutMs?: number;
  run: (executionTimeoutMs: number) => Promise<T>;
  socketIdentity?: string;
  timeoutMs: number;
}): Promise<T> {
  const startedAtMs = Date.now();
  const command = await canonicalCommand(input.command);
  const identity = input.socketIdentity?.trim() || command;
  const lockTarget = await resolveOpenComputerUseLockTarget(command, identity);
  // Queue wait and OCU execution are separately bounded. A caller that waits
  // behind one maximum-duration owner still receives its full command budget.
  const lock = await acquireCrossProcessLock({
    command,
    executionTimeoutMs: input.timeoutMs,
    explicitLockTimeoutMs: input.lockTimeoutMs,
    identity,
    lockTarget,
    startedAtMs,
  });
  try {
    return await input.run(input.timeoutMs);
  } finally {
    await lock.release();
  }
}
