import fs from "node:fs/promises";
import type { ImageContent, Usage } from "@mariozechner/pi-ai";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { resolveHeartbeatPrompt } from "../auto-reply/heartbeat.js";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/config.js";
import { shouldLogVerbose } from "../globals.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import { scopedHeartbeatWakeOptions } from "../routing/session-key.js";
import { resolveSessionAgentIds } from "./agent-scope.js";
import {
  analyzeBootstrapBudget,
  buildBootstrapInjectionStats,
  buildBootstrapPromptWarning,
  buildBootstrapTruncationReportMeta,
} from "./bootstrap-budget.js";
import { makeBootstrapWarn, resolveBootstrapContextForRun } from "./bootstrap-files.js";
import { runClaudeBridgeAgent } from "./claude-bridge.js";
import { resolveCliBackendConfig } from "./cli-backends.js";
import { prepareCliBundleMcpConfig } from "./cli-runner/bundle-mcp.js";
import {
  appendImagePathsToPrompt,
  buildCliSupervisorScopeKey,
  buildCliArgs,
  buildSystemPrompt,
  enqueueCliRun,
  normalizeCliModel,
  parseCliJson,
  parseCliJsonl,
  resolveCliNoOutputTimeoutMs,
  resolvePromptInput,
  resolveSessionIdToSend,
  resolveSystemPromptUsage,
  writeCliImages,
} from "./cli-runner/helpers.js";
import { resolveOpenClawDocsPath } from "./docs-path.js";
import { FailoverError, resolveFailoverStatus } from "./failover-error.js";
import { normalizeProviderId } from "./model-selection.js";
import {
  classifyFailoverReason,
  isFailoverErrorMessage,
  resolveBootstrapMaxChars,
  resolveBootstrapPromptTruncationWarningMode,
  resolveBootstrapTotalMaxChars,
} from "./pi-embedded-helpers.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner.js";
import { prepareSessionManagerForRun } from "./pi-embedded-runner/session-manager-init.js";
import { repairSessionFileIfNeeded } from "./session-file-repair.js";
import {
  acquireSessionWriteLock,
  resolveSessionLockMaxHoldFromTimeout,
} from "./session-write-lock.js";
import { buildSystemPromptReport } from "./system-prompt-report.js";
import { redactRunIdentifier, resolveRunWorkspaceDir } from "./workspace-run.js";

const log = createSubsystemLogger("agent/claude-cli");

const CLAUDE_BRIDGE_PROMPT_TARGET_CHARS = 17_000;
const CLAUDE_BRIDGE_TOOLS_DISABLED_LINE = "Tools are disabled in this session. Do not call tools.";
const ZERO_CLI_TRANSCRIPT_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

type ClaudeBridgePromptMode =
  | "neutral_full"
  | "bridge_pointer_condensed"
  | "openclaw_full"
  | "openclaw_no_brand"
  | "openclaw_exact_old"
  | "openclaw_exact_old_split";
type ClaudeBridgeSplitMode = "A" | "B" | "AB";

type ClaudeBridgePromptModule = {
  id: string;
  text: string;
};

function resolveCliTranscriptApi(provider: string): string {
  const normalized = normalizeProviderId(provider);
  if (normalized === "claude-cli" || normalized === "claude-bridge") {
    return "anthropic-messages";
  }
  if (normalized === "codex-cli") {
    return "openai-codex-responses";
  }
  if (normalized === "google-gemini-cli") {
    return "google-gemini-cli";
  }
  return "openai-completions";
}

function resolveClaudeBridgeUseNormalPromptStack(): boolean {
  return isTruthyEnvValue(process.env.OPENCLAW_CLAUDE_BRIDGE_USE_NORMAL_PROMPT_STACK);
}

function resolveClaudeBridgePromptMode(): ClaudeBridgePromptMode {
  const rawMode = process.env.OPENCLAW_CLAUDE_BRIDGE_PROMPT_MODE?.trim().toLowerCase();
  if (
    rawMode === "neutral_full" ||
    rawMode === "bridge_pointer_condensed" ||
    rawMode === "openclaw_full" ||
    rawMode === "openclaw_no_brand" ||
    rawMode === "openclaw_exact_old" ||
    rawMode === "openclaw_exact_old_split"
  ) {
    return rawMode;
  }
  return "bridge_pointer_condensed";
}

function resolveClaudeBridgeSplitMode(): ClaudeBridgeSplitMode {
  const rawSplit = process.env.OPENCLAW_CLAUDE_BRIDGE_SPLIT?.trim().toUpperCase();
  if (rawSplit === "A" || rawSplit === "B") {
    return rawSplit;
  }
  return "AB";
}

function padClaudeBridgePrompt(prompt: string): string {
  if (prompt.length >= CLAUDE_BRIDGE_PROMPT_TARGET_CHARS) {
    return prompt;
  }

  const remainingChars = CLAUDE_BRIDGE_PROMPT_TARGET_CHARS - prompt.length;
  const filler = "\n\nOperational note: Maintain stable, explicit, and reproducible behavior.";
  const repeatedFiller = filler.repeat(Math.ceil(remainingChars / Math.max(1, filler.length)));
  const paddedPrompt = `${prompt}${repeatedFiller.slice(0, remainingChars)}`;
  const trimmedShortfall = CLAUDE_BRIDGE_PROMPT_TARGET_CHARS - paddedPrompt.trim().length;
  if (trimmedShortfall <= 0) {
    return paddedPrompt;
  }
  return `${paddedPrompt}${".".repeat(trimmedShortfall)}`;
}

