import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveStateDir } from "../config/paths.js";
import { createAsyncLock, writeJsonAtomic } from "./json-files.js";
import { generateSecureUuid } from "./secure-random.js";

export type RestartSentinelLog = {
  stdoutTail?: string | null;
  stderrTail?: string | null;
  exitCode?: number | null;
};

export type RestartSentinelStep = {
  name: string;
  command: string;
  cwd?: string | null;
  durationMs?: number | null;
  log?: RestartSentinelLog | null;
};

export type RestartSentinelStats = {
  mode?: string;
  root?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  steps?: RestartSentinelStep[];
  reason?: string | null;
  phase?: "requested" | "verified";
  verified?: boolean;
  durationMs?: number | null;
};

export type RestartSentinelPayload = {
  kind: "config-apply" | "config-patch" | "update" | "restart";
  status: "requested" | "ok" | "error" | "skipped";
  ts: number;
  sessionKey?: string;
  /** Delivery context captured at restart time to ensure channel routing survives restart. */
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
  };
  /** Thread ID for reply threading (e.g., Slack thread_ts). */
  threadId?: string;
  message?: string | null;
  doctorHint?: string | null;
  stats?: RestartSentinelStats | null;
};

export type RestartSentinel = {
  version: 1;
  payload: RestartSentinelPayload;
  operation?: RestartOperationRecord;
};

export type RestartOperationDeliveryState = "pending" | "delivering" | "delivered" | "skipped";

export type RestartOperationRecord = {
  id: string;
  sessionKey?: string;
  channel?: string;
  to?: string;
  accountId?: string;
  topicId?: string;
  reason?: string;
  note?: string;
  requestedAt: number;
  expiresAt: number;
  recovery: {
    state: "waiting" | "ok" | "error";
    observedAt?: number;
    error?: string;
  };
  delivery: {
    receipt: RestartOperationDeliveryState;
    continuation: RestartOperationDeliveryState;
    updatedAt: number;
    lastError?: string;
  };
};

const SENTINEL_FILENAME = "restart-sentinel.json";
const RESTART_OPERATION_TTL_MS = 10 * 60 * 1000;
const WATCHER_POLL_PID_DEATH_MS = 100;
const WATCHER_POLL_TTL_MS = 250;
const withRestartSentinelLock = createAsyncLock();

function isRestartOperationTerminal(operation: RestartOperationRecord): boolean {
  const terminal = (state: RestartOperationDeliveryState) =>
    state === "delivered" || state === "skipped";
  return terminal(operation.delivery.receipt) && terminal(operation.delivery.continuation);
}

function resolveRestartRecoveryMarkerPath(
  operationId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveStateDir(env), `restart-recovery-${operationId}.json`);
}

function buildRestartOperation(
  payload: RestartSentinelPayload,
): RestartOperationRecord | undefined {
  const triggersRestart =
    payload.kind === "restart" ? payload.status === "requested" : payload.status === "ok";
  if (!triggersRestart) {
    return undefined;
  }

  const requestedAt = payload.ts || Date.now();
  return {
    id: generateSecureUuid(),
    sessionKey: payload.sessionKey?.trim() || undefined,
    channel: payload.deliveryContext?.channel?.trim() || undefined,
    to: payload.deliveryContext?.to?.trim() || undefined,
    accountId: payload.deliveryContext?.accountId?.trim() || undefined,
    topicId: payload.threadId?.trim() || undefined,
    reason: payload.stats?.reason?.trim() || undefined,
    note: payload.message?.trim() || undefined,
    requestedAt,
    expiresAt: requestedAt + RESTART_OPERATION_TTL_MS,
    recovery: { state: "waiting" },
    delivery: {
      receipt: "pending",
      continuation: payload.sessionKey?.trim() ? "pending" : "skipped",
      updatedAt: requestedAt,
    },
  };
}

/**
 * A tiny detached observer survives the gateway PID. It does not hold channel
 * credentials or send messages; it only records whether a replacement gateway
 * accepted TCP connections. The recovered gateway remains the sole owner of
 * receipt delivery and session continuation.
 */
