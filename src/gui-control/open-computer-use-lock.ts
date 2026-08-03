import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireFileLock } from "../infra/file-lock.js";

const LOCK_POLL_INTERVAL_MS = 25;

// One OpenClaw process can host multiple runtime instances (benchmarks and the
// embedded agent tool both do this). The file lock is deliberately re-entrant,
// so it cannot serialize unrelated async callers inside one process by itself.
// This queue closes that in-process hole before callers contend on disk.
const processQueues = new Map<string, Promise<void>>();

export class OpenComputerUseLockTimeoutError extends Error {
  override readonly name = "OpenComputerUseLockTimeoutError";
}

function remainingMs(deadlineMs: number): number {
  return Math.max(0, deadlineMs - Date.now());
}

async function waitUntil(promise: Promise<void>, deadlineMs: number): Promise<void> {
  const waitMs = remainingMs(deadlineMs);
  if (waitMs <= 0) {
    throw new OpenComputerUseLockTimeoutError(
      "Timed out waiting for exclusive OpenComputerUse access.",
    );
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new OpenComputerUseLockTimeoutError(
              "Timed out waiting for exclusive OpenComputerUse access.",
            ),
          );
        }, waitMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function canonicalCommand(command: string): Promise<string> {
  // App bundles are normally invoked by absolute executable path. realpath
  // makes symlinks to that same signed app converge on one ownership key while
  // preserving PATH shims as an explicit, stable fallback identity.
  if (command.includes(path.sep)) {
    const resolved = path.resolve(command);
    return await fs.realpath(resolved).catch(() => resolved);
  }
  return `PATH:${command}`;
}

export async function resolveOpenComputerUseLockTarget(command: string): Promise<string> {
  // Arguments select an OCU operation, not an app-agent identity. Callers that
  // reach the same executable with different arguments must still serialize
  // because they ultimately share that executable's app-scoped socket.
  const identity = await canonicalCommand(command);
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return path.join(os.tmpdir(), "openclaw-gui-control", `open-computer-use-${digest}`);
}

async function acquireProcessTurn(key: string, deadlineMs: number): Promise<() => void> {
  const previous = processQueues.get(key) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const currentGate = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const currentTail = previous.catch(() => undefined).then(() => currentGate);
  processQueues.set(key, currentTail);

  // A timed-out waiter must resolve only its own gate. Keeping currentTail
  // chained behind the live predecessor prevents a later caller from skipping
  // the queue while the original owner is still running.
  try {
    await waitUntil(
      previous.catch(() => undefined),
      deadlineMs,
    );
  } catch (error) {
    releaseCurrent();
    void currentTail.finally(() => {
      if (processQueues.get(key) === currentTail) {
        processQueues.delete(key);
      }
    });
    throw error;
  }

  return () => {
    releaseCurrent();
    void currentTail.finally(() => {
      if (processQueues.get(key) === currentTail) {
        processQueues.delete(key);
      }
    });
  };
}

/**
 * Serialize one OpenComputerUse CLI transaction across OpenClaw processes.
 *
 * The pinned OCU app owns socket health, app identity, verified-stale-agent
 * termination, and app launch. OpenClaw owns the missing outer invariant: only
 * one of its callers may enter OCU's connect-or-launch path for a given app at
 * a time. Holding this lock for the complete CLI transaction is intentionally
 * conservative; concurrent desktop mutations are not safe merely because the
 * app agent can accept multiple socket clients.
 */
export async function withOpenComputerUseLock<T>(input: {
  command: string;
  timeoutMs: number;
  run: (remainingTimeoutMs: number) => Promise<T>;
}): Promise<T> {
  const startedAtMs = Date.now();
  const deadlineMs = startedAtMs + input.timeoutMs;
  const lockTarget = await resolveOpenComputerUseLockTarget(input.command);
  const releaseProcessTurn = await acquireProcessTurn(lockTarget, deadlineMs);

  try {
    const lockWaitMs = remainingMs(deadlineMs);
    if (lockWaitMs <= 0) {
      throw new OpenComputerUseLockTimeoutError(
        `Timed out waiting ${input.timeoutMs}ms for exclusive OpenComputerUse access.`,
      );
    }

    // The shared file-lock primitive immediately reclaims a lock whose owner
    // PID is dead. Disable age-only stealing here because another OpenClaw
    // caller may have a longer configured command timeout; age alone must never
    // let a short-timeout caller remove that live owner's lock.
    const fileLock = await acquireFileLock(lockTarget, {
      retries: {
        retries: Math.max(0, Math.ceil(lockWaitMs / LOCK_POLL_INTERVAL_MS) - 1),
        factor: 1,
        minTimeout: LOCK_POLL_INTERVAL_MS,
        maxTimeout: LOCK_POLL_INTERVAL_MS,
      },
      stale: Number.MAX_SAFE_INTEGER,
    }).catch((error: unknown) => {
      if (error instanceof Error && error.message.startsWith("file lock timeout for ")) {
        throw new OpenComputerUseLockTimeoutError(
          `Timed out waiting ${input.timeoutMs}ms for exclusive OpenComputerUse access.`,
          { cause: error },
        );
      }
      throw error;
    });

    try {
      const executionMs = remainingMs(deadlineMs);
      if (executionMs <= 0) {
        throw new OpenComputerUseLockTimeoutError(
          `Timed out waiting ${input.timeoutMs}ms for exclusive OpenComputerUse access.`,
        );
      }
      return await input.run(executionMs);
    } finally {
      await fileLock.release();
    }
  } finally {
    releaseProcessTurn();
  }
}