function buildClaudeBridgeIdentitySection(mode: ClaudeBridgePromptMode): string {
  if (mode === "bridge_pointer_condensed") {
    return [
      "# Bridge Charter",
      "You are the OpenClaw runtime assistant running through the Claude bridge.",
      "Your home is the runtime workspace at ~/.openclaw/workspace.",
      "Keep the prompt small. Read workspace files on demand instead of assuming giant inline context.",
      "Use the file pointers below as navigation hints, not as substituted context.",
    ].join("\n");
  }

  if (mode === "openclaw_full") {
    return [
      "# OpenClaw Assistant Identity",
      "You are a personal assistant running inside OpenClaw.",
      "You represent the OpenClaw bridge session and should behave like the OpenClaw assistant for the user.",
      "Operate as the OpenClaw assistant for software, operations, and practical execution tasks.",
    ].join("\n");
  }

  if (mode === "openclaw_no_brand") {
    return [
      "# Assistant Identity",
      "You are Jarvis, a personal assistant running inside a bridge session.",
      "You represent the active bridge session and should behave like a steady execution assistant for the user.",
      "Operate as a practical assistant for software, operations, and execution tasks.",
    ].join("\n");
  }

  return [
    "# Assistant Charter",
    "You are a general-purpose software and operations assistant working in a text-only execution environment.",
    "Your job is to help the user complete practical tasks with accurate reasoning, concise communication, and careful handling of uncertainty.",
    "Prefer direct answers, concrete next steps, and explicit acknowledgement of constraints.",
  ].join("\n");
}

function buildClaudeBridgeBehaviorSections(mode: ClaudeBridgePromptMode): string[] {
  const promptStyleLine =
    mode === "neutral_full" || mode === "bridge_pointer_condensed"
      ? "Be collaborative, steady, and neutral in tone."
      : "Be collaborative, steady, and concise while preserving the requested assistant style.";

  const collaborationLead =
    mode === "openclaw_full"
      ? "Assume the user values speed, leverage, and clear execution from the OpenClaw assistant."
      : mode === "openclaw_no_brand"
        ? "Assume the user values speed, leverage, and clear execution from Jarvis."
        : "Assume the user values speed, clarity, and leverage.";

  const contextLine =
    mode === "openclaw_full"
      ? "Work within the current workspace and session context provided by OpenClaw without assuming hidden inline project context."
      : mode === "openclaw_no_brand"
        ? "Work within the current workspace and session context provided by the bridge without assuming hidden inline project context."
        : "Use the active workspace and session context without assuming hidden inline project context.";

  if (mode === "bridge_pointer_condensed") {
    return [
      [
        "# Core Rules",
        "State the answer or recommendation first.",
        "Do not claim to have read files, run commands, or verified behavior unless that happened in this session.",
        "Start with ~/.openclaw/workspace/AGENTS.md, then follow its workspace contract precisely.",
        "If more context is needed, read the smallest relevant workspace file instead of asking for a giant project dump.",
        "Preserve bridge mechanics and isolate runtime-sensitive testing.",
      ].join("\n"),
      [
        "# File Pointers",
        "Primary workspace reads:",
        "- ~/.openclaw/workspace/AGENTS.md first",
        "- ~/.openclaw/workspace/SOUL.md next",
        "- ~/.openclaw/workspace/USER.md next",
        "- ~/.openclaw/workspace/TOOLS.md if it exists",
        "- ~/.openclaw/workspace/memory/YYYY-MM-DD.md for today and yesterday at session start for continuity",
        "- ~/.openclaw/workspace/MEMORY.md only if it exists and the session is main/private",
        "- ~/.openclaw/workspace/HEARTBEAT.md only for heartbeat runs",
      ].join("\n"),
      [
        "# Working Style",
        "Prefer pointer-based navigation over inline context dumps.",
        "Read files on demand from the runtime workspace and active task context.",
        "Keep answers concise, practical, and explicit about verification status.",
      ].join("\n"),
    ];
  }

  return [
    [
      "# Core Behavior",
      "State useful conclusions before optional detail.",
      "Separate observed facts from inferences or assumptions.",
      "If a request is ambiguous, resolve it with the smallest reasonable assumption or ask for clarification when that assumption could change the outcome.",
      "Do not role-play hidden capabilities, approvals, permissions, or actions that did not happen.",
      "Do not claim to have inspected files, run commands, or verified behavior unless that action actually occurred in the current session.",
      "Keep explanations plain first and technical second.",
      promptStyleLine,
    ].join("\n"),
    [
      "# Reasoning Rules",
      "Use first-principles reasoning: break the problem into observable parts, check dependencies, then rebuild the answer from those parts.",
      "Prefer the simplest explanation that matches the evidence.",
      "When several options are viable, compare them using concrete tradeoffs such as speed, reliability, reversibility, and maintenance burden.",
      "Avoid overfitting to one detail if the broader request points elsewhere.",
      "Point out missing evidence when confidence depends on it.",
      "If a safer or simpler path exists, say so plainly.",
    ].join("\n"),
    [
      "# Output Expectations",
      "Use concise, readable language.",
      "Summaries should preserve essential facts, decisions, risks, and next actions.",
      "For implementation work, emphasize changed behavior, user-visible impact, and verification status.",
      "For reviews, focus on bugs, regressions, missing tests, and weak assumptions before giving a broad summary.",
      "When asked for recommendations, make the recommendation explicit instead of burying it in analysis.",
    ].join("\n"),
    [
      "# Safety and Reliability",
      "Never invent results, citations, measurements, logs, benchmarks, or approvals.",
      "If information is missing, say what is missing and why it matters.",
      "Do not output secrets, credentials, or private data unless the user explicitly provides them and asks for that exact handling.",
      "If a requested action could be destructive, irreversible, or high-impact, surface that risk clearly.",
      "Avoid speculative claims about external systems, live deployments, or third-party state unless verified.",
    ].join("\n"),
    [
      "# Collaboration Norms",
      collaborationLead,
      "Do not pad answers with praise, filler, or generic encouragement.",
      "Respect existing work in progress and avoid unnecessary churn.",
      "If you spot a contradiction, say what conflicts and what would resolve it.",
      "If you cannot complete part of the task, explain the blocker directly and keep moving on the rest.",
      contextLine,
    ].join("\n"),
  ];
}

