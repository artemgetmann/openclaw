// Session goal state tracks one durable objective on a chat/session.
import crypto from "node:crypto";
import { formatTokenCount } from "../../utils/usage-format.js";
import {
  loadSessionStore,
  normalizeStoreSessionKey,
  resolveSessionStoreEntry,
  updateSessionStore,
  updateSessionStoreEntry,
} from "./store.js";
import { mergeSessionEntry, resolveFreshSessionTotalTokens } from "./types.js";
import {
  SESSION_GOAL_CODEX_THREAD_UNARCHIVE_RESUME_ACTION,
  type SessionEntry,
  type SessionGoal,
  type SessionGoalAuthorityGrant,
  type SessionGoalAutonomy,
  type SessionGoalEvaluationAttempt,
  type SessionGoalEvaluationState,
  type SessionGoalEvaluationRequest,
  type SessionGoalEvaluatorVerdict,
  type SessionGoalStatus,
} from "./types.js";

export type SessionGoalSnapshot = {
  status: "missing" | "found";
  goal?: SessionGoal;
};

type SessionGoalStoreOptions = {
  sessionKey: string;
  storePath: string;
  now?: number;
  fallbackEntry?: SessionEntry;
  persist?: boolean;
};

type CreateSessionGoalOptions = SessionGoalStoreOptions & {
  objective: string;
  tokenBudget?: number;
  autonomy?: SessionGoalAutonomy;
};

type RecordSessionGoalContinuationOptions = SessionGoalStoreOptions & {
  expectedGoalId: string;
};

type UpdateSessionGoalStatusOptions = SessionGoalStoreOptions & {
  status: Extract<SessionGoalStatus, "active" | "paused" | "blocked" | "complete">;
  note?: string;
  expectedGoalId?: string;
};

type RequestSessionGoalEvaluationOptions = SessionGoalStoreOptions & {
  expectedGoalId?: string;
  requestId: string;
  runId: string;
  proposedStatus: SessionGoalEvaluationRequest["proposedStatus"];
  reason: string;
  blockerKey?: string;
};

export type RecordSessionGoalEvaluationOptions = SessionGoalStoreOptions & {
  expectedGoalId: string;
  attemptId: string;
  verdict: SessionGoalEvaluatorVerdict;
  reason: string;
  evidence: string[];
  materialProgress: boolean;
  blockerKey?: string;
};

export type SessionGoalEvaluationDecision = {
  goal: SessionGoal;
  attempt: SessionGoalEvaluationAttempt;
  duplicate: boolean;
  shouldContinueAutomatically: boolean;
  stopReason?:
    | "satisfied"
    | "needs_input"
    | "approval_required"
    | "goal_blocked"
    | "revision_limit";
};

export const MODEL_UPDATABLE_SESSION_GOAL_STATUSES = ["complete", "blocked"] as const;

const TERMINAL_GOAL_STATUSES = new Set<SessionGoalStatus>(["complete"]);
const DEFAULT_MAX_AUTOMATIC_REVISIONS = 5;
const DEFAULT_BLOCKER_THRESHOLD = 3;
const MAX_EVALUATION_HISTORY = 10;
const MAX_EVALUATION_EVIDENCE = 8;
const MAX_EVALUATION_TEXT_CHARS = 500;

function nowMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

function normalizeTokenCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function resolveEntryFreshTotalTokens(
  entry: Pick<SessionEntry, "totalTokens" | "totalTokensFresh">,
): number | undefined {
  return normalizeTokenCount(resolveFreshSessionTotalTokens(entry));
}

function resolveEntryGoalStartTokens(
  entry: Pick<SessionEntry, "totalTokens" | "totalTokensFresh">,
): number {
  return resolveEntryFreshTotalTokens(entry) ?? 0;
}

function normalizeTokenBudget(value: number | undefined): number | undefined {
  const normalized = normalizeTokenCount(value);
  return normalized && normalized > 0 ? normalized : undefined;
}

const MAX_AUTONOMY_ITEMS = 12;
const MAX_AUTONOMY_ITEM_CHARS = 160;
const MAX_AUTHORITY_GRANTS = 4;
const MAX_AUTHORITY_TEXT_CHARS = 8_000;

