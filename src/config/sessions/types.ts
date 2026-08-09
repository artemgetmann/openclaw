import crypto from "node:crypto";
import type { Skill } from "@mariozechner/pi-coding-agent";
import type { ChatType } from "../../channels/chat-type.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import type { DeliveryContext } from "../../utils/delivery-context.js";
import type { TtsAutoMode } from "../types.tts.js";

export type SessionScope = "per-sender" | "global";
export type SessionMemoryScope = "personal" | "shared";

export type SessionChannelId = ChannelId | "webchat";

export type SessionChatType = ChatType;

export type SessionOrigin = {
  label?: string;
  provider?: string;
  surface?: string;
  chatType?: SessionChatType;
  from?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

export type SessionAcpIdentitySource = "ensure" | "status" | "event";

export type SessionAcpIdentityState = "pending" | "resolved";

export type SessionAcpIdentity = {
  state: SessionAcpIdentityState;
  acpxRecordId?: string;
  acpxSessionId?: string;
  agentSessionId?: string;
  source: SessionAcpIdentitySource;
  lastUpdatedAt: number;
};

export type SessionAcpMeta = {
  backend: string;
  agent: string;
  runtimeSessionName: string;
  /** Hash of the OpenClaw-owned bootstrap context used to seed this ACP session. */
  contextFingerprint?: string;
  identity?: SessionAcpIdentity;
  mode: "persistent" | "oneshot";
  runtimeOptions?: AcpSessionRuntimeOptions;
  cwd?: string;
  state: "idle" | "running" | "error";
  lastActivityAt: number;
  lastError?: string;
};

export type AcpSessionRuntimeOptions = {
  /**
   * ACP runtime mode set via session/set_mode (for example: "plan", "normal", "auto").
   */
  runtimeMode?: string;
  /** ACP runtime config option: model id. */
  model?: string;
  /** Working directory override for ACP session turns. */
  cwd?: string;
  /** ACP runtime config option: permission profile id. */
  permissionProfile?: string;
  /** ACP runtime config option: per-turn timeout in seconds. */
  timeoutSeconds?: number;
  /** Backend-specific option bag mapped through session/set_config_option. */
  backendExtras?: Record<string, string>;
};

export type FutureThreadDefaultsHistoryEntry = {
  /**
   * Future-thread defaults written inside thread/topic N only apply to later
   * siblings. Older siblings with ids <= N must not retroactively inherit it.
   */
  afterThreadId: number;
  providerOverride?: string;
  modelOverride?: string;
  thinkingLevelOverride?: string;
  verboseLevel?: string;
  execSecurity?: string;
  execAsk?: string;
  updatedAt: number;
};

export type RecentHeartbeatEntry = {
  /** Delivery timestamp (epoch ms) for a user-facing heartbeat alert. */
  sentAt: number;
  /** Final outbound channel used for the alert. */
  channel: string;
  /** Final outbound target used for the alert, when present. */
  to?: string;
  /** Short normalized preview of what the heartbeat actually delivered. */
  preview: string;
  /** Kept explicit so future heartbeat history can grow beyond sent-only without ambiguity. */
  status: "sent";
};

export type HeartbeatAttentionStateEntry = {
  /** Stable model-owned identity for one attention item across heartbeat runs. */
  key: string;
  /**
   * Material-state fingerprint, not a hash of prose. Reusing it lets the runner suppress
   * paraphrased repeats without trusting exact message equality.
   */
  fingerprint: string;
  /** Short human label retained for prompt history and operator diagnostics. */
  title: string;
  /** Delivery timestamp (epoch ms) for the latest materially changed version. */
  deliveredAt: number;
  /** Urgency at delivery time; escalation to urgent is itself a material change. */
  urgency: "normal" | "urgent";
  /** Compact destination label; detailed channel metadata remains in the delivered message. */
  destination: string;
};

export type SessionPendingRestartConfirmation = {
  /**
   * Session-scoped restart authorization only applies to restart-capable gateway
   * actions and must be preceded by an explicit assistant ask in this chat.
   */
  scope: "gateway-restart-capable";
  /** When the assistant armed the confirmation gate (epoch ms). */
  requestedAt: number;
  /** Hard expiry for the pending confirmation (epoch ms). */
  expiresAt: number;
};

export type SessionGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usage_limited"
  | "budget_limited"
  | "complete";

export const SESSION_GOAL_CODEX_THREAD_UNARCHIVE_RESUME_ACTION =
  "codex.thread.unarchive_resume" as const;

/**
 * Exact consequential action approved with the goal itself.
 *
 * Generic allowedActions remain useful for human-readable autonomy, but they
 * cannot authorize a durable external mutation. A monitor grant must match one
 * of these persisted contracts byte-for-byte before it can be issued.
 */
export type SessionGoalAuthorityGrant = {
  purposeKey: string;
  action: {
    kind: typeof SESSION_GOAL_CODEX_THREAD_UNARCHIVE_RESUME_ACTION;
    threadId: string;
    prompt: string;
  };
  idempotencyKey: string;
  expiresAt: string;
  stopCondition: string;
  maxExecutions: 1;
};

export type SessionGoalAutonomy = {
  /** Missing autonomy on legacy goals is intentionally interpreted as observe_only. */
  level: "observe_only" | "act_within_scope";
  /** Short, user-granted actions Jarvis may take without asking again. */
  allowedActions?: string[];
  /** Boundaries where Jarvis must stop and ask before acting. */
  approvalRequired?: string[];
  /** Exact one-shot grants approved when the goal was created. */
  authorityGrants?: SessionGoalAuthorityGrant[];
};

export type SessionGoalEvaluatorVerdict =
  | "satisfied"
  | "needs_revision"
  | "needs_input"
  | "approval_required"
  | "goal_blocked";

export type SessionGoalEvaluationAttempt = {
  /** Caller-stable id used to make post-turn evaluation safe to retry after a restart. */
  attemptId: string;
  /** Raw grader verdict before core-owned blocker threshold enforcement. */
  proposedVerdict: SessionGoalEvaluatorVerdict;
  /** Persisted verdict after core-owned policy has rejected premature goal_blocked claims. */
  verdict: SessionGoalEvaluatorVerdict;
  reason: string;
  /** Concise proof inspected by the grader; raw transcripts do not belong in session state. */
  evidence: string[];
  materialProgress: boolean;
  blockerKey?: string;
  consecutiveNoProgress: number;
  createdAt: number;
};

export type SessionGoalEvaluationState = {
  schemaVersion: 1;
  lastVerdict?: SessionGoalEvaluatorVerdict;
  automaticRevisionCount: number;
  maxAutomaticRevisions: number;
  /** Persisted stop flag prevents a restart from silently beginning an unbounded retry loop. */
  automaticRevisionExhaustedAt?: number;
  activeBlockerKey?: string;
  sameBlockerNoProgressCount: number;
  /** Small bounded audit trail; enough to prove blocker repetition without storing transcripts. */
  history: SessionGoalEvaluationAttempt[];
};

export type SessionGoalEvaluationRequest = {
  /** Tool-call id makes a completion claim safe to retry across process restarts. */
  requestId: string;
  /** Exact working run whose evidence may be used to grade this claim. */
  runId: string;
  proposedStatus: "complete" | "blocked";
  reason: string;
  /** A blocked claim must identify the exact dependency that prevented progress. */
  blockerKey?: string;
  createdAt: number;
};

export type SessionGoal = {
  schemaVersion: 1;
  id: string;
  objective: string;
  status: SessionGoalStatus;
  createdAt: number;
  updatedAt: number;
  tokenStart: number;
  tokenStartFresh?: boolean;
  tokensUsed: number;
  tokenBudget?: number;
  continuationTurns: number;
  autonomy?: SessionGoalAutonomy;
  evaluation?: SessionGoalEvaluationState;
  /** Model-authored claim awaiting an independent, tool-disabled post-turn evaluation. */
  pendingEvaluation?: SessionGoalEvaluationRequest;
  lastStatusNote?: string;
  pausedAt?: number;
  blockedAt?: number;
  completedAt?: number;
  budgetLimitedAt?: number;
  usageLimitedAt?: number;
};

export type SessionEntry = {
  /**
   * Last delivered heartbeat payload (used to suppress duplicate heartbeat notifications).
   * Stored on the main session entry.
   */
  lastHeartbeatText?: string;
  /** Timestamp (ms) when lastHeartbeatText was delivered. */
  lastHeartbeatSentAt?: number;
  /** Small bounded buffer of recent delivered heartbeats for repeat-aware reasoning. */
  recentHeartbeats?: RecentHeartbeatEntry[];
  /**
   * Per-item attention state used by typed heartbeat delivery. This is separate from the
   * human-readable recent-heartbeat previews because item dedupe must survive paraphrasing.
   */
  heartbeatAttentionState?: HeartbeatAttentionStateEntry[];
  sessionId: string;
  updatedAt: number;
  sessionFile?: string;
  /** Parent session key that spawned this session (used for sandbox session-tool scoping). */
  spawnedBy?: string;
  /** Core-owned durable goal state for this session. */
  goal?: SessionGoal;
  /** Workspace inherited by spawned sessions and reused on later turns for the same child session. */
  spawnedWorkspaceDir?: string;
  /** True after a thread/topic session has been forked from its parent transcript once. */
  forkedFromParent?: boolean;
  /** Subagent spawn depth (0 = main, 1 = sub-agent, 2 = sub-sub-agent). */
  spawnDepth?: number;
  /** Explicit role assigned at spawn time for subagent tool policy/control decisions. */
  subagentRole?: "orchestrator" | "leaf";
  /** Explicit control scope assigned at spawn time for subagent control decisions. */
  subagentControlScope?: "children" | "none";
  /**
   * Monitor-tool authority inherited from the verified owner turn that spawned
   * this subagent. This is core-written session metadata, never model input.
   */
  subagentMonitorToolDelegation?: boolean;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  /**
   * Session-level stop cutoff captured when /stop is received.
   * Messages at/before this boundary are skipped to avoid replaying
   * queued pre-stop backlog.
   */
  abortCutoffMessageSid?: string;
  /** Epoch ms cutoff paired with abortCutoffMessageSid when available. */
  abortCutoffTimestamp?: number;
  chatType?: SessionChatType;
  thinkingLevel?: string;
  fastMode?: boolean;
  verboseLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
  ttsAuto?: TtsAutoMode;
  execHost?: string;
  execSecurity?: string;
  execAsk?: string;
  execNode?: string;
  responseUsage?: "on" | "off" | "tokens" | "full";
  providerOverride?: string;
  modelOverride?: string;
  /**
   * Parent-chat default for future thread/topic sessions.
   * This is intentionally separate from providerOverride/modelOverride so
   * existing threads do not retroactively change when a thread picks a model.
   */
  futureThreadProviderOverride?: string;
  futureThreadModelOverride?: string;
  /**
   * Parent-chat default thinking level for future thread/topic sessions.
   * Existing threads intentionally remain unchanged.
   */
  futureThreadThinkingLevelOverride?: string;
  /**
   * Historical snapshots for Telegram thread/topic inheritance when Telegram
   * does not deliver topic-create service messages to the bot.
   */
  futureThreadDefaultsHistory?: FutureThreadDefaultsHistoryEntry[];
  authProfileOverride?: string;
  authProfileOverrideSource?: "auto" | "user";
  authProfileOverrideCompactionCount?: number;
  groupActivation?: "mention" | "always";
  groupActivationNeedsSystemIntro?: boolean;
  sendPolicy?: "allow" | "deny";
  queueMode?:
    | "steer"
    | "followup"
    | "collect"
    | "steer-backlog"
    | "steer+backlog"
    | "queue"
    | "interrupt";
  queueDebounceMs?: number;
  queueCap?: number;
  queueDrop?: "old" | "new" | "summarize";
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /**
   * Whether totalTokens reflects a fresh context snapshot for the latest run.
   * Undefined means legacy/unknown freshness; false forces consumers to treat
   * totalTokens as stale/unknown for context-utilization displays.
   */
  totalTokensFresh?: boolean;
  cacheRead?: number;
  cacheWrite?: number;
  modelProvider?: string;
  model?: string;
  /**
   * Last selected/runtime model pair for which a fallback notice was emitted.
   * Used to avoid repeating the same fallback notice every turn.
   */
  fallbackNoticeSelectedModel?: string;
  fallbackNoticeActiveModel?: string;
  fallbackNoticeReason?: string;
  /**
   * Last time the auto-reply context-pressure nudge was shown.
   * Paired with compaction count so it does not repeat every heavy turn.
   */
  contextPressureNoticeAt?: number;
  contextPressureNoticeCompactionCount?: number;
  contextTokens?: number;
  compactionCount?: number;
  memoryFlushAt?: number;
  memoryFlushCompactionCount?: number;
  cliSessionIds?: Record<string, string>;
  claudeCliSessionId?: string;
  label?: string;
  displayName?: string;
  channel?: string;
  groupId?: string;
  subject?: string;
  groupChannel?: string;
  space?: string;
  origin?: SessionOrigin;
  /**
   * Trust-derived memory lane for this session.
   * personal = may see personal long-term + daily memory
   * shared = must not auto-load personal memory files
   */
  memoryScope?: SessionMemoryScope;
  /** Pending confirmation gate for restart-capable gateway actions in this chat session. */
  pendingRestartConfirmation?: SessionPendingRestartConfirmation;
  deliveryContext?: DeliveryContext;
  lastChannel?: SessionChannelId;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
  skillsSnapshot?: SessionSkillSnapshot;
  systemPromptReport?: SessionSystemPromptReport;
  acp?: SessionAcpMeta;
};

function normalizeRuntimeField(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeSessionRuntimeModelFields(entry: SessionEntry): SessionEntry {
  const normalizedModel = normalizeRuntimeField(entry.model);
  const normalizedProvider = normalizeRuntimeField(entry.modelProvider);
  let next = entry;

  if (!normalizedModel) {
    if (entry.model !== undefined || entry.modelProvider !== undefined) {
      next = { ...next };
      delete next.model;
      delete next.modelProvider;
    }
    return next;
  }

  if (entry.model !== normalizedModel) {
    if (next === entry) {
      next = { ...next };
    }
    next.model = normalizedModel;
  }

  if (!normalizedProvider) {
    if (entry.modelProvider !== undefined) {
      if (next === entry) {
        next = { ...next };
      }
      delete next.modelProvider;
    }
    return next;
  }

  if (entry.modelProvider !== normalizedProvider) {
    if (next === entry) {
      next = { ...next };
    }
    next.modelProvider = normalizedProvider;
  }
  return next;
}

export function setSessionRuntimeModel(
  entry: SessionEntry,
  runtime: { provider: string; model: string },
): boolean {
  const provider = runtime.provider.trim();
  const model = runtime.model.trim();
  if (!provider || !model) {
    return false;
  }
  entry.modelProvider = provider;
  entry.model = model;
  return true;
}

export type SessionEntryMergePolicy = "touch-activity" | "preserve-activity";

type MergeSessionEntryOptions = {
  policy?: SessionEntryMergePolicy;
  now?: number;
};

function resolveMergedUpdatedAt(
  existing: SessionEntry | undefined,
  patch: Partial<SessionEntry>,
  options?: MergeSessionEntryOptions,
): number {
  if (options?.policy === "preserve-activity" && existing) {
    return existing.updatedAt ?? patch.updatedAt ?? options.now ?? Date.now();
  }
  return Math.max(existing?.updatedAt ?? 0, patch.updatedAt ?? 0, options?.now ?? Date.now());
}

export function mergeSessionEntryWithPolicy(
  existing: SessionEntry | undefined,
  patch: Partial<SessionEntry>,
  options?: MergeSessionEntryOptions,
): SessionEntry {
  const sessionId = patch.sessionId ?? existing?.sessionId ?? crypto.randomUUID();
  const updatedAt = resolveMergedUpdatedAt(existing, patch, options);
  if (!existing) {
    return normalizeSessionRuntimeModelFields({ ...patch, sessionId, updatedAt });
  }
  const next = { ...existing, ...patch, sessionId, updatedAt };

  // Guard against stale provider carry-over when callers patch runtime model
  // without also patching runtime provider.
  if (Object.hasOwn(patch, "model") && !Object.hasOwn(patch, "modelProvider")) {
    const patchedModel = normalizeRuntimeField(patch.model);
    const existingModel = normalizeRuntimeField(existing.model);
    if (patchedModel && patchedModel !== existingModel) {
      delete next.modelProvider;
    }
  }
  return normalizeSessionRuntimeModelFields(next);
}

export function mergeSessionEntry(
  existing: SessionEntry | undefined,
  patch: Partial<SessionEntry>,
): SessionEntry {
  return mergeSessionEntryWithPolicy(existing, patch);
}

export function mergeSessionEntryPreserveActivity(
  existing: SessionEntry | undefined,
  patch: Partial<SessionEntry>,
): SessionEntry {
  return mergeSessionEntryWithPolicy(existing, patch, {
    policy: "preserve-activity",
  });
}

export function resolveFreshSessionTotalTokens(
  entry?: Pick<SessionEntry, "totalTokens" | "totalTokensFresh"> | null,
): number | undefined {
  const total = entry?.totalTokens;
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
    return undefined;
  }
  if (entry?.totalTokensFresh === false) {
    return undefined;
  }
  return total;
}

export function isSessionTotalTokensFresh(
  entry?: Pick<SessionEntry, "totalTokens" | "totalTokensFresh"> | null,
): boolean {
  return resolveFreshSessionTotalTokens(entry) !== undefined;
}

export type GroupKeyResolution = {
  key: string;
  channel?: string;
  id?: string;
  chatType?: SessionChatType;
};

export type SessionSkillSnapshot = {
  prompt: string;
  skills: Array<{ name: string; primaryEnv?: string; requiredEnv?: string[] }>;
  /** Normalized agent-level filter used to build this snapshot; undefined means unrestricted. */
  skillFilter?: string[];
  /** Runtime eligibility note preserved when the prompt is reranked on later turns. */
  remoteNote?: string;
  /** Skills whose configured/product priority must stay ahead of relevance sorting. */
  protectedSkillNames?: string[];
  resolvedSkills?: Skill[];
  version?: number;
};

export type SessionSystemPromptReport = {
  source: "run" | "estimate";
  generatedAt: number;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  model?: string;
  workspaceDir?: string;
  runtime?: {
    openClawVersion?: string;
    branch?: string;
    worktree?: string;
    stateDir?: string;
    configPath?: string;
    serviceLabel?: string;
    gatewayPort?: number;
  };
  bootstrapMaxChars?: number;
  bootstrapTotalMaxChars?: number;
  bootstrapTruncation?: {
    warningMode?: "off" | "once" | "always";
    warningShown?: boolean;
    promptWarningSignature?: string;
    warningSignaturesSeen?: string[];
    truncatedFiles?: number;
    nearLimitFiles?: number;
    totalNearLimit?: boolean;
  };
  sandbox?: {
    mode?: string;
    sandboxed?: boolean;
  };
  systemPrompt: {
    chars: number;
    projectContextChars: number;
    nonProjectContextChars: number;
  };
  injectedWorkspaceFiles: Array<{
    name: string;
    path: string;
    missing: boolean;
    rawChars: number;
    injectedChars: number;
    truncated: boolean;
  }>;
  skills: {
    promptChars: number;
    entries: Array<{
      name: string;
      blockChars: number;
      descriptionChars: number;
      detailed: boolean;
      location?: string;
    }>;
  };
  tools: {
    listChars: number;
    schemaChars: number;
    entries: Array<{
      name: string;
      summaryChars: number;
      schemaChars: number;
      propertiesCount?: number | null;
    }>;
  };
};

export const DEFAULT_RESET_TRIGGER = "/new";
export const DEFAULT_RESET_TRIGGERS = ["/new", "/reset"];
export const DEFAULT_IDLE_MINUTES = 60;