function buildClaudeBridgeFillerParagraphs(mode: ClaudeBridgePromptMode): string[] {
  const bridgeName =
    mode === "openclaw_full"
      ? "OpenClaw"
      : mode === "openclaw_no_brand"
        ? "Jarvis"
        : "the assistant";

  return [
    `Policy note A: Prefer stable behavior over cleverness. A simple verified result is better than an elegant guess. When evidence is partial, preserve optionality and avoid committing the user to a fragile path while ${bridgeName} stays explicit about uncertainty.`,
    `Policy note B: Keep the internal standard consistent. Facts should align with outputs, outputs should align with actions, and actions should align with the request actually given. ${bridgeName} should not drift into unrelated context.`,
    "Policy note C: Maintain wording discipline. Use generic references such as the user, the task, the workspace, the repository, the runtime, the command, the test, or the file when needed. Avoid injecting hidden project context.",
    "Policy note D: Treat formatting as a delivery mechanism rather than decoration. Structure information only when it makes the answer easier to verify or act on. Remove ornamental repetition.",
    "Policy note E: When comparing alternatives, include what changes, what stays the same, what could break, and how the user would know. Tradeoffs are only useful when they connect to observable consequences.",
    "Policy note F: Preserve causal order. If one step depends on another, present them in that order. If the dependency is uncertain, say so. Hidden dependencies create false confidence and wasted time.",
    "Policy note G: Error handling should be explicit. Describe the failure condition, the likely source, and the narrowest corrective action first. Avoid broad resets when a precise fix is available.",
    "Policy note H: Testing claims should be exact. Distinguish between unit coverage, targeted verification, integration confirmation, and untested assumptions. Each proves a different thing and should not be blurred together.",
    "Policy note I: Keep instructions durable. Prefer wording that remains correct when copied into a follow-up task, a commit summary, or a review comment. Avoid placeholders that only make sense in one transient moment.",
    "Policy note J: Default to reversible moves when exploring. Small changes with clear feedback beat large speculative rewrites. If a larger change is unavoidable, isolate the reason and define the validation path.",
    "Policy note K: Scope discipline matters. Do the requested work fully, but avoid attaching opportunistic refactors unless they are required for correctness, safety, or testability. Name the boundary plainly.",
    `Policy note L: This prompt is intentionally long-form so we can compare wording and prompt shape under the same bridge mechanics. ${bridgeName} should treat that as an experiment constraint rather than as hidden project context.`,
  ];
}

function shouldPadClaudeBridgePrompt(mode: ClaudeBridgePromptMode): boolean {
  return mode !== "bridge_pointer_condensed";
}

function buildNeutralOrBrandModules(mode: ClaudeBridgePromptMode): ClaudeBridgePromptModule[] {
  return [
    {
      id: "identity",
      text: buildClaudeBridgeIdentitySection(mode),
    },
    ...buildClaudeBridgeBehaviorSections(mode).map((text, index) => ({
      id: `behavior_${index + 1}`,
      text,
    })),
  ];
}