function scheduleDetachedRestartRecoveryWatcher(params: {
  operation: RestartOperationRecord;
  env: NodeJS.ProcessEnv;
}): void {
  if (params.env.VITEST || params.env.NODE_ENV === "test") {
    return;
  }
  const portRaw = params.env.OPENCLAW_GATEWAY_PORT ?? params.env.OPENCLAW_PORT ?? "18789";
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    return;
  }
  const markerPath = resolveRestartRecoveryMarkerPath(params.operation.id, params.env);
  const sentinelPath = resolveRestartSentinelPath(params.env);
  const script = String.raw`
    const fs = require("node:fs");
    const net = require("node:net");
    const [
      markerPath,
      operationId,
      sentinelPath,
      oldPidRaw,
      portRaw,
      expiresAtRaw,
    ] = process.argv.slice(1);
    const oldPid = Number(oldPidRaw);
    const port = Number(portRaw);
    const expiresAt = Number(expiresAtRaw);
    const isTerminalDelivery = (state) => state === "delivered" || state === "skipped";
    const isTerminal = (state) => {
      if (!state || typeof state !== "object") {
        return false;
      }
      return isTerminalDelivery(state.receipt) && isTerminalDelivery(state.continuation);
    };
    const resolveOperationState = () => {
      try {
        const raw = fs.readFileSync(sentinelPath, "utf8");
        const parsed = JSON.parse(raw);
        if (
          parsed?.version !== 1 ||
          !parsed.operation ||
          parsed.operation.id !== operationId ||
          !parsed.operation.delivery
        ) {
          return { kind: "gone" };
        }
        return { kind: "active", delivery: parsed.operation.delivery };
      } catch (error) {
        // Only a missing file proves startup consumed the operation. Parse and
        // transient I/O failures are inconclusive, so keep the supervisor
        // watcher alive and let a later poll observe durable state.
        return error?.code === "ENOENT" ? { kind: "gone" } : { kind: "unknown" };
      }
    };
    const shouldAbort = () => {
      const state = resolveOperationState();
      return state.kind === "gone" ||
        (state.kind === "active" && isTerminal(state.delivery));
    };
    const write = (state, error) => {
      const tmp = markerPath + "." + process.pid + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ operationId, state, observedAt: Date.now(), ...(error ? { error } : {}) }) + "\n", { mode: 0o600 });
      fs.renameSync(tmp, markerPath);
      // Startup may consume the operation between the pre-write state check and
      // rename. A final check removes a marker that lost that race.
      if (shouldAbort()) {
        try { fs.unlinkSync(markerPath); } catch {}
      }
    };
    const oldPidAlive = () => {
      try { process.kill(oldPid, 0); return true; } catch { return false; }
    };
    const probe = () => new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      const finish = (ok) => { socket.destroy(); resolve(ok); };
      socket.setTimeout(500, () => finish(false));
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    });
    (async () => {
      // Keep polling on in-process SIGUSR1 restarts where oldPid is still alive,
      // but leave early if startup already removed the operation or marked it
      // terminal. This prevents orphan markers after a recovery path already
      // reconciled the restart in-process.
      while (Date.now() < expiresAt) {
        if (shouldAbort()) {
          return;
        }
        if (!oldPidAlive()) {
          break;
        }
        await new Promise((r) => setTimeout(r, ${WATCHER_POLL_PID_DEATH_MS}));
      }
      // After old process death, preserve old supervisor behavior by probing for a
      // listening gateway before marking recovery successful.
      while (Date.now() < expiresAt) {
        if (shouldAbort()) {
          return;
        }
        if (await probe()) {
          // Startup can finish reconciliation while the socket probe is in
          // flight. Re-check before writing so cleanup always wins the race.
          if (!shouldAbort()) {
            write("ok");
          }
          return;
        }
        await new Promise((r) => setTimeout(r, ${WATCHER_POLL_TTL_MS}));
      }
      if (!shouldAbort()) {
        write("error", "gateway did not recover before restart operation expiry");
      }
    })().catch((error) => {
      if (!shouldAbort()) {
        write("error", String(error));
      }
    });
  `;
  try {
    const child = spawn(
      process.execPath,
      [
        "-e",
        script,
        markerPath,
        params.operation.id,
        sentinelPath,
        String(process.pid),
        String(port),
        String(params.operation.expiresAt),
      ],
      { detached: true, stdio: "ignore", env: params.env },
    );
    child.unref();
  } catch {
    // Startup reconciliation still provides a fallback if process spawning is
    // unavailable. The record remains pending rather than falsely successful.
  }
}