function normalizeAutonomyItems(values: string[] | undefined): string[] | undefined {
  if (!values) {
    return undefined;
  }
  const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .slice(0, MAX_AUTONOMY_ITEMS)
    .map((value) => value.slice(0, MAX_AUTONOMY_ITEM_CHARS));
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeAuthorityText(value: unknown, maxLength = MAX_AUTHORITY_TEXT_CHARS): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeSessionGoalAuthorityGrants(
  values: SessionGoalAuthorityGrant[] | undefined,
): SessionGoalAuthorityGrant[] | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }
  const normalized: SessionGoalAuthorityGrant[] = [];
  const seen = new Set<string>();
  for (const value of values.slice(0, MAX_AUTHORITY_GRANTS)) {
    const action = value?.action;
    const grant: SessionGoalAuthorityGrant = {
      purposeKey: normalizeAuthorityText(value?.purposeKey, 240),
      action: {
        kind: SESSION_GOAL_CODEX_THREAD_UNARCHIVE_RESUME_ACTION,
        threadId: normalizeAuthorityText(action?.threadId, 256),
        prompt: normalizeAuthorityText(action?.prompt),
      },
      idempotencyKey: normalizeAuthorityText(value?.idempotencyKey, 256),
      expiresAt: normalizeAuthorityText(value?.expiresAt, 80),
      stopCondition: normalizeAuthorityText(value?.stopCondition, 1_000),
      maxExecutions: 1,
    };
    if (
      action?.kind !== SESSION_GOAL_CODEX_THREAD_UNARCHIVE_RESUME_ACTION ||
      value?.maxExecutions !== 1 ||
      !grant.purposeKey ||
      !grant.action.threadId ||
      !grant.action.prompt ||
      !grant.idempotencyKey ||
      !grant.expiresAt ||
      !grant.stopCondition
    ) {
      continue;
    }
    const identity = JSON.stringify(grant);
    if (!seen.has(identity)) {
      seen.add(identity);
      normalized.push(grant);
    }
  }
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeSessionGoalAutonomy(
  autonomy: SessionGoalAutonomy | undefined,
): SessionGoalAutonomy | undefined {
  if (!autonomy) {
    return undefined;
  }
  const allowedActions = normalizeAutonomyItems(autonomy.allowedActions);
  const approvalRequired = normalizeAutonomyItems(autonomy.approvalRequired);
  const authorityGrants = normalizeSessionGoalAuthorityGrants(autonomy.authorityGrants);
  return {
    level: autonomy.level,
    ...(allowedActions ? { allowedActions } : {}),
    ...(approvalRequired ? { approvalRequired } : {}),
    ...(authorityGrants ? { authorityGrants } : {}),
  };
}

export function resolveSessionGoalAutonomy(
  goal: Pick<SessionGoal, "autonomy"> | undefined,
): SessionGoalAutonomy {
  return normalizeSessionGoalAutonomy(goal?.autonomy) ?? { level: "observe_only" };
}

function cloneGoal(goal: SessionGoal): SessionGoal {
  return structuredClone(goal);
}