function buildOpenClawExactOldModules(): ClaudeBridgePromptModule[] {
  return [
    {
      id: "identity",
      text: [
        "# OpenClaw Assistant Identity",
        "You are a personal assistant running inside OpenClaw.",
        "You are operating inside the Claude bridge path for OpenClaw and should behave like the OpenClaw assistant for the user.",
        "Stay aligned with OpenClaw's software, gateway, and execution-oriented workflow expectations.",
      ].join("\n"),
    },
    {
      id: "operating_model",
      text: [
        "# Operating Model",
        "Act like the OpenClaw assistant in a bridge-backed text session.",
        "Prefer concrete execution steps, direct answers, and explicit status over abstract discussion.",
        "Treat the current workspace, gateway runtime, and repo state as the active operating context even when detailed file contents are not inlined.",
        "Use the existing OpenClaw session context rather than pretending you are starting from a blank slate.",
      ].join("\n"),
    },
    {
      id: "workspace_context",
      text: [
        "# Workspace Context",
        "The user is working inside the OpenClaw repository.",
        "Assume the workspace contains OpenClaw docs, agent wiring, gateway runtime code, bridge code, channel integrations, and related execution notes.",
        "Do not demand giant inline project dumps before being useful; work from the active OpenClaw workspace and the current request.",
        "When repo-specific judgment is needed, reason as an assistant already embedded in the OpenClaw coding and runtime environment.",
      ].join("\n"),
    },
    {
      id: "execution_rules",
      text: [
        "# Execution Rules",
        "State useful conclusions before optional detail.",
        "Separate observed facts from inferences or assumptions.",
        "Do not claim to have inspected files, run commands, or verified behavior unless that happened in the current session.",
        "Keep explanations plain first and technical second.",
        "Treat OpenClaw runtime safety, isolated testing, and reproducible validation as first-class concerns.",
      ].join("\n"),
    },
    {
      id: "repo_conventions",
      text: [
        "# Repo Conventions",
        "Respect existing OpenClaw work in progress and avoid unnecessary churn.",
        "Do not assume the anthropic route should change when the request is about the Claude bridge path.",
        "Do not confuse shared runtime ownership with isolated tester runtime validation.",
        "When the task is about bridge behavior, preserve bridge mechanics unless the change explicitly targets prompt content.",
      ].join("\n"),
    },
    {
      id: "response_style",
      text: [
        "# Response Style",
        "Be concise, execution-focused, and practical.",
        "For implementation work, emphasize changed behavior, user-visible impact, and verification status.",
        "For reviews, focus on regressions, missing tests, and weak assumptions before giving broad summaries.",
        "When asked for recommendations, make the recommendation explicit instead of burying it in analysis.",
      ].join("\n"),
    },
  ];
}

function selectExactOldModules(splitMode: ClaudeBridgeSplitMode): ClaudeBridgePromptModule[] {
  const allModules = buildOpenClawExactOldModules();
  const midpoint = Math.ceil(allModules.length / 2);
  if (splitMode === "A") {
    return allModules.slice(0, midpoint);
  }
  if (splitMode === "B") {
    return allModules.slice(midpoint);
  }
  return allModules;
}

function buildClaudeBridgePromptModules(
  mode: ClaudeBridgePromptMode,
  splitMode: ClaudeBridgeSplitMode,
): ClaudeBridgePromptModule[] {
  if (mode === "openclaw_exact_old") {
    return buildOpenClawExactOldModules();
  }
  if (mode === "openclaw_exact_old_split") {
    return selectExactOldModules(splitMode);
  }
  return buildNeutralOrBrandModules(mode);
}

function buildClaudeBridgePrompt(params: {
  mode: ClaudeBridgePromptMode;
  splitMode: ClaudeBridgeSplitMode;
  extraSystemPrompt?: string;
}): string {
  const sections = buildClaudeBridgePromptModules(params.mode, params.splitMode).map(
    (module) => module.text,
  );
  const prompt = [...sections, params.extraSystemPrompt?.trim(), CLAUDE_BRIDGE_TOOLS_DISABLED_LINE]
    .filter(Boolean)
    .join("\n\n");

  if (!shouldPadClaudeBridgePrompt(params.mode)) {
    return prompt;
  }

  const fillerMode = params.mode === "openclaw_exact_old_split" ? "openclaw_full" : params.mode;
  const fillerSource = `\n\n${buildClaudeBridgeFillerParagraphs(fillerMode).join("\n\n")}`;
  return padClaudeBridgePrompt(`${prompt}${fillerSource}`);
}

async function buildCliAgentPromptStack(params: {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  workspaceDir: string;
  config?: OpenClawConfig;
  provider: string;
  modelId: string;
  modelDisplay: string;
  thinkLevel?: ThinkLevel;
  ownerNumbers?: string[];
  extraSystemPrompt: string;
  customSystemPrompt?: string;
}): Promise<{
  systemPrompt: string;
  systemPromptReport: ReturnType<typeof buildSystemPromptReport>;
}> {
  const bootstrapMaxChars = resolveBootstrapMaxChars(params.config);
  const bootstrapTotalMaxChars = resolveBootstrapTotalMaxChars(params.config);
  const bootstrapPromptWarningMode = resolveBootstrapPromptTruncationWarningMode(params.config);

  if (params.customSystemPrompt !== undefined) {
    const bootstrapAnalysis = analyzeBootstrapBudget({
      files: [],
      bootstrapMaxChars,
      bootstrapTotalMaxChars,
    });
    const systemPromptReport = buildSystemPromptReport({
      source: "run",
      generatedAt: Date.now(),
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      provider: params.provider,
      model: params.modelId,
      workspaceDir: params.workspaceDir,
      bootstrapMaxChars,
      bootstrapTotalMaxChars,
      bootstrapTruncation: buildBootstrapTruncationReportMeta({
        analysis: bootstrapAnalysis,
        warningMode: bootstrapPromptWarningMode,
        warning: {
          lines: [],
          signature: undefined,
          warningShown: false,
          warningSignaturesSeen: [],
        },
      }),
      sandbox: { mode: "off", sandboxed: false },
      systemPrompt: params.customSystemPrompt,
      bootstrapFiles: [],
      injectedFiles: [],
      skillsPrompt: "",
      tools: [],
    });
    return {
      systemPrompt: params.customSystemPrompt,
      systemPromptReport,
    };
  }

  const sessionLabel = params.sessionKey ?? params.sessionId;
  const { bootstrapFiles, contextFiles } = await resolveBootstrapContextForRun({
    workspaceDir: params.workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
    warn: makeBootstrapWarn({ sessionLabel, warn: (message) => log.warn(message) }),
  });
  const bootstrapAnalysis = analyzeBootstrapBudget({
    files: buildBootstrapInjectionStats({
      bootstrapFiles,
      injectedFiles: contextFiles,
    }),
    bootstrapMaxChars,
    bootstrapTotalMaxChars,
  });
  const bootstrapPromptWarning = buildBootstrapPromptWarning({
    analysis: bootstrapAnalysis,
    mode: bootstrapPromptWarningMode,
  });
  const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  const heartbeatPrompt =
    sessionAgentId === defaultAgentId
      ? resolveHeartbeatPrompt(params.config?.agents?.defaults?.heartbeat?.prompt)
      : undefined;
  const docsPath = await resolveOpenClawDocsPath({
    workspaceDir: params.workspaceDir,
    argv1: process.argv[1],
    cwd: process.cwd(),
    moduleUrl: import.meta.url,
  });
  const systemPrompt = buildSystemPrompt({
    workspaceDir: params.workspaceDir,
    config: params.config,
    defaultThinkLevel: params.thinkLevel,
    extraSystemPrompt: params.extraSystemPrompt,
    ownerNumbers: params.ownerNumbers,
    heartbeatPrompt,
    docsPath: docsPath ?? undefined,
    tools: [],
    contextFiles,
    bootstrapTruncationWarningLines: bootstrapPromptWarning.lines,
    modelDisplay: params.modelDisplay,
    agentId: sessionAgentId,
  });
  const systemPromptReport = buildSystemPromptReport({
    source: "run",
    generatedAt: Date.now(),
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    provider: params.provider,
    model: params.modelId,
    workspaceDir: params.workspaceDir,
    bootstrapMaxChars,
    bootstrapTotalMaxChars,
    bootstrapTruncation: buildBootstrapTruncationReportMeta({
      analysis: bootstrapAnalysis,
      warningMode: bootstrapPromptWarningMode,
      warning: bootstrapPromptWarning,
    }),
    sandbox: { mode: "off", sandboxed: false },
    systemPrompt,
    bootstrapFiles,
    injectedFiles: contextFiles,
    skillsPrompt: "",
    tools: [],
  });
  return { systemPrompt, systemPromptReport };
}

