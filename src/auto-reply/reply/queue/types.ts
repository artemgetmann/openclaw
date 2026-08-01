import type { ExecToolDefaults } from "../../../agents/bash-tools.js";
import type { SkillSnapshot } from "../../../agents/skills.js";
import type { OpenClawConfig } from "../../../config/config.js";
import type { SessionEntry } from "../../../config/sessions.js";
import type { CronDelivery } from "../../../cron/types.js";
import type { InputProvenance } from "../../../sessions/input-provenance.js";
import type { OriginatingChannelType } from "../../templating.js";
import type { ReplyPayload, SourceReplyDeliveryMode } from "../../types.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "../directives.js";

export type QueueMode = "steer" | "followup" | "collect" | "steer-backlog" | "interrupt" | "queue";

export type QueueDropPolicy = "old" | "new" | "summarize";

export type QueueSettings = {
  mode: QueueMode;
  debounceMs?: number;
  cap?: number;
  dropPolicy?: QueueDropPolicy;
};

export type QueueDedupeMode = "message-id" | "prompt" | "none";

export type FollowupRun = {
  /**
   * Disk record backing this item. It is intentionally optional because
   * steering and test-only queues may remain process-local.
   */
  durableId?: string;
  /**
   * Disk records represented by a synthetic collect/summary turn. The wrapper
   * has no single input record of its own, but failures must still preserve all
   * constituent records for retry.
   */
  durableIds?: string[];
  /** Persisted retry attempt count for this disk-backed input. */
  durableRetryCount?: number;
  /** Earliest wall-clock time at which this input may run again. */
  durableNextAttemptAt?: number;
  /** Durable TTL copied into RAM so a sleeping retry cannot run after expiry. */
  durableExpiresAt?: number;
  /**
   * Model-complete output restored from disk. When present, the runner skips
   * agent/tool execution and retries only outbound delivery.
   */
  deliveryPayloads?: ReplyPayload[];
  prompt: string;
  /** Provider message ID, when available (for deduplication). */
  messageId?: string;
  summaryLine?: string;
  enqueuedAt: number;
  /**
   * Originating channel for reply routing.
   * When set, replies should be routed back to this provider
   * instead of using the session's lastChannel.
   */
  originatingChannel?: OriginatingChannelType;
  /**
   * Originating destination for reply routing.
   * The chat/channel/user ID where the reply should be sent.
   */
  originatingTo?: string;
  /** Provider account id (multi-account). */
  originatingAccountId?: string;
  /** Thread id for reply routing (Telegram topic id or Matrix thread event id). */
  originatingThreadId?: string | number;
  /** Chat type for context-aware threading (e.g., DM vs channel). */
  originatingChatType?: string;
  run: {
    agentId: string;
    agentDir: string;
    sessionId: string;
    sessionKey?: string;
    messageProvider?: string;
    agentAccountId?: string;
    groupId?: string;
    groupChannel?: string;
    groupSpace?: string;
    senderId?: string;
    senderName?: string;
    senderUsername?: string;
    senderE164?: string;
    senderIsOwner?: boolean;
    sessionFile: string;
    /** Last known prompt pressure from persisted session metadata. */
    persistedPromptTokens?: number;
    workspaceDir: string;
    config: OpenClawConfig;
    skillsSnapshot?: SkillSnapshot;
    provider: string;
    model: string;
    authProfileId?: string;
    authProfileIdSource?: "auto" | "user";
    thinkLevel?: ThinkLevel;
    verboseLevel?: VerboseLevel;
    reasoningLevel?: ReasoningLevel;
    elevatedLevel?: ElevatedLevel;
    execOverrides?: Pick<ExecToolDefaults, "host" | "security" | "ask" | "node">;
    bashElevated?: {
      enabled: boolean;
      allowed: boolean;
      defaultLevel: ElevatedLevel;
    };
    timeoutMs: number;
    blockReplyBreak: "text_end" | "message_end";
    ownerNumbers?: string[];
    inputProvenance?: InputProvenance;
    extraSystemPrompt?: string;
    enforceFinalTag?: boolean;
    sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
    /** Per-turn TTS state captured before the inbound dispatcher returns. */
    resolvedTtsAuto?: string;
    inboundAudio?: boolean;
    ttsChannel?: string;
    /** Runtime-trusted reminder destination, independent of source-topic routing. */
    cronDefaultDelivery?: CronDelivery;
  };
};

export type ResolveQueueSettingsParams = {
  cfg: OpenClawConfig;
  channel?: string;
  sessionEntry?: SessionEntry;
  inlineMode?: QueueMode;
  inlineOptions?: Partial<QueueSettings>;
};