function normalizeEvaluationText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} required`);
  }
  return normalized.slice(0, MAX_EVALUATION_TEXT_CHARS);
}

function normalizeEvaluationEvidence(values: string[]): string[] {
  const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .slice(0, MAX_EVALUATION_EVIDENCE)
    .map((value) => value.slice(0, MAX_EVALUATION_TEXT_CHARS));
  if (normalized.length === 0) {
    throw new Error("evaluation evidence required");
  }
  return normalized;
}

function resolveEvaluationState(
  state: SessionGoalEvaluationState | undefined,
): SessionGoalEvaluationState {
  return state
    ? structuredClone(state)
    : {
        schemaVersion: 1,
        automaticRevisionCount: 0,
        maxAutomaticRevisions: DEFAULT_MAX_AUTOMATIC_REVISIONS,
        sameBlockerNoProgressCount: 0,
        history: [],
      };
}

export function resolveSessionGoalDisplayState(
  entry: Pick<SessionEntry, "goal" | "totalTokens" | "totalTokensFresh">,
  now?: number,
  options?: { adoptFreshBaseline?: boolean },
): SessionGoal | undefined {
  return accountGoalUsage(entry, nowMs(now), options);
}

function accountGoalUsage(
  entry: Pick<SessionEntry, "goal" | "totalTokens" | "totalTokensFresh">,
  now: number,
  options?: { adoptFreshBaseline?: boolean },
): SessionGoal | undefined {
  const goal = entry.goal;
  if (!goal) {
    return undefined;
  }

  const totalTokens = resolveEntryFreshTotalTokens(entry);
  const hasFreshStart = goal.tokenStartFresh !== false;
  // Old or freshly-created entries may not have a fresh token baseline yet. Persisted reads
  // adopt the next fresh total; display-only reads can show the stale projection without churn.
  const shouldHoldStaleStart = !hasFreshStart && options?.adoptFreshBaseline === false;
  const shouldAdoptFreshStart =
    !shouldHoldStaleStart && totalTokens !== undefined && !hasFreshStart;
  const tokenStart = shouldAdoptFreshStart
    ? totalTokens
    : (normalizeTokenCount(goal.tokenStart) ?? totalTokens ?? 0);
  const tokensUsed =
    totalTokens === undefined || shouldAdoptFreshStart || shouldHoldStaleStart
      ? goal.tokensUsed
      : Math.max(goal.tokensUsed, Math.max(0, totalTokens - tokenStart));
  const next: SessionGoal = {
    ...goal,
    tokenStart,
    tokenStartFresh: hasFreshStart || shouldAdoptFreshStart,
    tokensUsed,
  };
  if (
    next.status === "active" &&
    next.tokenBudget !== undefined &&
    tokensUsed >= next.tokenBudget
  ) {
    next.status = "budget_limited";
    next.budgetLimitedAt = now;
    next.updatedAt = now;
  }
  return next;
}

function goalsEqual(a: SessionGoal | undefined, b: SessionGoal | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function formatSessionGoalStatus(goal: SessionGoal | undefined): string {
  if (!goal) {
    return "No goal for this session.\nStart one with /goal start <objective>.";
  }
  const budget =
    goal.tokenBudget === undefined
      ? ""
      : `\nToken budget: ${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget)}`;
  const note = goal.lastStatusNote ? `\nNote: ${goal.lastStatusNote}` : "";
  const commands = resolveGoalCommandHint(goal.status);
  return [
    "Goal",
    `Status: ${goal.status}`,
    `Objective: ${goal.objective}`,
    `Tokens used: ${formatTokenCount(goal.tokensUsed)}`,
    ...(budget ? [budget.slice(1)] : []),
    ...(note ? [note.slice(1)] : []),
    "",
    `Commands: ${commands}`,
  ].join("\n");
}

function resolveGoalCommandHint(status: SessionGoalStatus): string {
  switch (status) {
    case "active":
      return "/goal pause, /goal complete, /goal clear";
    case "paused":
    case "blocked":
    case "usage_limited":
    case "budget_limited":
      return "/goal resume, /goal clear";
    case "complete":
      return "/goal clear";
  }
  return "/goal";
}

export async function getSessionGoal(
  options: SessionGoalStoreOptions,
): Promise<SessionGoalSnapshot> {
  const now = nowMs(options.now);
  if (options.persist === false) {
    const store = loadSessionStore(options.storePath);
    const entry =
      resolveSessionStoreEntry({ store, sessionKey: options.sessionKey }).existing ??
      options.fallbackEntry;
    const projected = entry
      ? resolveSessionGoalDisplayState(entry, now, { adoptFreshBaseline: false })
      : undefined;
    return projected ? { status: "found", goal: projected } : { status: "missing" };
  }

  let goal: SessionGoal | undefined;
  const result = await updateSessionStoreEntry({
    sessionKey: options.sessionKey,
    storePath: options.storePath,
    update: async (entry) => {
      const accounted = accountGoalUsage(entry, now);
      goal = accounted ? cloneGoal(accounted) : undefined;
      if (!accounted || goalsEqual(accounted, entry.goal)) {
        return null;
      }
      return { goal: accounted };
    },
  });
  if (!result || !goal) {
    return { status: "missing" };
  }
  return { status: "found", goal };
}

export async function createSessionGoal(options: CreateSessionGoalOptions): Promise<SessionGoal> {
  const objective = options.objective.trim();
  if (!objective) {
    throw new Error("objective required");
  }
  const now = nowMs(options.now);
  let created: SessionGoal | undefined;

  await updateSessionStore(
    options.storePath,
    (store) => {
      const resolved = resolveSessionStoreEntry({ store, sessionKey: options.sessionKey });
      const existing = resolved.existing ?? options.fallbackEntry;
      if (existing?.goal) {
        throw new Error("goal already exists");
      }
      const tokenBudget = normalizeTokenBudget(options.tokenBudget);
      const autonomy = normalizeSessionGoalAutonomy(options.autonomy);
      const entry = mergeSessionEntry(existing, options.fallbackEntry ?? {});
      const tokenStartFresh = resolveEntryFreshTotalTokens(entry) !== undefined;
      created = {
        schemaVersion: 1,
        id: crypto.randomUUID(),
        objective,
        status: "active",
        createdAt: now,
        updatedAt: now,
        tokenStart: resolveEntryGoalStartTokens(entry),
        tokenStartFresh,
        tokensUsed: 0,
        ...(tokenBudget ? { tokenBudget } : {}),
        continuationTurns: 0,
        ...(autonomy ? { autonomy } : {}),
      };
      store[resolved.normalizedKey] = mergeSessionEntry(entry, { goal: created });
      for (const legacyKey of resolved.legacyKeys) {
        delete store[legacyKey];
      }
    },
    { activeSessionKey: normalizeStoreSessionKey(options.sessionKey) },
  );

  if (!created) {
    throw new Error("session not found");
  }
  return cloneGoal(created);
}

export async function recordSessionGoalContinuation(
  options: RecordSessionGoalContinuationOptions,
): Promise<SessionGoal | undefined> {
  const now = nowMs(options.now);
  let updated: SessionGoal | undefined;
  await updateSessionStoreEntry({
    sessionKey: options.sessionKey,
    storePath: options.storePath,
    update: async (entry) => {
      const accounted = accountGoalUsage(entry, now);
      // A wake is continuation activity only while the exact origin goal remains active.
      // Missing, replaced, paused, limited, blocked, or completed goals are left untouched.
      if (!accounted || accounted.id !== options.expectedGoalId || accounted.status !== "active") {
        return null;
      }
      updated = {
        ...accounted,
        continuationTurns: Math.min(
          Number.MAX_SAFE_INTEGER,
          Math.max(0, accounted.continuationTurns) + 1,
        ),
        updatedAt: now,
      };
      return { goal: updated };
    },
  });
  return updated ? cloneGoal(updated) : undefined;
}

export async function recordSessionGoalEvaluation(
  options: RecordSessionGoalEvaluationOptions,
): Promise<SessionGoalEvaluationDecision> {
  const now = nowMs(options.now);
  const attemptId = normalizeEvaluationText(options.attemptId, "evaluation attempt id");
  const reason = normalizeEvaluationText(options.reason, "evaluation reason");
  const evidence = normalizeEvaluationEvidence(options.evidence);
  const blockerKey = options.blockerKey?.trim().slice(0, MAX_EVALUATION_TEXT_CHARS) || undefined;
  if (options.verdict === "goal_blocked" && (!blockerKey || options.materialProgress)) {
    throw new Error("goal_blocked requires a blocker key and no material progress");
  }

  let decision: SessionGoalEvaluationDecision | undefined;
  let foundSession = false;
  const result = await updateSessionStoreEntry({
    sessionKey: options.sessionKey,
    storePath: options.storePath,
    update: async (entry) => {
      foundSession = true;
      const accounted = accountGoalUsage(entry, now);
      if (!accounted) {
        throw new Error("goal not found");
      }
      if (accounted.id !== options.expectedGoalId) {
        throw new Error("goal mismatch");
      }

      const evaluation = resolveEvaluationState(accounted.evaluation);
      const duplicate = evaluation.history.find((attempt) => attempt.attemptId === attemptId);
      if (duplicate) {
        decision = buildEvaluationDecision(accounted, duplicate, true);
        return null;
      }
      if (accounted.status !== "active") {
        throw new Error(`goal is ${accounted.status}`);
      }

      // Progress or a changed blocker breaks the consecutive no-progress chain.
      // This prevents unrelated failures from accumulating into a false terminal block.
      const repeatsSameBlocker =
        !options.materialProgress &&
        Boolean(blockerKey) &&
        evaluation.activeBlockerKey === blockerKey;
      const consecutiveNoProgress =
        !options.materialProgress && blockerKey
          ? repeatsSameBlocker
            ? evaluation.sameBlockerNoProgressCount + 1
            : 1
          : 0;
      const mayResolveBlocked =
        options.verdict === "goal_blocked" && consecutiveNoProgress >= DEFAULT_BLOCKER_THRESHOLD;
      const resolvedVerdict =
        options.verdict === "goal_blocked" && !mayResolveBlocked
          ? "needs_revision"
          : options.verdict;
      const automaticRevisionCount =
        resolvedVerdict === "needs_revision"
          ? evaluation.automaticRevisionCount + 1
          : evaluation.automaticRevisionCount;
      const automaticRevisionExhausted =
        resolvedVerdict === "needs_revision" &&
        automaticRevisionCount >= evaluation.maxAutomaticRevisions;
      const attempt: SessionGoalEvaluationAttempt = {
        attemptId,
        proposedVerdict: options.verdict,
        verdict: resolvedVerdict,
        reason,
        evidence,
        materialProgress: options.materialProgress,
        ...(blockerKey ? { blockerKey } : {}),
        consecutiveNoProgress,
        createdAt: now,
      };
      const nextEvaluation: SessionGoalEvaluationState = {
        ...evaluation,
        lastVerdict: resolvedVerdict,
        automaticRevisionCount,
        ...(automaticRevisionExhausted
          ? { automaticRevisionExhaustedAt: now }
          : options.materialProgress
            ? { automaticRevisionExhaustedAt: undefined }
            : {}),
        ...(blockerKey && !options.materialProgress
          ? { activeBlockerKey: blockerKey }
          : { activeBlockerKey: undefined }),
        sameBlockerNoProgressCount: consecutiveNoProgress,
        history: [...evaluation.history, attempt].slice(-MAX_EVALUATION_HISTORY),
      };
      const next: SessionGoal = {
        ...accounted,
        evaluation: nextEvaluation,
        pendingEvaluation: undefined,
        updatedAt: now,
        lastStatusNote: reason,
        ...(resolvedVerdict === "satisfied"
          ? { status: "complete", completedAt: now }
          : resolvedVerdict === "goal_blocked"
            ? { status: "blocked", blockedAt: now }
            : {}),
      };
      decision = buildEvaluationDecision(next, attempt, false);
      return { goal: next };
    },
  });
  if (!result && !decision) {
    throw new Error(foundSession ? "goal not found" : "session not found");
  }
  if (!decision) {
    throw new Error("goal evaluation not recorded");
  }
  return {
    ...decision,
    goal: cloneGoal(decision.goal),
    attempt: structuredClone(decision.attempt),
  };
}

export async function requestSessionGoalEvaluation(
  options: RequestSessionGoalEvaluationOptions,
): Promise<SessionGoal> {
  const now = nowMs(options.now);
  const requestId = normalizeEvaluationText(options.requestId, "evaluation request id");
  const runId = normalizeEvaluationText(options.runId, "evaluation run id");
  const reason = normalizeEvaluationText(options.reason, "evaluation request reason");
  const blockerKey = options.blockerKey?.trim().slice(0, MAX_EVALUATION_TEXT_CHARS) || undefined;
  if (options.proposedStatus === "blocked" && !blockerKey) {
    throw new Error("blocked evaluation request requires a blocker key");
  }

  let updated: SessionGoal | undefined;
  let foundSession = false;
  const result = await updateSessionStoreEntry({
    sessionKey: options.sessionKey,
    storePath: options.storePath,
    update: async (entry) => {
      foundSession = true;
      const accounted = accountGoalUsage(entry, now);
      if (!accounted) {
        throw new Error("goal not found");
      }
      if (options.expectedGoalId && accounted.id !== options.expectedGoalId) {
        throw new Error("goal mismatch");
      }
      if (accounted.status !== "active") {
        throw new Error(`goal is ${accounted.status}`);
      }

      // A retried tool result must not replace its original durable claim with
      // different prose. The evaluator attempt uses this same stable identity.
      if (accounted.pendingEvaluation?.requestId === requestId) {
        updated = accounted;
        return null;
      }
      updated = {
        ...accounted,
        updatedAt: now,
        pendingEvaluation: {
          requestId,
          runId,
          proposedStatus: options.proposedStatus,
          reason,
          ...(blockerKey ? { blockerKey } : {}),
          createdAt: now,
        },
      };
      return { goal: updated };
    },
  });
  if (!result && !updated) {
    throw new Error(foundSession ? "goal not found" : "session not found");
  }
  if (!updated) {
    throw new Error("goal evaluation request not recorded");
  }
  return cloneGoal(updated);
}

function buildEvaluationDecision(
  goal: SessionGoal,
  attempt: SessionGoalEvaluationAttempt,
  duplicate: boolean,
): SessionGoalEvaluationDecision {
  const exhausted = goal.evaluation?.automaticRevisionExhaustedAt !== undefined;
  if (attempt.verdict === "needs_revision" && !exhausted) {
    return {
      goal,
      attempt,
      duplicate,
      shouldContinueAutomatically: true,
    };
  }
  const stopReason =
    attempt.verdict === "needs_revision"
      ? "revision_limit"
      : attempt.verdict === "satisfied"
        ? "satisfied"
        : attempt.verdict;
  return {
    goal,
    attempt,
    duplicate,
    shouldContinueAutomatically: false,
    stopReason,
  };
}

export async function updateSessionGoalStatus(
  options: UpdateSessionGoalStatusOptions,
): Promise<SessionGoal> {
  const now = nowMs(options.now);
  let updated: SessionGoal | undefined;
  let foundSession = false;
  const result = await updateSessionStoreEntry({
    sessionKey: options.sessionKey,
    storePath: options.storePath,
    update: async (entry) => {
      foundSession = true;
      const accounted = accountGoalUsage(entry, now);
      if (!accounted) {
        throw new Error("goal not found");
      }
      if (options.expectedGoalId && accounted.id !== options.expectedGoalId) {
        throw new Error("goal mismatch");
      }
      if (TERMINAL_GOAL_STATUSES.has(accounted.status) && accounted.status !== options.status) {
        throw new Error(`goal is already ${accounted.status}`);
      }
      const resetsBudgetWindow =
        options.status === "active" &&
        (accounted.status === "budget_limited" ||
          accounted.status === "usage_limited" ||
          (accounted.tokenBudget !== undefined && accounted.tokensUsed >= accounted.tokenBudget));
      const freshTokenStart = resetsBudgetWindow ? resolveEntryFreshTotalTokens(entry) : undefined;
      const next: SessionGoal = {
        ...accounted,
        status: options.status,
        updatedAt: now,
        ...(options.note ? { lastStatusNote: options.note } : {}),
        ...(options.status === "paused" ? { pausedAt: now } : {}),
        ...(options.status === "blocked" ? { blockedAt: now } : {}),
        ...(options.status === "complete" ? { completedAt: now } : {}),
      };
      if (resetsBudgetWindow) {
        next.tokenStart = freshTokenStart ?? 0;
        next.tokenStartFresh = freshTokenStart !== undefined;
        next.tokensUsed = 0;
        delete next.budgetLimitedAt;
        delete next.usageLimitedAt;
      }
      if (
        next.status === "active" &&
        next.tokenBudget !== undefined &&
        next.tokensUsed >= next.tokenBudget
      ) {
        next.status = "budget_limited";
        next.budgetLimitedAt = now;
      }
      updated = next;
      return { goal: updated };
    },
  });
  if (!result || !updated) {
    throw new Error(foundSession ? "goal not found" : "session not found");
  }
  return cloneGoal(updated);
}

export async function clearSessionGoal(options: SessionGoalStoreOptions): Promise<boolean> {
  let removed = false;
  const result = await updateSessionStoreEntry({
    sessionKey: options.sessionKey,
    storePath: options.storePath,
    update: async (entry) => {
      if (!entry.goal) {
        return null;
      }
      removed = true;
      return { goal: undefined };
    },
  });
  return Boolean(result && removed);
}