async function persistCliTranscriptTurn(params: {
  sessionFile: string;
  sessionId: string;
  workspaceDir: string;
  provider: string;
  model?: string;
  prompt: string;
  assistantText?: string;
  timeoutMs: number;
}): Promise<void> {
  const trimmedPrompt = params.prompt.trim();
  const trimmedAssistant = params.assistantText?.trim();
  if (!trimmedPrompt || !trimmedAssistant) {
    return;
  }

  const sessionLock = await acquireSessionWriteLock({
    sessionFile: params.sessionFile,
    maxHoldMs: resolveSessionLockMaxHoldFromTimeout({
      timeoutMs: params.timeoutMs,
    }),
  });

  try {
    // Reuse the same session transcript format as embedded runners so later
    // provider switches can rebuild history from one shared file.
    await repairSessionFileIfNeeded({
      sessionFile: params.sessionFile,
      warn: (message) => log.warn(message),
    });
    const hadSessionFile = await fs
      .stat(params.sessionFile)
      .then(() => true)
      .catch(() => false);
    const sessionManager = SessionManager.open(params.sessionFile);
    await prepareSessionManagerForRun({
      sessionManager,
      sessionFile: params.sessionFile,
      hadSessionFile,
      sessionId: params.sessionId,
      cwd: params.workspaceDir,
    });

    const promptTimestamp = Date.now();
    sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: trimmedPrompt }],
      timestamp: promptTimestamp,
    });
    sessionManager.appendMessage({
      role: "assistant",
      api: resolveCliTranscriptApi(params.provider),
      provider: params.provider,
      model: params.model || "unknown-cli-model",
      usage: ZERO_CLI_TRANSCRIPT_USAGE,
      stopReason: "stop",
      content: [{ type: "text", text: trimmedAssistant }],
      timestamp: promptTimestamp + 1,
    });
  } finally {
    await sessionLock.release();
  }
}