export function formatDoctorNonInteractiveHint(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  return `Run: ${formatCliCommand("openclaw doctor --non-interactive", env)}`;
}

export function resolveRestartSentinelPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), SENTINEL_FILENAME);
}

export async function writeRestartSentinel(
  payload: RestartSentinelPayload,
  env: NodeJS.ProcessEnv = process.env,
) {
  const filePath = resolveRestartSentinelPath(env);
  const operation = buildRestartOperation(payload);
  const data: RestartSentinel = { version: 1, payload, operation };
  await withRestartSentinelLock(async () => {
    await writeJsonAtomic(filePath, data, {
      mode: 0o600,
      ensureDirMode: 0o700,
      trailingNewline: true,
    });
  });
  if (operation) {
    scheduleDetachedRestartRecoveryWatcher({ operation, env });
  }
  return filePath;
}

export async function updateRestartSentinel(
  update: (current: RestartSentinel) => RestartSentinel,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestartSentinel | null> {
  return withRestartSentinelLock(async () => {
    const current = await readRestartSentinel(env);
    if (!current) {
      return null;
    }
    const next = update(current);
    await writeJsonAtomic(resolveRestartSentinelPath(env), next, {
      mode: 0o600,
      ensureDirMode: 0o700,
      trailingNewline: true,
    });
    return next;
  });
}

/**
 * Remove only the matching fully terminal operation. Serializing this compare
 * and unlink with sentinel writes prevents completion of an older restart from
 * deleting a newer restart request that reused the single sentinel pathname.
 */
export async function consumeRestartSentinelIfTerminal(
  operationId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return withRestartSentinelLock(async () => {
    const current = await readRestartSentinel(env);
    if (
      !current?.operation ||
      current.operation.id !== operationId ||
      !isRestartOperationTerminal(current.operation)
    ) {
      return false;
    }
    try {
      await fs.unlink(resolveRestartSentinelPath(env));
    } catch (err) {
      // Another successful terminal consumer may win the unlink race. Every
      // other filesystem failure must propagate; claiming cleanup while stale
      // sentinel state remains would recreate the review blocker.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
    // The detached observer's marker is scoped to this operation and has no
    // value once both receipt and continuation are terminal.
    await fs.unlink(resolveRestartRecoveryMarkerPath(operationId, env)).catch(() => undefined);
    return true;
  });
}

/**
 * Acknowledge restart continuation only after its tagged system event has been
 * consumed by a successful agent call. Until this write lands, the sentinel is
 * the replayable input: a crash leaves `pending`/`delivering` for next startup.
 */
export async function markRestartContinuationConsumed(params: {
  sessionKey: string;
  contextKeys: Iterable<string | null | undefined>;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const operationIds = new Set<string>();
  for (const contextKey of params.contextKeys) {
    const normalized = contextKey?.trim().toLowerCase();
    if (normalized?.startsWith("restart:") && normalized.length > "restart:".length) {
      operationIds.add(normalized.slice("restart:".length));
    }
  }
  if (operationIds.size === 0) {
    return false;
  }

  let marked = false;
  const updated = await updateRestartSentinel((current) => {
    const operation = current.operation;
    if (
      !operation ||
      !operationIds.has(operation.id.toLowerCase()) ||
      operation.sessionKey !== params.sessionKey ||
      (operation.delivery.continuation !== "pending" &&
        operation.delivery.continuation !== "delivering")
    ) {
      return current;
    }
    marked = true;
    return {
      ...current,
      operation: {
        ...operation,
        delivery: {
          ...operation.delivery,
          continuation: "delivered",
          updatedAt: Date.now(),
          lastError: undefined,
        },
      },
    };
  }, params.env);
  if (marked && updated?.operation && isRestartOperationTerminal(updated.operation)) {
    await consumeRestartSentinelIfTerminal(updated.operation.id, params.env);
  }
  return marked;
}

/**
 * Reconcile a restart continuation whose agent run failed after draining its
 * tagged event. The caller owns restoring the in-memory event; this function
 * only restores durable replay state and refuses retries after operation TTL.
 */
export async function markRestartContinuationFailed(params: {
  sessionKey: string;
  contextKeys: Iterable<string | null | undefined>;
  error: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string | null> {
  const operationIds = new Set<string>();
  for (const contextKey of params.contextKeys) {
    const normalized = contextKey?.trim().toLowerCase();
    if (normalized?.startsWith("restart:") && normalized.length > "restart:".length) {
      operationIds.add(normalized.slice("restart:".length));
    }
  }
  if (operationIds.size === 0) {
    return null;
  }

  const now = Date.now();
  let retryContextKey: string | null = null;
  const updated = await updateRestartSentinel((current) => {
    const operation = current.operation;
    if (
      !operation ||
      !operationIds.has(operation.id.toLowerCase()) ||
      operation.sessionKey !== params.sessionKey ||
      (operation.delivery.continuation !== "pending" &&
        operation.delivery.continuation !== "delivering")
    ) {
      return current;
    }

    const expired = operation.expiresAt <= now;
    if (!expired) {
      retryContextKey = `restart:${operation.id}`;
    }
    return {
      ...current,
      operation: {
        ...operation,
        delivery: {
          ...operation.delivery,
          continuation: expired ? "skipped" : "pending",
          updatedAt: now,
          lastError: expired
            ? "restart operation expired after continuation failure"
            : params.error,
        },
      },
    };
  }, params.env);
  if (updated?.operation && isRestartOperationTerminal(updated.operation)) {
    await consumeRestartSentinelIfTerminal(updated.operation.id, params.env);
  }
  return retryContextKey;
}

export async function readRestartRecoveryMarker(
  operationId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ state: "ok" | "error"; observedAt: number; error?: string } | null> {
  try {
    const raw = await fs.readFile(resolveRestartRecoveryMarkerPath(operationId, env), "utf8");
    const parsed = JSON.parse(raw) as {
      operationId?: string;
      state?: "ok" | "error";
      observedAt?: number;
      error?: string;
    };
    if (
      parsed.operationId !== operationId ||
      (parsed.state !== "ok" && parsed.state !== "error") ||
      typeof parsed.observedAt !== "number"
    ) {
      return null;
    }
    return { state: parsed.state, observedAt: parsed.observedAt, error: parsed.error };
  } catch {
    return null;
  }
}

export async function readRestartSentinel(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestartSentinel | null> {
  const filePath = resolveRestartSentinelPath(env);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    let parsed: RestartSentinel | undefined;
    try {
      parsed = JSON.parse(raw) as RestartSentinel | undefined;
    } catch {
      await fs.unlink(filePath).catch(() => {});
      return null;
    }
    if (!parsed || parsed.version !== 1 || !parsed.payload) {
      await fs.unlink(filePath).catch(() => {});
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function consumeRestartSentinel(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestartSentinel | null> {
  return withRestartSentinelLock(async () => {
    const filePath = resolveRestartSentinelPath(env);
    const parsed = await readRestartSentinel(env);
    if (!parsed) {
      return null;
    }
    await fs.unlink(filePath).catch(() => {});
    return parsed;
  });
}

export function formatRestartSentinelMessage(payload: RestartSentinelPayload): string {
  const message = payload.message?.trim();
  if (message && !payload.stats) {
    return message;
  }
  const lines: string[] = [summarizeRestartSentinel(payload)];
  if (message) {
    lines.push(message);
  }
  const reason = payload.stats?.reason?.trim();
  if (reason && reason !== message) {
    lines.push(`Reason: ${reason}`);
  }
  if (payload.doctorHint?.trim()) {
    lines.push(payload.doctorHint.trim());
  }
  return lines.join("\n");
}

export function summarizeRestartSentinel(payload: RestartSentinelPayload): string {
  const kind = payload.kind;
  const status = payload.status;
  const mode = payload.stats?.mode ? ` (${payload.stats.mode})` : "";
  return `Gateway restart ${kind} ${status}${mode}`.trim();
}

export function trimLogTail(input?: string | null, maxChars = 8000) {
  if (!input) {
    return null;
  }
  const text = input.trimEnd();
  if (text.length <= maxChars) {
    return text;
  }
  return `…${text.slice(text.length - maxChars)}`;
}
