import { randomBytes } from "node:crypto";
import { getSessionGoal } from "../config/sessions/goals.js";
import {
  loadMonitorStore,
  saveMonitorStore,
  updateMonitorRecord,
  withMonitorStoreWriteLock,
} from "./store.js";
import {
  CODEX_THREAD_UNARCHIVE_RESUME_ACTION,
  type MonitorAuthorityAuditEvent,
  type MonitorAuthorityGrant,
  type MonitorAuthorityGrantInput,
  type MonitorGoalSnapshot,
  type MonitorRecord,
} from "./types.js";

const MAX_PURPOSE_KEY_LENGTH = 240;
const MAX_THREAD_ID_LENGTH = 256;
const MAX_PROMPT_LENGTH = 8_000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const MAX_STOP_CONDITION_LENGTH = 1_000;
const MAX_AUDIT_EVENTS = 24;

function requireBoundedText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} required`);
  }
  if (normalized.length > maxLength) {
    throw new Error(`${label} exceeds ${maxLength} characters`);
  }
  return normalized;
}

function appendAudit(
  grant: MonitorAuthorityGrant,
  entry: MonitorAuthorityAuditEvent,
): MonitorAuthorityAuditEvent[] {
  // Audit is useful only while bounded. Keep the grant event plus the newest
  // execution decisions instead of turning monitor state into an unbounded log.
  return [...grant.audit, entry].slice(-MAX_AUDIT_EVENTS);
}

function actionIsAllowedByGoal(
  goal: MonitorGoalSnapshot,
  authority: Pick<
    MonitorAuthorityGrant,
    "purposeKey" | "action" | "idempotencyKey" | "expiresAt" | "stopCondition" | "maxExecutions"
  >,
): boolean {
  return (
    goal.autonomy?.level === "act_within_scope" &&
    goal.autonomy.authorityGrants?.some(
      (approved) =>
        approved.purposeKey === authority.purposeKey &&
        approved.action.kind === authority.action.kind &&
        approved.action.threadId === authority.action.threadId &&
        approved.action.prompt === authority.action.prompt &&
        approved.idempotencyKey === authority.idempotencyKey &&
        approved.expiresAt === authority.expiresAt &&
        approved.stopCondition === authority.stopCondition &&
        approved.maxExecutions === authority.maxExecutions,
    ) === true
  );
}

export function normalizeMonitorAuthorityGrantInput(
  input: MonitorAuthorityGrantInput,
): MonitorAuthorityGrantInput {
  if (input.action.kind !== CODEX_THREAD_UNARCHIVE_RESUME_ACTION) {
    // The static input type admits only the supported literal, but persisted
    // or wire data can still be malformed at runtime.
    throw new Error("unsupported durable authority action");
  }
  return {
    purposeKey: requireBoundedText(
      input.purposeKey,
      "authority.purposeKey",
      MAX_PURPOSE_KEY_LENGTH,
    ),
    action: {
      kind: CODEX_THREAD_UNARCHIVE_RESUME_ACTION,
      threadId: requireBoundedText(
        input.action.threadId,
        "authority.action.threadId",
        MAX_THREAD_ID_LENGTH,
      ),
      prompt: requireBoundedText(input.action.prompt, "authority.action.prompt", MAX_PROMPT_LENGTH),
    },
    idempotencyKey: requireBoundedText(
      input.idempotencyKey,
      "authority.idempotencyKey",
      MAX_IDEMPOTENCY_KEY_LENGTH,
    ),
    expiresAt: requireBoundedText(input.expiresAt, "authority.expiresAt", 80),
    stopCondition: requireBoundedText(
      input.stopCondition,
      "authority.stopCondition",
      MAX_STOP_CONDITION_LENGTH,
    ),
  };
}

export function createMonitorAuthorityGrant(params: {
  input: MonitorAuthorityGrantInput;
  goal: MonitorGoalSnapshot | undefined;
  nowMs: number;
}): MonitorAuthorityGrant {
  if (!params.goal) {
    throw new Error("durable authority requires an active bound goal");
  }
  const normalizedInput = normalizeMonitorAuthorityGrantInput(params.input);
  const expiresAtMs = Date.parse(normalizedInput.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= params.nowMs) {
    throw new Error("authority.expiresAt must be a future ISO timestamp");
  }

  const approvedContract = {
    ...normalizedInput,
    maxExecutions: 1 as const,
  };
  if (!actionIsAllowedByGoal(params.goal, approvedContract)) {
    throw new Error(
      `goal autonomy must contain the exact approved ${CODEX_THREAD_UNARCHIVE_RESUME_ACTION} grant`,
    );
  }

  const grantedAtMs = params.nowMs;
  return {
    schemaVersion: 1,
    grantId: randomBytes(12).toString("hex"),
    goalId: params.goal.id,
    ...approvedContract,
    grantedAtMs,
    execution: { status: "available", executions: 0 },
    audit: [{ event: "granted", atMs: grantedAtMs }],
  };
}

export function revokeMonitorAuthorityGrant(
  authority: MonitorAuthorityGrant | undefined,
  nowMs: number,
  reason = "monitor stopped by user",
): MonitorAuthorityGrant | undefined {
  if (!authority || authority.execution.status !== "available") {
    return authority;
  }
  return {
    ...authority,
    revokedAtMs: nowMs,
    execution: {
      ...authority.execution,
      status: "failed",
      failedAtMs: nowMs,
      error: reason,
    },
    audit: appendAudit(authority, { event: "revoked", atMs: nowMs, reason }),
  };
}

export type MonitorAuthorityClaim = {
  execute: boolean;
  monitorId: string;
  cronJobId: string;
  originSessionKey: string;
  grantId: string;
  status: MonitorAuthorityGrant["execution"]["status"];
  prompt: string;
};

function findAuthorityMonitor(
  monitors: MonitorRecord[],
  sessionKey: string,
): MonitorRecord | undefined {
  return monitors.find((monitor) => monitor.monitorSessionKey === sessionKey);
}

function validateRequestedAction(params: {
  monitor: MonitorRecord;
  threadId: string;
  prompt: string;
  idempotencyKey: string;
}): MonitorAuthorityGrant {
  const authority = params.monitor.authority;
  if (!authority) {
    throw new Error("monitor has no durable authority grant");
  }
  if (params.monitor.goal?.id !== authority.goalId) {
    throw new Error("monitor authority is not bound to the current goal");
  }
  if (authority.action.kind !== CODEX_THREAD_UNARCHIVE_RESUME_ACTION) {
    throw new Error("monitor authority does not allow this action");
  }
  if (authority.action.threadId !== params.threadId.trim()) {
    throw new Error("monitor authority target does not match the requested Codex thread");
  }
  if (authority.action.prompt !== params.prompt.trim()) {
    throw new Error("monitor authority prompt does not match the approved continuation");
  }
  if (authority.idempotencyKey !== params.idempotencyKey.trim()) {
    throw new Error("monitor authority idempotency key does not match");
  }
  return authority;
}

export async function claimMonitorAuthorityAction(params: {
  storePath: string;
  sessionStorePath: string;
  monitorSessionKey: string;
  threadId: string;
  prompt: string;
  idempotencyKey: string;
  nowMs?: number;
}): Promise<MonitorAuthorityClaim> {
  const nowMs = params.nowMs ?? Date.now();
  return await withMonitorStoreWriteLock(params.storePath, async () => {
    const store = await loadMonitorStore(params.storePath);
    const monitor = findAuthorityMonitor(store.monitors, params.monitorSessionKey);
    if (!monitor) {
      throw new Error("current session is not a durable monitor session");
    }
    const authority = validateRequestedAction({ monitor, ...params });

    // Exact retries report the durable result but never repeat the external
    // mutation. This remains true after a process restart because the consumed
    // state lives in the monitor store rather than process memory.
    if (authority.execution.status !== "available") {
      return {
        execute: false,
        monitorId: monitor.monitorId,
        cronJobId: monitor.cronJobId,
        originSessionKey: monitor.originSessionKey,
        grantId: authority.grantId,
        status: authority.execution.status,
        prompt: authority.action.prompt,
      };
    }

    const goal = await getSessionGoal({
      sessionKey: monitor.originSessionKey,
      storePath: params.sessionStorePath,
      persist: false,
    });
    const goalIsAuthorized =
      goal.status === "found" &&
      goal.goal?.id === authority.goalId &&
      goal.goal.status === "active" &&
      actionIsAllowedByGoal(goal.goal, authority);
    const monitorIsActive = monitor.status === "active" || monitor.status === "degraded";
    if (!goalIsAuthorized || !monitorIsActive) {
      const reason = !goalIsAuthorized
        ? "bound goal is no longer active or authorized"
        : `monitor is no longer active: ${monitor.status}`;
      const revoked = revokeMonitorAuthorityGrant(authority, nowMs, reason);
      const index = store.monitors.indexOf(monitor);
      store.monitors[index] = updateMonitorRecord(
        monitor,
        {
          authority: revoked,
          status: "stopped",
          lastWakeAtMs: nowMs,
          lastWakeStatus: "stopped",
        },
        nowMs,
      );
      await saveMonitorStore(params.storePath, store);
      throw new Error(reason);
    }

    const expired = Date.parse(authority.expiresAt) <= nowMs;
    const revoked = authority.revokedAtMs !== undefined;
    if (expired || revoked) {
      const reason = expired ? "authority expired" : "authority revoked";
      const failed: MonitorAuthorityGrant = {
        ...authority,
        execution: {
          ...authority.execution,
          status: "failed",
          failedAtMs: nowMs,
          error: reason,
        },
        audit: appendAudit(authority, { event: "denied", atMs: nowMs, reason }),
      };
      const index = store.monitors.indexOf(monitor);
      store.monitors[index] = updateMonitorRecord(
        monitor,
        {
          authority: failed,
          status: expired ? "expired" : "stopped",
          lastWakeAtMs: nowMs,
          lastWakeStatus: expired ? "expired" : "stopped",
        },
        nowMs,
      );
      await saveMonitorStore(params.storePath, store);
      throw new Error(reason);
    }

    const consumed: MonitorAuthorityGrant = {
      ...authority,
      execution: {
        status: "consumed",
        executions: 1,
        consumedAtMs: nowMs,
      },
      audit: appendAudit(authority, { event: "consumed", atMs: nowMs }),
    };
    const index = store.monitors.indexOf(monitor);
    store.monitors[index] = updateMonitorRecord(
      monitor,
      {
        authority: consumed,
        // Stop future wakes before crossing the external mutation boundary.
        // A crash can leave work incomplete, but it cannot execute twice.
        status: "stopped",
        lastWakeAtMs: nowMs,
        lastWakeStatus: "stopped",
      },
      nowMs,
    );
    await saveMonitorStore(params.storePath, store);
    return {
      execute: true,
      monitorId: monitor.monitorId,
      cronJobId: monitor.cronJobId,
      originSessionKey: monitor.originSessionKey,
      grantId: consumed.grantId,
      status: consumed.execution.status,
      prompt: consumed.action.prompt,
    };
  });
}

export async function finalizeMonitorAuthorityAction(params: {
  storePath: string;
  monitorSessionKey: string;
  grantId: string;
  outcome: "completed" | "failed";
  externalRef?: string;
  error?: string;
  nowMs?: number;
}): Promise<MonitorAuthorityGrant> {
  const nowMs = params.nowMs ?? Date.now();
  return await withMonitorStoreWriteLock(params.storePath, async () => {
    const store = await loadMonitorStore(params.storePath);
    const monitor = findAuthorityMonitor(store.monitors, params.monitorSessionKey);
    const authority = monitor?.authority;
    if (!monitor || !authority || authority.grantId !== params.grantId) {
      throw new Error("durable authority claim no longer exists");
    }
    if (authority.execution.status === params.outcome) {
      return authority;
    }
    if (authority.execution.status !== "consumed") {
      throw new Error(`cannot finalize authority from ${authority.execution.status}`);
    }

    const completed = params.outcome === "completed";
    const next: MonitorAuthorityGrant = {
      ...authority,
      execution: {
        ...authority.execution,
        status: params.outcome,
        ...(completed ? { completedAtMs: nowMs } : { failedAtMs: nowMs }),
        ...(params.externalRef?.trim() ? { externalRef: params.externalRef.trim() } : {}),
        ...(params.error?.trim() ? { error: params.error.trim().slice(0, 1_000) } : {}),
      },
      audit: appendAudit(authority, {
        event: params.outcome,
        atMs: nowMs,
        ...(params.error?.trim() ? { reason: params.error.trim().slice(0, 1_000) } : {}),
      }),
    };
    const index = store.monitors.indexOf(monitor);
    store.monitors[index] = updateMonitorRecord(
      monitor,
      {
        authority: next,
        status: completed ? "completed" : "stopped",
        lastWakeAtMs: nowMs,
        lastWakeStatus: completed ? "completed" : "stopped",
      },
      nowMs,
    );
    await saveMonitorStore(params.storePath, store);
    return next;
  });
}