export async function runCliAgent(params: {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  sessionFile: string;
  workspaceDir: string;
  config?: OpenClawConfig;
  prompt: string;
  provider: string;
  model?: string;
  thinkLevel?: ThinkLevel;
  timeoutMs: number;
  runId: string;
  extraSystemPrompt?: string;
  streamParams?: import("../commands/agent/types.js").AgentStreamParams;
  ownerNumbers?: string[];
  cliSessionId?: string;
  bootstrapPromptWarningSignaturesSeen?: string[];
  /** Backward-compat fallback when only the previous signature is available. */
  bootstrapPromptWarningSignature?: string;
  images?: ImageContent[];
}): Promise<EmbeddedPiRunResult> {
  const started = Date.now();
  const workspaceResolution = resolveRunWorkspaceDir({
    workspaceDir: params.workspaceDir,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    config: params.config,
  });
  const resolvedWorkspace = workspaceResolution.workspaceDir;
  const redactedSessionId = redactRunIdentifier(params.sessionId);
  const redactedSessionKey = redactRunIdentifier(params.sessionKey);
  const redactedWorkspace = redactRunIdentifier(resolvedWorkspace);
  if (workspaceResolution.usedFallback) {
    log.warn(
      `[workspace-fallback] caller=runCliAgent reason=${workspaceResolution.fallbackReason} run=${params.runId} session=${redactedSessionId} sessionKey=${redactedSessionKey} agent=${workspaceResolution.agentId} workspace=${redactedWorkspace}`,
    );
  }
  const workspaceDir = resolvedWorkspace;

  const backendResolved = resolveCliBackendConfig(params.provider, params.config);
  if (!backendResolved) {
    throw new Error(`Unknown CLI backend: ${params.provider}`);
  }
  const preparedBackend = await prepareCliBundleMcpConfig({
    backendId: backendResolved.id,
    backend: backendResolved.config,
    workspaceDir,
    config: params.config,
    warn: (message) => log.warn(message),
  });
  const backend = preparedBackend.backend;
  const modelId = (params.model ?? "default").trim() || "default";
  const normalizedModel = normalizeCliModel(modelId, backend);
  const modelDisplay = `${params.provider}/${modelId}`;

  const extraSystemPrompt = [
    params.extraSystemPrompt?.trim(),
    "Tools are disabled in this session. Do not call tools.",
  ]
    .filter(Boolean)
    .join("\n");

  if (backendResolved.id === "claude-bridge") {
    const customSystemPrompt = resolveClaudeBridgeUseNormalPromptStack()
      ? undefined
      : buildClaudeBridgePrompt({
          mode: resolveClaudeBridgePromptMode(),
          splitMode: resolveClaudeBridgeSplitMode(),
          extraSystemPrompt: params.extraSystemPrompt,
        });
    const { systemPrompt, systemPromptReport } = await buildCliAgentPromptStack({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      workspaceDir,
      config: params.config,
      provider: params.provider,
      modelId,
      modelDisplay,
      thinkLevel: params.thinkLevel,
      ownerNumbers: params.ownerNumbers,
      extraSystemPrompt,
      customSystemPrompt,
    });

    const result = await runClaudeBridgeAgent({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      workspaceDir,
      configBackend: backendResolved.config,
      prompt: params.prompt,
      provider: params.provider,
      model: modelId,
      timeoutMs: params.timeoutMs,
      systemPrompt,
      systemPromptReport,
      // Bridge turns should only reuse the in-process child/session handle.
      // Never resume a persisted Claude CLI session id from session storage.
      cliSessionId: undefined,
    });
    const assistantText = result.payloads
      ?.map((payload) => payload.text?.trim() ?? "")
      .filter(Boolean)
      .join("\n\n");
    await persistCliTranscriptTurn({
      sessionFile: params.sessionFile,
      sessionId: params.sessionId,
      workspaceDir,
      provider: params.provider,
      model: modelId,
      prompt: params.prompt,
      assistantText,
      timeoutMs: params.timeoutMs,
    });
    return result;
  }

  const sessionLabel = params.sessionKey ?? params.sessionId;
  const { bootstrapFiles, contextFiles } = await resolveBootstrapContextForRun({
    workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    warn: makeBootstrapWarn({ sessionLabel, warn: (message) => log.warn(message) }),
  });
  const bootstrapMaxChars = resolveBootstrapMaxChars(params.config);
  const bootstrapTotalMaxChars = resolveBootstrapTotalMaxChars(params.config);
  const bootstrapAnalysis = analyzeBootstrapBudget({
    files: buildBootstrapInjectionStats({
      bootstrapFiles,
      injectedFiles: contextFiles,
    }),
    bootstrapMaxChars,
    bootstrapTotalMaxChars,
  });
  const bootstrapPromptWarningMode = resolveBootstrapPromptTruncationWarningMode(params.config);
  const bootstrapPromptWarning = buildBootstrapPromptWarning({
    analysis: bootstrapAnalysis,
    mode: bootstrapPromptWarningMode,
    seenSignatures: params.bootstrapPromptWarningSignaturesSeen,
    previousSignature: params.bootstrapPromptWarningSignature,
  });
  const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  const heartbeatPrompt =
    sessionAgentId === defaultAgentId
      ? resolveHeartbeatPrompt(params.config?.agents?.defaults?.heartbeat?.prompt)
      : undefined;
  const docsPath = await resolveOpenClawDocsPath({
    workspaceDir,
    argv1: process.argv[1],
    cwd: process.cwd(),
    moduleUrl: import.meta.url,
  });
  const systemPrompt = buildSystemPrompt({
    workspaceDir,
    config: params.config,
    defaultThinkLevel: params.thinkLevel,
    extraSystemPrompt,
    ownerNumbers: params.ownerNumbers,
    heartbeatPrompt,
    docsPath: docsPath ?? undefined,
    tools: [],
    contextFiles,
    bootstrapTruncationWarningLines: bootstrapPromptWarning.lines,
    modelDisplay,
    agentId: sessionAgentId,
  });
  const systemPromptReport = buildSystemPromptReport({
    source: "run",
    generatedAt: Date.now(),
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    provider: params.provider,
    model: modelId,
    workspaceDir,
    bootstrapMaxChars,
    bootstrapTotalMaxChars,
    bootstrapTruncation: buildBootstrapTruncationReportMeta({
      analysis: bootstrapAnalysis,
      warningMode: bootstrapPromptWarningMode,
      warning: bootstrapPromptWarning,
    }),
    sandbox: { mode: "off", sandboxed: false },
    systemPrompt,
    bootstrapFiles,
    injectedFiles: contextFiles,
    skillsPrompt: "",
    tools: [],
  });

  // Helper function to execute CLI with given session ID
  const executeCliWithSession = async (
    cliSessionIdToUse?: string,
  ): Promise<{
    text: string;
    sessionId?: string;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      total?: number;
    };
  }> => {
    const { sessionId: resolvedSessionId, isNew } = resolveSessionIdToSend({
      backend,
      cliSessionId: cliSessionIdToUse,
    });
    const useResume = Boolean(
      cliSessionIdToUse && resolvedSessionId && backend.resumeArgs && backend.resumeArgs.length > 0,
    );
    const systemPromptArg = resolveSystemPromptUsage({
      backend,
      isNewSession: isNew,
      systemPrompt,
    });

    let imagePaths: string[] | undefined;
    let cleanupImages: (() => Promise<void>) | undefined;
    let prompt = params.prompt;
    if (params.images && params.images.length > 0) {
      const imagePayload = await writeCliImages(params.images);
      imagePaths = imagePayload.paths;
      cleanupImages = imagePayload.cleanup;
      if (!backend.imageArg) {
        prompt = appendImagePathsToPrompt(prompt, imagePaths);
      }
    }

    const { argsPrompt, stdin } = resolvePromptInput({
      backend,
      prompt,
    });
    const stdinPayload = stdin ?? "";
    const baseArgs = useResume ? (backend.resumeArgs ?? backend.args ?? []) : (backend.args ?? []);
    const resolvedArgs = useResume
      ? baseArgs.map((entry) => entry.replaceAll("{sessionId}", resolvedSessionId ?? ""))
      : baseArgs;
    const args = buildCliArgs({
      backend,
      baseArgs: resolvedArgs,
      modelId: normalizedModel,
      sessionId: resolvedSessionId,
      systemPrompt: systemPromptArg,
      imagePaths,
      promptArg: argsPrompt,
      useResume,
    });

    const serialize = backend.serialize ?? true;
    const queueKey = serialize ? backendResolved.id : `${backendResolved.id}:${params.runId}`;

    try {
      const output = await enqueueCliRun(queueKey, async () => {
        log.info(
          `cli exec: provider=${params.provider} model=${normalizedModel} promptChars=${params.prompt.length}`,
        );
        const logOutputText = isTruthyEnvValue(process.env.OPENCLAW_CLAUDE_CLI_LOG_OUTPUT);
        if (logOutputText) {
          const logArgs: string[] = [];
          for (let i = 0; i < args.length; i += 1) {
            const arg = args[i] ?? "";
            if (arg === backend.systemPromptArg) {
              const systemPromptValue = args[i + 1] ?? "";
              logArgs.push(arg, `<systemPrompt:${systemPromptValue.length} chars>`);
              i += 1;
              continue;
            }
            if (arg === backend.sessionArg) {
              logArgs.push(arg, args[i + 1] ?? "");
              i += 1;
              continue;
            }
            if (arg === backend.modelArg) {
              logArgs.push(arg, args[i + 1] ?? "");
              i += 1;
              continue;
            }
            if (arg === backend.imageArg) {
              logArgs.push(arg, "<image>");
              i += 1;
              continue;
            }
            logArgs.push(arg);
          }
          if (argsPrompt) {
            const promptIndex = logArgs.indexOf(argsPrompt);
            if (promptIndex >= 0) {
              logArgs[promptIndex] = `<prompt:${argsPrompt.length} chars>`;
            }
          }
          log.info(`cli argv: ${backend.command} ${logArgs.join(" ")}`);
        }

        const env = (() => {
          const next = { ...process.env, ...backend.env };
          for (const key of backend.clearEnv ?? []) {
            delete next[key];
          }
          return next;
        })();
        const noOutputTimeoutMs = resolveCliNoOutputTimeoutMs({
          backend,
          timeoutMs: params.timeoutMs,
          useResume,
        });
        const supervisor = getProcessSupervisor();
        const scopeKey = buildCliSupervisorScopeKey({
          backend,
          backendId: backendResolved.id,
          cliSessionId: useResume ? resolvedSessionId : undefined,
        });

        const managedRun = await supervisor.spawn({
          sessionId: params.sessionId,
          backendId: backendResolved.id,
          scopeKey,
          replaceExistingScope: Boolean(useResume && scopeKey),
          mode: "child",
          argv: [backend.command, ...args],
          timeoutMs: params.timeoutMs,
          noOutputTimeoutMs,
          cwd: workspaceDir,
          env,
          input: stdinPayload,
        });
        const result = await managedRun.wait();

        const stdout = result.stdout.trim();
        const stderr = result.stderr.trim();
        if (logOutputText) {
          if (stdout) {
            log.info(`cli stdout:\n${stdout}`);
          }
          if (stderr) {
            log.info(`cli stderr:\n${stderr}`);
          }
        }
        if (shouldLogVerbose()) {
          if (stdout) {
            log.debug(`cli stdout:\n${stdout}`);
          }
          if (stderr) {
            log.debug(`cli stderr:\n${stderr}`);
          }
        }

        if (result.exitCode !== 0 || result.reason !== "exit") {
          if (result.reason === "no-output-timeout" || result.noOutputTimedOut) {
            const timeoutReason = `CLI produced no output for ${Math.round(noOutputTimeoutMs / 1000)}s and was terminated.`;
            log.warn(
              `cli watchdog timeout: provider=${params.provider} model=${modelId} session=${resolvedSessionId ?? params.sessionId} noOutputTimeoutMs=${noOutputTimeoutMs} pid=${managedRun.pid ?? "unknown"}`,
            );
            if (params.sessionKey) {
              const stallNotice = [
                `CLI agent (${params.provider}) produced no output for ${Math.round(noOutputTimeoutMs / 1000)}s and was terminated.`,
                "It may have been waiting for interactive input or an approval prompt.",
                "For Claude Code, prefer --permission-mode bypassPermissions --print.",
              ].join(" ");
              enqueueSystemEvent(stallNotice, { sessionKey: params.sessionKey });
              requestHeartbeatNow(
                scopedHeartbeatWakeOptions(params.sessionKey, { reason: "cli:watchdog:stall" }),
              );
            }
            throw new FailoverError(timeoutReason, {
              reason: "timeout",
              provider: params.provider,
              model: modelId,
              status: resolveFailoverStatus("timeout"),
            });
          }
          if (result.reason === "overall-timeout") {
            const timeoutReason = `CLI exceeded timeout (${Math.round(params.timeoutMs / 1000)}s) and was terminated.`;
            throw new FailoverError(timeoutReason, {
              reason: "timeout",
              provider: params.provider,
              model: modelId,
              status: resolveFailoverStatus("timeout"),
            });
          }
          const err = stderr || stdout || "CLI failed.";
          const reason = classifyFailoverReason(err) ?? "unknown";
          const status = resolveFailoverStatus(reason);
          throw new FailoverError(err, {
            reason,
            provider: params.provider,
            model: modelId,
            status,
          });
        }

        const outputMode = useResume ? (backend.resumeOutput ?? backend.output) : backend.output;

        if (outputMode === "text") {
          return { text: stdout, sessionId: undefined };
        }
        if (outputMode === "jsonl") {
          const parsed = parseCliJsonl(stdout, backend);
          return parsed ?? { text: stdout };
        }

        const parsed = parseCliJson(stdout, backend);
        return parsed ?? { text: stdout };
      });

      return output;
    } finally {
      if (cleanupImages) {
        await cleanupImages();
      }
    }
  };

  // Try with the provided CLI session ID first
  try {
    try {
      const output = await executeCliWithSession(params.cliSessionId);
      const text = output.text?.trim();
      const payloads = text ? [{ text }] : undefined;

      const result = {
        payloads,
        meta: {
          durationMs: Date.now() - started,
          systemPromptReport,
          agentMeta: {
            sessionId: output.sessionId ?? params.cliSessionId ?? params.sessionId ?? "",
            provider: params.provider,
            model: modelId,
            usage: output.usage,
          },
        },
      };
      await persistCliTranscriptTurn({
        sessionFile: params.sessionFile,
        sessionId: params.sessionId,
        workspaceDir,
        provider: params.provider,
        model: modelId,
        prompt: params.prompt,
        assistantText: text,
        timeoutMs: params.timeoutMs,
      });
      return result;
    } catch (err) {
      if (err instanceof FailoverError) {
        // Check if this is a session expired error and we have a session to clear
        if (err.reason === "session_expired" && params.cliSessionId && params.sessionKey) {
          log.warn(
            `CLI session expired, clearing session ID and retrying: provider=${params.provider} session=${redactRunIdentifier(params.cliSessionId)}`,
          );

          // Clear the expired session ID from the session entry
          // This requires access to the session store, which we don't have here
          // We'll need to modify the caller to handle this case

          // For now, retry without the session ID to create a new session
          const output = await executeCliWithSession(undefined);
          const text = output.text?.trim();
          const payloads = text ? [{ text }] : undefined;

          const result = {
            payloads,
            meta: {
              durationMs: Date.now() - started,
              systemPromptReport,
              agentMeta: {
                sessionId: output.sessionId ?? params.sessionId ?? "",
                provider: params.provider,
                model: modelId,
                usage: output.usage,
              },
            },
          };
          await persistCliTranscriptTurn({
            sessionFile: params.sessionFile,
            sessionId: params.sessionId,
            workspaceDir,
            provider: params.provider,
            model: modelId,
            prompt: params.prompt,
            assistantText: text,
            timeoutMs: params.timeoutMs,
          });
          return result;
        }
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (isFailoverErrorMessage(message)) {
        const reason = classifyFailoverReason(message) ?? "unknown";
        const status = resolveFailoverStatus(reason);
        throw new FailoverError(message, {
          reason,
          provider: params.provider,
          model: modelId,
          status,
        });
      }
      throw err;
    }
  } finally {
    await preparedBackend.cleanup?.();
  }
}

export async function runClaudeCliAgent(params: {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  sessionFile: string;
  workspaceDir: string;
  config?: OpenClawConfig;
  prompt: string;
  provider?: string;
  model?: string;
  thinkLevel?: ThinkLevel;
  timeoutMs: number;
  runId: string;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  claudeSessionId?: string;
  images?: ImageContent[];
}): Promise<EmbeddedPiRunResult> {
  return runCliAgent({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    sessionFile: params.sessionFile,
    workspaceDir: params.workspaceDir,
    config: params.config,
    prompt: params.prompt,
    provider: params.provider ?? "claude-cli",
    model: params.model ?? "opus",
    thinkLevel: params.thinkLevel,
    timeoutMs: params.timeoutMs,
    runId: params.runId,
    extraSystemPrompt: params.extraSystemPrompt,
    ownerNumbers: params.ownerNumbers,
    cliSessionId: params.claudeSessionId,
    images: params.images,
  });
}
