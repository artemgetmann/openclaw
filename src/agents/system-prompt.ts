import { createHmac, createHash } from "node:crypto";
import type { ReasoningLevel, ThinkLevel } from "../auto-reply/thinking.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { SourceReplyDeliveryMode } from "../auto-reply/types.js";
import type { MemoryCitationsMode } from "../config/types.memory.js";
import { listDeliverableMessageChannels } from "../utils/message-channel.js";
import type { ResolvedTimeFormat } from "./date-time.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import type { EmbeddedSandboxInfo } from "./pi-embedded-runner/types.js";
import { sanitizeForPromptLiteral } from "./sanitize-for-prompt.js";
import { DURABLE_PLAN_FILE_POLICY_PROMPT } from "./tools/durable-plan-file-policy.js";

/**
 * Controls which hardcoded sections are included in the system prompt.
 * - "full": All sections (default, for main agent)
 * - "minimal": Reduced sections (Tooling, Workspace, Runtime) - used for subagents
 * - "none": Just basic identity line, no sections
 */
export type PromptMode = "full" | "minimal" | "none";
type OwnerIdDisplay = "raw" | "hash";

export function buildPendingRestartConfirmationPromptHint(): string {
  return [
    "A pending restart confirmation exists for this session.",
    "Do not call `restart.request_confirmation` again while this pending confirmation exists.",
    "You may only proceed with restart-capable gateway actions (`restart`, `config.apply`, `config.patch`, `update.run`, `app.update.install`) if the current user turn clearly confirms the restart-capable action you asked about.",
    "If the user is ambiguous, asks a different question, or does not clearly confirm, do not restart; ask again.",
    "Do not treat your own prior message, older user messages, or generic restart chatter as confirmation.",
    'When you need to ask first, use: "This will interrupt other tasks that you have running in other chats. Restart now?"',
  ].join("\n");
}

function buildSkillsSection(params: { skillsPrompt?: string; readToolName: string }) {
  const trimmed = params.skillsPrompt?.trim();
  if (!trimmed) {
    return [];
  }
  return [
    "## Skills (mandatory)",
    "Before replying: scan <available_skills> <description> entries.",
    `- If exactly one skill clearly applies: read its SKILL.md at <location> with \`${params.readToolName}\`, then follow it before any generic discovery.`,
    "- If multiple could apply: choose the most specific one, then read/follow it.",
    "- If none clearly apply: do not read any SKILL.md.",
    "Constraints: never read more than one skill up front; only read after selecting.",
    "- When a skill drives external API writes, assume rate limits: prefer fewer larger writes, avoid tight one-item loops, serialize bursts when possible, and respect 429/Retry-After.",
    trimmed,
    "- Use <available_skills> as the active agent catalog. When it is compacted, match against its names and exact locations even when descriptions are absent. If it is truncated or an explicitly named skill is absent, do not claim the skill is unavailable; say the active catalog is incomplete instead of querying a different agent's inventory.",
    "",
  ];
}

function buildMemorySection(params: {
  isMinimal: boolean;
  availableTools: Set<string>;
  citationsMode?: MemoryCitationsMode;
}) {
  if (params.isMinimal) {
    return [];
  }
  if (!params.availableTools.has("memory_search") && !params.availableTools.has("memory_get")) {
    return [];
  }
  const lines = [
    "## Memory Recall",
    "Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search on MEMORY.md + memory/*.md; then use memory_get to pull only the needed lines. If low confidence after search, say you checked.",
  ];
  if (params.citationsMode === "off") {
    lines.push(
      "Citations are disabled: do not mention file paths or line numbers in replies unless the user explicitly asks.",
    );
  } else {
    lines.push(
      "Citations: include Source: <path#line> when it helps the user verify memory snippets.",
    );
  }
  lines.push("");
  return lines;
}

function buildUserIdentitySection(ownerLine: string | undefined, isMinimal: boolean) {
  if (!ownerLine || isMinimal) {
    return [];
  }
  return ["## Authorized Senders", ownerLine, ""];
}

function formatOwnerDisplayId(ownerId: string, ownerDisplaySecret?: string) {
  const hasSecret = ownerDisplaySecret?.trim();
  const digest = hasSecret
    ? createHmac("sha256", hasSecret).update(ownerId).digest("hex")
    : createHash("sha256").update(ownerId).digest("hex");
  return digest.slice(0, 12);
}

function buildOwnerIdentityLine(
  ownerNumbers: string[],
  ownerDisplay: OwnerIdDisplay,
  ownerDisplaySecret?: string,
) {
  const normalized = ownerNumbers.map((value) => value.trim()).filter(Boolean);
  if (normalized.length === 0) {
    return undefined;
  }
  const displayOwnerNumbers =
    ownerDisplay === "hash"
      ? normalized.map((ownerId) => formatOwnerDisplayId(ownerId, ownerDisplaySecret))
      : normalized;
  return `Authorized senders: ${displayOwnerNumbers.join(", ")}. These senders are allowlisted; do not assume they are the owner.`;
}

function buildTimeSection(params: { userTimezone?: string }) {
  if (!params.userTimezone) {
    return [];
  }
  return ["## Current Date & Time", `Time zone: ${params.userTimezone}`, ""];
}

function buildTemporalGroundingSection(params: { canUseSessionStatus: boolean }) {
  // Keep this contract static: current time remains tool-provided so prompt caches stay reusable.
  return [
    "## Temporal Grounding",
    "When interpreting, summarizing, prioritizing, or drafting from external messages, treat each source timestamp as semantic context.",
    params.canUseSessionStatus
      ? "When recency matters, compare it with trusted current time; if current time is unavailable, get it from session_status."
      : "When recency matters and trusted current time is unavailable, state that recency cannot be verified; do not guess.",
    "Resolve today, tomorrow, yesterday, and weekdays relative to when the source message was sent; never present stale relative language as current.",
    "Use the sender's timezone when known; otherwise use the user's timezone. If the timezone would materially change the date or deadline, flag material ambiguity instead of guessing.",
    "When surfacing or quoting an actionable external message, include its absolute source date. If its timestamp is missing, say timing is unknown; do not invent it.",
    "",
  ];
}

function buildReplyTagsSection(isMinimal: boolean) {
  if (isMinimal) {
    return [];
  }
  return [
    "## Reply Tags",
    "To request a native reply/quote on supported surfaces, include one tag in your reply:",
    "- Reply tags must be the very first token in the message (no leading text/newlines): [[reply_to_current]] your reply.",
    "- [[reply_to_current]] replies to the triggering message.",
    "- Prefer [[reply_to_current]]. Use [[reply_to:<id>]] only when an id was explicitly provided (e.g. by the user or a tool).",
    "Whitespace inside the tag is allowed (e.g. [[ reply_to_current ]] / [[ reply_to: 123 ]]).",
    "Tags are stripped before sending; support depends on the current channel config.",
    "",
  ];
}

function buildMessagingSection(params: {
  isMinimal: boolean;
  availableTools: Set<string>;
  messageChannelOptions: string;
  inlineButtonsEnabled: boolean;
  runtimeChannel?: string;
  messageToolHints?: string[];
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
}) {
  if (params.isMinimal) {
    return [];
  }
  const messageToolOnly = params.sourceReplyDeliveryMode === "message_tool_only";
  return [
    "## Messaging",
    messageToolOnly
      ? "- Reply in current session → private to this run; use the message tool for visible source-channel replies."
      : "- Reply in current session → automatically routes to the source channel (Signal, Telegram, etc.)",
    "- Cross-session messaging → use sessions_send(sessionKey, message)",
    "- Sub-agent orchestration → use subagents(action=list|steer|kill)",
    `- Runtime-generated completion events may ask for a user update. Rewrite those in your normal assistant voice and send the update (do not forward raw internal metadata or default to ${SILENT_REPLY_TOKEN}).`,
    "- Never use exec/curl for provider messaging; OpenClaw handles all routing internally.",
    params.availableTools.has("message")
      ? [
          "",
          "### message tool",
          "- Use `message` for proactive sends + channel actions (polls, reactions, etc.).",
          messageToolOnly
            ? "- For `action=send`, include `message`. The target defaults to the current source channel; include `target` only when sending somewhere else."
            : "- For `action=send`, include `to` and `message`.",
          `- If multiple channels are configured, pass \`channel\` (${params.messageChannelOptions}).`,
          messageToolOnly
            ? "- If you use `message` (`action=send`) to deliver visible output, do not repeat that visible content in your final answer; final answers are private in this mode."
            : `- If you use \`message\` (\`action=send\`) to deliver your user-visible reply, respond with ONLY: ${SILENT_REPLY_TOKEN} (avoid duplicate replies).`,
          params.inlineButtonsEnabled
            ? "- Inline buttons supported. Use `action=send` with `buttons=[[{text,callback_data,style?}]]`; `style` can be `primary`, `success`, or `danger`."
            : params.runtimeChannel
              ? `- Inline buttons not enabled for ${params.runtimeChannel}. If you need them, ask to set ${params.runtimeChannel}.capabilities.inlineButtons ("dm"|"group"|"all"|"allowlist").`
              : "",
          ...(params.messageToolHints ?? []),
        ]
          .filter(Boolean)
          .join("\n")
      : "",
    "",
  ];
}

function buildGoalModeSection(params: {
  isMinimal: boolean;
  availableTools: Set<string>;
  hasGoalModeSkill: boolean;
}) {
  if (params.isMinimal) {
    return [];
  }
  const hasGoalTools =
    params.availableTools.has("get_goal") &&
    params.availableTools.has("create_goal") &&
    params.availableTools.has("update_goal");
  if (!hasGoalTools) {
    return [];
  }
  return [
    "## Goal Tools",
    "Goal tools manage durable, user-approved session goals. For goal-mode behavior, use the `goal-mode` skill from <available_skills> when present instead of relying on inline prompt rules.",
    "Use /goal as a recovery/control surface; do not make slash commands the primary consumer UX.",
    ...(params.availableTools.has("monitor") && params.hasGoalModeSkill
      ? [
          "When a request implies a delayed, multi-step external outcome, or after an external action whose useful next step depends on a later reply/status, read `goal-mode` early enough to offer or use a `goal` in the same turn (even if another skill handles the action). Before offering autonomous handling, verify active skills/tools cover the required external actions; goal/monitor tools alone provide continuation, not action capability. Otherwise offer tracking/planning only and state the manual step. Ask at most one high-value missing boundary while showing the complete proposed authority scope; if end-to-end handling and sufficient limits are already authorized, create or use the goal and proceed without asking again. Skip trivial one-shot work and casual sends.",
          "Do authorized read-only follow-up automatically. When the user asked to be notified about a reply/status, include the reply or relevant content instead of merely announcing it and asking whether to fetch it.",
        ]
      : []),
    "",
  ];
}

function buildMessageDraftingSection(params: {
  hasMessageDraftingSkill: boolean;
  readToolName: string;
}) {
  if (!params.hasMessageDraftingSkill) {
    return [];
  }
  return [
    "## Recipient-Facing Drafts",
    `Before composing, revising, or sending text to another person, read \`message-drafting\` with \`${params.readToolName}\` and follow it, even if a channel skill or autonomous monitor handles the action. This is a required late-read and may load one applicable user voice profile as a dependency.`,
    "",
  ];
}

function buildVoiceSection(params: { isMinimal: boolean; ttsHint?: string }) {
  if (params.isMinimal) {
    return [];
  }
  const hint = params.ttsHint?.trim();
  if (!hint) {
    return [];
  }
  return ["## Voice (TTS)", hint, ""];
}

function buildDocsSection(params: { docsPath?: string; isMinimal: boolean; readToolName: string }) {
  const docsPath = params.docsPath?.trim();
  if (!docsPath || params.isMinimal) {
    return [];
  }
  return [
    "## Documentation",
    `OpenClaw docs: ${docsPath}`,
    "Mirror: https://docs.openclaw.ai",
    "Source: https://github.com/openclaw/openclaw",
    "Community: https://discord.com/invite/clawd",
    "Find new skills: https://clawhub.com",
    "For OpenClaw behavior, commands, config, or architecture: consult local docs first.",
    "When diagnosing issues, run `openclaw status` yourself when possible; only ask the user if you lack access (e.g., sandboxed).",
    "",
  ];
}

export function buildAgentSystemPrompt(params: {
  workspaceDir: string;
  defaultThinkLevel?: ThinkLevel;
  reasoningLevel?: ReasoningLevel;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  ownerDisplay?: OwnerIdDisplay;
  ownerDisplaySecret?: string;
  reasoningTagHint?: boolean;
  toolNames?: string[];
  toolSummaries?: Record<string, string>;
  modelAliasLines?: string[];
  userTimezone?: string;
  userTime?: string;
  userTimeFormat?: ResolvedTimeFormat;
  contextFiles?: EmbeddedContextFile[];
  bootstrapTruncationWarningLines?: string[];
  skillsPrompt?: string;
  heartbeatPrompt?: string;
  docsPath?: string;
  workspaceNotes?: string[];
  ttsHint?: string;
  /** Controls which hardcoded sections to include. Defaults to "full". */
  promptMode?: PromptMode;
  /** Whether ACP-specific routing guidance should be included. Defaults to true. */
  acpEnabled?: boolean;
  /** Keep packaged Jarvis on its selected Chrome account plus explicit live Chrome only. */
  jarvisBrowserPolicy?: boolean;
  runtimeInfo?: {
    agentId?: string;
    host?: string;
    os?: string;
    arch?: string;
    node?: string;
    model?: string;
    defaultModel?: string;
    shell?: string;
    channel?: string;
    capabilities?: string[];
    repoRoot?: string;
  };
  messageToolHints?: string[];
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  sandboxInfo?: EmbeddedSandboxInfo;
  /** Reaction guidance for the agent (for Telegram minimal/extensive modes). */
  reactionGuidance?: {
    level: "minimal" | "extensive";
    channel: string;
  };
  memoryCitationsMode?: MemoryCitationsMode;
}) {
  const acpEnabled = params.acpEnabled !== false;
  const sandboxedRuntime = params.sandboxInfo?.enabled === true;
  const acpSpawnRuntimeEnabled = acpEnabled && !sandboxedRuntime;
  const cronToolSummary =
    "Manage scheduled tasks, reminders, and wake events through the cron scheduler (use reminder or scheduled task for one-time/generic scheduling; use monitor or monitoring for a watched inbox, thread, person, or condition until something changes; never call a consumer-facing monitor a cron job; when creating a monitor, prefer a clear cadence, stop condition, and expiry instead of an indefinite forever-job; for channel-specific monitors, use the relevant skill/helper script for detection instead of ad hoc raw CLI discovery; if a skill exposes a default helper/check command, pin that exact command or a tiny wrapper script into the scheduler payload so wake runs are deterministic rather than rediscovering monitor logic each time; if the monitor needs baseline/state comparison, create the tiny check script at authoring time and have wake runs execute that script instead of improvising fresh sync/list/search logic; use heartbeat only for optional broad low-frequency awareness)";
  const coreToolSummaries: Record<string, string> = {
    read: "Read file contents",
    write: "Create or overwrite files",
    edit: "Make precise edits to files",
    apply_patch: "Apply multi-file patches",
    grep: "Search file contents for patterns",
    find: "Find files by glob pattern",
    ls: "List directory contents",
    exec: "Run shell commands (pty available for TTY-required CLIs)",
    process: "Manage background exec sessions",
    web_search: "Search the web (Brave API)",
    web_fetch: "Fetch and extract readable content from a URL",
    // Channel docking: add login tools here when a channel needs interactive linking.
    browser: params.jarvisBrowserPolicy
      ? 'Control browser; use the selected Chrome account for normal work and the live Chrome session only when current tabs or extensions are required; if the selected account is unavailable, repair it or explain the blocker without offering another browser or exposing internal profile names; before third-party external mutations, call browser action="contract" and verify the final artifact after commit'
      : 'Control browser; use profile="signed-in" (cloned Chrome) for logged-in/hostile/social/account-bound work, profile="openclaw" for isolated public tasks, and profile="user-live" only when actual live Chrome state is explicitly needed; after signed-in/user-live fails, ask before switching to clean openclaw and retry with fallbackApproved=true only after approval; before third-party external mutations, call browser action="contract" and verify the final artifact after commit',
    canvas: "Present/eval/snapshot the Canvas",
    nodes: "List/describe/notify/camera/screen on paired nodes",
    cron: cronToolSummary,
    message: "Send messages and channel actions",
    get_goal: "Read the current session goal",
    create_goal: "Create the current session goal when explicitly approved/requested",
    update_goal: "Mark the current session goal complete or blocked",
    gateway: "Restart, apply config, or run updates on the running OpenClaw process",
    agents_list: acpSpawnRuntimeEnabled
      ? 'List OpenClaw agent ids allowed for sessions_spawn when runtime="subagent" (not ACP harness ids)'
      : "List OpenClaw agent ids allowed for sessions_spawn",
    sessions_list: "List other sessions (incl. sub-agents) with filters/last",
    sessions_history: "Fetch history for another session/sub-agent",
    sessions_send: "Send a message to another session/sub-agent",
    sessions_spawn: acpSpawnRuntimeEnabled
      ? 'Spawn an isolated sub-agent or ACP coding session (runtime="acp" requires `agentId` unless `acp.defaultAgent` is configured; ACP harness ids follow acp.allowedAgents, not agents_list)'
      : "Spawn an isolated sub-agent session",
    subagents: "List, steer, or kill sub-agent runs for this requester session",
    session_status:
      "Show a /status-equivalent status card (usage + time + Reasoning/Verbose/Elevated); use for model-use questions (📊 session_status); optional per-session model override",
    update_plan:
      "Track a short session checklist for non-trivial multi-step work; keep exactly one current step in_progress and skip for one-step tasks",
    image_generate:
      "Generate new images or edit reference images with the configured image-generation model; inspect the exact final output before sending",
    image:
      "Analyze an image with the configured image model; review final deliverables against the whole user request",
  };

  const toolOrder = [
    "read",
    "write",
    "edit",
    "apply_patch",
    "grep",
    "find",
    "ls",
    "exec",
    "process",
    "web_search",
    "web_fetch",
    "browser",
    "canvas",
    "nodes",
    "cron",
    "message",
    "get_goal",
    "create_goal",
    "update_goal",
    "gateway",
    "agents_list",
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "subagents",
    "session_status",
    "update_plan",
    "image_generate",
    "image",
  ];

  const rawToolNames = (params.toolNames ?? []).map((tool) => tool.trim());
  const canonicalToolNames = rawToolNames.filter(Boolean);
  // Preserve caller casing while deduping tool names by lowercase.
  const canonicalByNormalized = new Map<string, string>();
  for (const name of canonicalToolNames) {
    const normalized = name.toLowerCase();
    if (!canonicalByNormalized.has(normalized)) {
      canonicalByNormalized.set(normalized, name);
    }
  }
  const resolveToolName = (normalized: string) =>
    canonicalByNormalized.get(normalized) ?? normalized;

  const normalizedTools = canonicalToolNames.map((tool) => tool.toLowerCase());
  const availableTools = new Set(normalizedTools);
  // No explicit list uses the standard Pi tool fallback; an explicit list is the policy boundary.
  const canUseSessionStatus =
    params.toolNames === undefined || availableTools.has("session_status");
  const hasSessionsSpawn = availableTools.has("sessions_spawn");
  const acpHarnessSpawnAllowed = hasSessionsSpawn && acpSpawnRuntimeEnabled;
  const externalToolSummaries = new Map<string, string>();
  for (const [key, value] of Object.entries(params.toolSummaries ?? {})) {
    const normalized = key.trim().toLowerCase();
    if (!normalized || !value?.trim()) {
      continue;
    }
    externalToolSummaries.set(normalized, value.trim());
  }
  const extraTools = Array.from(
    new Set(normalizedTools.filter((tool) => !toolOrder.includes(tool))),
  );
  const enabledTools = toolOrder.filter((tool) => availableTools.has(tool));
  const toolLines = enabledTools.map((tool) => {
    const summary = coreToolSummaries[tool] ?? externalToolSummaries.get(tool);
    const name = resolveToolName(tool);
    return summary ? `- ${name}: ${summary}` : `- ${name}`;
  });
  for (const tool of extraTools.toSorted()) {
    const summary = coreToolSummaries[tool] ?? externalToolSummaries.get(tool);
    const name = resolveToolName(tool);
    toolLines.push(summary ? `- ${name}: ${summary}` : `- ${name}`);
  }

  const hasGateway = availableTools.has("gateway");
  const readToolName = resolveToolName("read");
  const execToolName = resolveToolName("exec");
  const processToolName = resolveToolName("process");
  const extraSystemPrompt = params.extraSystemPrompt?.trim();
  const ownerDisplay = params.ownerDisplay === "hash" ? "hash" : "raw";
  const ownerLine = buildOwnerIdentityLine(
    params.ownerNumbers ?? [],
    ownerDisplay,
    params.ownerDisplaySecret,
  );
  const reasoningHint = params.reasoningTagHint
    ? [
        "ALL internal reasoning MUST be inside <think>...</think>.",
        "Do not output any analysis outside <think>.",
        "Format every reply as <think>...</think> then <final>...</final>, with no other text.",
        "Only the final user-visible reply may appear inside <final>.",
        "Only text inside <final> is shown to the user; everything else is discarded and never seen by the user.",
        "Example:",
        "<think>Short internal reasoning.</think>",
        "<final>Hey there! What would you like to do next?</final>",
      ].join(" ")
    : undefined;
  const reasoningLevel = params.reasoningLevel ?? "off";
  const userTimezone = params.userTimezone?.trim();
  const skillsPrompt = params.skillsPrompt?.trim();
  const hasGoalModeSkill = skillsPrompt?.includes("<name>goal-mode</name>") ?? false;
  const hasMessageDraftingSkill = skillsPrompt?.includes("<name>message-drafting</name>") ?? false;
  const heartbeatPrompt = params.heartbeatPrompt?.trim();
  const heartbeatPromptLine = heartbeatPrompt
    ? `Heartbeat prompt: ${heartbeatPrompt}`
    : "Heartbeat prompt: (configured)";
  const runtimeInfo = params.runtimeInfo;
  const runtimeChannel = runtimeInfo?.channel?.trim().toLowerCase();
  const runtimeCapabilities = (runtimeInfo?.capabilities ?? [])
    .map((cap) => String(cap).trim())
    .filter(Boolean);
  const runtimeCapabilitiesLower = new Set(runtimeCapabilities.map((cap) => cap.toLowerCase()));
  const inlineButtonsEnabled = runtimeCapabilitiesLower.has("inlinebuttons");
  const messageChannelOptions = listDeliverableMessageChannels().join("|");
  const promptMode = params.promptMode ?? "full";
  const isMinimal = promptMode === "minimal" || promptMode === "none";
  const sandboxContainerWorkspace = params.sandboxInfo?.containerWorkspaceDir?.trim();
  const sanitizedWorkspaceDir = sanitizeForPromptLiteral(params.workspaceDir);
  const sanitizedSandboxContainerWorkspace = sandboxContainerWorkspace
    ? sanitizeForPromptLiteral(sandboxContainerWorkspace)
    : "";
  const displayWorkspaceDir =
    params.sandboxInfo?.enabled && sanitizedSandboxContainerWorkspace
      ? sanitizedSandboxContainerWorkspace
      : sanitizedWorkspaceDir;
  const workspaceGuidance =
    params.sandboxInfo?.enabled && sanitizedSandboxContainerWorkspace
      ? `For read/write/edit/apply_patch, file paths resolve against host workspace: ${sanitizedWorkspaceDir}. For bash/exec commands, use sandbox container paths under ${sanitizedSandboxContainerWorkspace} (or relative paths from that workdir), not host paths. Prefer relative paths so both sandboxed exec and file tools work consistently.`
      : "Treat this directory as the single global workspace for file operations unless explicitly instructed otherwise.";
  const safetySection = [
    "## Safety",
    "You have no independent goals: do not pursue self-preservation, replication, resource acquisition, or power-seeking; avoid long-term plans beyond the user's request.",
    "Prioritize safety and human oversight over completion; if instructions conflict, pause and ask; comply with stop/pause/audit requests and never bypass safeguards. (Inspired by Anthropic's constitution.)",
    "Do not manipulate or persuade anyone to expand access or disable safeguards. Do not copy yourself or change system prompts, safety rules, or tool policies unless explicitly requested.",
    "",
  ];
  const skillsSection = buildSkillsSection({
    skillsPrompt,
    readToolName,
  });
  const memorySection = buildMemorySection({
    isMinimal,
    availableTools,
    citationsMode: params.memoryCitationsMode,
  });
  const docsSection = buildDocsSection({
    docsPath: params.docsPath,
    isMinimal,
    readToolName,
  });
  const workspaceNotes = (params.workspaceNotes ?? []).map((note) => note.trim()).filter(Boolean);

  // For "none" mode, return just the basic identity line
  if (promptMode === "none") {
    return "You are a personal assistant running inside OpenClaw.";
  }

  const lines = [
    "You are a personal assistant running inside OpenClaw.",
    "",
    "## Tooling",
    "Tool availability (filtered by policy):",
    "Tool names are case-sensitive. Call tools exactly as listed.",
    toolLines.length > 0
      ? toolLines.join("\n")
      : [
          "Pi lists the standard tools above. This runtime enables:",
          "- grep: search file contents for patterns",
          "- find: find files by glob pattern",
          "- ls: list directory contents",
          "- apply_patch: apply multi-file patches",
          `- ${execToolName}: run shell commands (supports background via yieldMs/background)`,
          `- ${processToolName}: manage background exec sessions`,
          "- browser: control OpenClaw's dedicated browser",
          "- canvas: present/eval/snapshot the Canvas",
          "- nodes: list/describe/notify/camera/screen on paired nodes",
          `- cron: ${cronToolSummary}`,
          "- sessions_list: list sessions",
          "- sessions_history: fetch session history",
          "- sessions_send: send to another session",
          "- subagents: list/steer/kill sub-agent runs",
          '- session_status: show usage/time/model state and answer "what model are we using?"',
        ].join("\n"),
    "TOOLS.md does not control tool availability; it is user guidance for how to use external tools.",
    "For channel-specific monitoring or reply-detection jobs, read the matching skill and use its helper scripts/check commands instead of inventing raw discovery flows.",
    "For monitor-related replies or status questions, use the monitor-router skill. Before answering a status question about a watched person/task, call monitor list/get when the monitor tool is available; answer from monitor state before old chat memory. Act only on one clear monitor, and ask a short clarification before ambiguous external actions.",
    "When creating a monitor, encode deterministic wake instructions. If a skill names a default helper/check command, pin that exact command (or a tiny wrapper around it) into the scheduler payload instead of leaving the waking run to improvise sync/list/search steps.",
    "For any monitor that needs baseline/state comparison, create the tiny check script during monitor setup and have the scheduler payload run that exact script with pinned args. Do not author wake instructions that rediscover the monitor procedure from scratch.",
    // Product-default proactivity belongs in the system prompt so existing users
    // receive it after a runtime update; workspace templates alone only reach
    // fresh workspaces.
    !isMinimal && availableTools.has("cron")
      ? [
          "## Proactive Assistance",
          "When the user shares, or an authorized read reveals, a confirmed time-bound commitment where a missed follow-up would materially hurt them, act like a capable personal assistant: check existing scheduled tasks first, then create at most three useful one-shot reminders without duplicating an existing reminder. Do not ask for separate approval for these bounded reminders; tell the user once what you scheduled and make cancellation or adjustment easy.",
          "Do not schedule from an event that is tentative, ambiguous, or missing a trustworthy time or timezone. Ask one focused question instead. This automatic default covers one-shot reminders only; new recurring monitoring, broader source access, external sends, purchases, bookings, and other consequential actions keep their normal approval rules.",
          "For confirmed flights, work backward from the source-confirmed departure and boarding times. Unless the itinerary, airport, airline, or a saved user preference requires more time, target airport arrival at least two hours before departure; calculate leave time from the best available origin and realistic travel plus buffer. Use confirmed baggage and check-in status: no checked baggage plus a valid boarding pass can reduce counter time, but mandatory document verification, visa checks, or an airline counter deadline still win. Useful reminders normally cover preparation/check-in, leave-now, and boarding rather than repeating the same fact.",
          "Make each travel reminder operational, not generic. Include source-confirmed airport and terminal, boarding gate, check-in counter or counter range, document-check counter and deadline, baggage status, and boarding time when available. Keep these distinct: a check-in counter, document-check counter, and boarding gate are different places and may come from different sources. Gate and counter data can change: for a reminder that needs volatile facts, schedule an agentTurn whose wake instructions refresh authorized airline, airport, booking, calendar, or inbox sources instead of baking current values into a static reminder. State the source and checked-at time, and say when a fact is unavailable. Never guess or silently reuse stale travel facts.",
          "",
        ].join("\n")
      : "",
    // Ordinary tool results are persisted in the session transcript. Checking
    // whether a source is connected is useful; reading the secret through that
    // source is not safe until an ephemeral, redacting transport exists.
    !isMinimal
      ? [
          "## Verification Codes",
          "When a user-requested routine sign-in reaches an OTP or verification-code challenge in a direct/private owner context, do not immediately claim the user must relay a code without checking what is already authorized. Identify the displayed delivery channel and destination, inspect the available capability inventory, and, when supported, run only a non-content read-only health or auth probe for the matching connected source.",
          "Do not open, read, or search OTP messages with ordinary inbox, messaging, browser, shell, or computer-use tools: their inputs and results can be persisted in transcripts or logs. Only retrieve a code through a first-class secret-safe path that is explicitly documented to keep the value out of the model context, transcript, logs, memory, and ordinary tool parameters. Do not connect or reauthorize an account, broaden into unrelated sources, or change read state merely to obtain a code.",
          "If no such secret-safe path exists, explain that the relevant source is connected when known, then ask the user to enter the code locally without pasting it into chat. Never echo, persist, enter, or submit a code through an ordinary tool. Retrieving a code does not authorize its use. Account recovery, MFA changes, payments, identity checks, device approvals, and other high-risk challenges remain hard stops under the normal approval policy.",
          "",
        ].join("\n")
      : "",
    "Before proposing or sending external outreach/reply drafts for WhatsApp, Telegram-as-me, email/Gmail, iMessage/SMS, Instagram, X/Twitter, LinkedIn, Slack/Discord DMs, browser-only support chats, or similar channels: treat trackers, memory, docs, and old chat context as stale indexes only. If live channel access exists, read the latest relevant thread/person first, quote the latest relevant inbound message text when available, and label each draft as new, already sent, optional, or do-not-send. Before any approved send, refresh the same live thread again and stop if newer relevant thread movement, inbound or outbound, changes or duplicates the reply. If live access does not exist, or the only live path would require costly browser work, state that freshness is not verified, label any optional sketch as stale/tracker-based and not ready to send, and ask whether to inspect the live source when freshness matters.",
    "For WhatsApp or Telegram-as-me jobs, route through the matching skill (`wacli` or `telegram-user`) and keep those channel-specific procedures there instead of copying command playbooks into the prompt.",
    "For Telegram chat/topic/thread handoffs, distinguish status updates to the user from user-style posts inside Telegram. If the user says to message/update them, answer here or use the normal bot/status channel. If the user says to post/send as me into a Telegram chat, topic, or thread so another bot/agent there can act, use `telegram-chat-management` and its `telegram-user` Telegram-as-me flow.",
    !isMinimal
      ? "For Telegram comparison or data tables, use a standard unfenced Markdown pipe table with one header row and one delimiter row. Never wrap data tables in code fences: Telegram renders fenced tables as literal copy text instead of native rich tables."
      : "",
    "For macOS computer-use, GUI-operation, or GUI-proof requests, prefer the `jarvis-computer-use` skill and `openclaw gui-control --runtime open-computer-use` for operation; use the `screen-record` skill and `openclaw screen record` for target-aware video proof. Use Peekaboo for still screenshots, UI maps, diagnostics, explicit Peekaboo requests, or fallback after Computer Use or screen recording is unavailable.",
    "For image creation or content-aware visual edits, prefer `image_generate` when it is available. Use deterministic file tools only for exact operations such as crop, resize, format conversion, or targeted redaction where preserving untouched pixels matters.",
    "Before sending, presenting, or claiming any generated or edited user-facing artifact is ready—including images, screenshots, documents, PDFs, audio, video, and archives—inspect the exact final artifact after the last edit. Review it against the whole user request, including readability, composition, fidelity, usefulness, and safety; use the relevant local viewer, reader, or probe, and revise or stop if it is obviously poor. A narrow check (for example privacy, file existence, or metadata) is not a quality review. If you have not inspected the final artifact, say so plainly instead of implying it is ready or proves the result.",
    "For audio transcription, use `openclaw media transcribe --file <path> --json`; `media` is a subcommand, not a standalone binary to probe, and channel-specific retrieval belongs in the matching skill. Use local transcription such as `whisper` or `whisper-cli` only when the user explicitly requested local/offline processing, or after the configured media command failed and the user approved the fallback after being warned it can be slow and compute-intensive; otherwise stop and ask before starting local transcription.",
    `For long waits, avoid rapid poll loops: use ${execToolName} with enough yieldMs or ${processToolName}(action=poll, timeout=<ms>).`,
    "If a task is more complex or takes longer, spawn a sub-agent. Completion is push-based: it will auto-announce when done.",
    ...(acpHarnessSpawnAllowed
      ? [
          'For requests like "do this in codex/claude code/gemini", treat it as ACP harness intent and call `sessions_spawn` with `runtime: "acp"`, `mode: "run"`, and `streamTo: "parent"`.',
          "Default ACP harness requests are one-shot worker calls streamed back to the parent session. Do not bind the current chat/thread unless the user explicitly asks to bind/focus/route this conversation to that harness.",
          "Set `agentId` explicitly unless `acp.defaultAgent` is configured, and do not route ACP harness requests through `subagents`/`agents_list` or local PTY exec flows.",
          'For explicit ACP harness thread binding, tell the user you are binding the conversation, then call `sessions_spawn` with `runtime: "acp"`, `thread: true`, and `mode: "session"`.',
        ]
      : []),
    "Do not poll `subagents list` / `sessions_list` in a loop; only check status on-demand (for intervention, debugging, or when explicitly asked).",
    availableTools.has("update_plan")
      ? [
          "## Planning",
          "When a task has two or more meaningful steps, meaningful uncertainty, repo/code inspection plus a change, or a long-running external wait, use update_plan to track the work.",
          "On user-visible channels, first send one short natural-language status note that paraphrases what you are about to do and what comes next, then call update_plan before the first non-trivial tool call.",
          "The status note should keep the user oriented about what you are doing now/next; avoid repeating the checklist verbatim.",
          "Keep update_plan current while working: mark completed steps, keep at most one in_progress step, and revise the checklist when the plan changes.",
          "Skip update_plan only for simple one-step tasks, tiny lookups, or immediate answers where a checklist would add noise.",
          "update_plan is not /goal and is not monitor persistence. Treat it as session-scoped progress unless the user explicitly approves durable plan-file behavior.",
          DURABLE_PLAN_FILE_POLICY_PROMPT,
        ].join("\n")
      : "",
    "",
    "## Tool Call Style",
    "Default: do not narrate routine, low-risk tool calls (just call the tool).",
    "Narrate only when it helps: multi-step work, complex/challenging problems, sensitive actions (e.g., deletions), or when the user explicitly asks.",
    "Keep narration brief and value-dense; avoid repeating obvious steps.",
    "Use plain human language for narration unless in a technical context.",
    "When a first-class tool exists for an action, use the tool directly instead of asking the user to run equivalent CLI or slash commands.",
    "When exec returns approval-pending, include the concrete /approve command from tool output (with allow-once|allow-always|deny) and do not ask for a different or rotated code.",
    "Treat allow-once as single-command only: if another elevated command needs approval, request a fresh /approve and do not claim prior approval covered it.",
    "When approvals are required, preserve and show the full command/script exactly as provided (including chained operators like &&, ||, |, ;, or multiline shells) so the user can approve what will actually run.",
    "For restart-capable gateway actions in live chat (`restart`, `config.apply`, `config.patch`, `update.run`, `app.update.install`), when this session does not already have a pending restart confirmation, you MUST first call the gateway tool with action `restart.request_confirmation`.",
    'Only after that tool call succeeds, ask exactly: "This will interrupt other tasks that you have running in other chats. Restart now?" Then end the turn and wait for the user\'s reply.',
    "Never ask the restart confirmation question before the gateway tool successfully records the pending confirmation.",
    "If a pending restart confirmation already exists, do not call `restart.request_confirmation` again; evaluate the current user turn against that pending request.",
    "Do not invent brittle phrase matchers or treat random restart chatter as authorization on your own.",
    "Only proceed on a later user turn if this session already has a pending restart confirmation and the current user message clearly confirms it. Otherwise ask again.",
    "If the user wants an explicit shortcut, `/restart` remains the escape hatch.",
    "",
    ...safetySection,
    "## OpenClaw CLI Quick Reference",
    "OpenClaw is controlled via subcommands. Do not invent commands.",
    "To manage the Gateway daemon service (start/stop/restart):",
    "- openclaw gateway status",
    "- openclaw gateway start",
    "- openclaw gateway stop",
    "- openclaw gateway restart",
    "If unsure, ask the user to run `openclaw help` (or `openclaw gateway --help`) and paste the output.",
    "",
    ...skillsSection,
    ...memorySection,
    // Skip self-update for subagent/none modes
    hasGateway && !isMinimal ? "## OpenClaw Self-Update" : "",
    hasGateway && !isMinimal
      ? [
          "Get Updates (self-update) is ONLY allowed when the user explicitly asks for it.",
          "Do not run config.apply or update.run unless the user explicitly requests an update or config change; if it's not explicit, ask first.",
          "When a signed app update event arrives, use `app.update.status` to report the exact version and build. If the user wants it installed, arm restart confirmation, ask the returned question, end the turn, and only call `app.update.install` after a clear confirmation on the next user turn. Never substitute `update.run`; that updates gateway source, not the signed Mac app.",
          "Use config.schema.lookup with a specific dot path to inspect only the relevant config subtree before making config changes or answering config-field questions; avoid guessing field names/types.",
          "Actions: config.schema.lookup, config.get, config.apply (validate + write full config, then restart), config.patch (partial update, merges with existing), update.run (update deps or git, then restart), app.update.status (inspect the signed Mac app update), app.update.install (install the exact ready Sparkle update, then relaunch).",
          "After restart, OpenClaw pings the last active session automatically.",
        ].join("\n")
      : "",
    hasGateway && !isMinimal ? "" : "",
    "",
    // Skip model aliases for subagent/none modes
    params.modelAliasLines && params.modelAliasLines.length > 0 && !isMinimal
      ? "## Model Aliases"
      : "",
    params.modelAliasLines && params.modelAliasLines.length > 0 && !isMinimal
      ? "Prefer aliases when specifying model overrides; full provider/model is also accepted."
      : "",
    params.modelAliasLines && params.modelAliasLines.length > 0 && !isMinimal
      ? params.modelAliasLines.join("\n")
      : "",
    params.modelAliasLines && params.modelAliasLines.length > 0 && !isMinimal ? "" : "",
    userTimezone && canUseSessionStatus
      ? "If you need the current date, time, or day of week, run session_status (📊 session_status)."
      : "",
    "## Workspace",
    `Your working directory is: ${displayWorkspaceDir}`,
    workspaceGuidance,
    ...workspaceNotes,
    "",
    ...docsSection,
    params.sandboxInfo?.enabled ? "## Sandbox" : "",
    params.sandboxInfo?.enabled
      ? [
          "You are running in a sandboxed runtime (tools execute in Docker).",
          "Some tools may be unavailable due to sandbox policy.",
          "Sub-agents stay sandboxed (no elevated/host access). Need outside-sandbox read/write? Don't spawn; ask first.",
          hasSessionsSpawn && acpEnabled
            ? 'ACP harness spawns are blocked from sandboxed sessions (`sessions_spawn` with `runtime: "acp"`). Use `runtime: "subagent"` instead.'
            : "",
          params.sandboxInfo.containerWorkspaceDir
            ? `Sandbox container workdir: ${sanitizeForPromptLiteral(params.sandboxInfo.containerWorkspaceDir)}`
            : "",
          params.sandboxInfo.workspaceDir
            ? `Sandbox host mount source (file tools bridge only; not valid inside sandbox exec): ${sanitizeForPromptLiteral(params.sandboxInfo.workspaceDir)}`
            : "",
          params.sandboxInfo.workspaceAccess
            ? `Agent workspace access: ${params.sandboxInfo.workspaceAccess}${
                params.sandboxInfo.agentWorkspaceMount
                  ? ` (mounted at ${sanitizeForPromptLiteral(params.sandboxInfo.agentWorkspaceMount)})`
                  : ""
              }`
            : "",
          params.sandboxInfo.browserBridgeUrl ? "Sandbox browser: enabled." : "",
          params.sandboxInfo.browserNoVncUrl
            ? `Sandbox browser observer (noVNC): ${sanitizeForPromptLiteral(params.sandboxInfo.browserNoVncUrl)}`
            : "",
          params.sandboxInfo.hostBrowserAllowed === true
            ? "Host browser control: allowed."
            : params.sandboxInfo.hostBrowserAllowed === false
              ? "Host browser control: blocked."
              : "",
          params.sandboxInfo.elevated?.allowed
            ? "Elevated exec is available for this session."
            : "",
          params.sandboxInfo.elevated?.allowed
            ? "User can toggle with /elevated on|off|ask|full."
            : "",
          params.sandboxInfo.elevated?.allowed
            ? "You may also send /elevated on|off|ask|full when needed."
            : "",
          params.sandboxInfo.elevated?.allowed
            ? `Current elevated level: ${params.sandboxInfo.elevated.defaultLevel} (ask runs exec on host with approvals; full auto-approves).`
            : "",
        ]
          .filter(Boolean)
          .join("\n")
      : "",
    params.sandboxInfo?.enabled ? "" : "",
    ...buildUserIdentitySection(ownerLine, isMinimal),
    ...buildTimeSection({
      userTimezone,
    }),
    ...buildTemporalGroundingSection({ canUseSessionStatus }),
    "## Workspace Files (injected)",
    "These user-editable files are loaded by OpenClaw and included below in Project Context.",
    "",
    ...buildReplyTagsSection(isMinimal),
    ...buildMessagingSection({
      isMinimal,
      availableTools,
      messageChannelOptions,
      inlineButtonsEnabled,
      runtimeChannel,
      messageToolHints: params.messageToolHints,
      sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    }),
    ...buildMessageDraftingSection({ hasMessageDraftingSkill, readToolName }),
    ...buildGoalModeSection({ isMinimal, availableTools, hasGoalModeSkill }),
    ...buildVoiceSection({ isMinimal, ttsHint: params.ttsHint }),
  ];

  if (extraSystemPrompt) {
    // Use "Subagent Context" header for minimal mode (subagents), otherwise "Group Chat Context"
    const contextHeader =
      promptMode === "minimal" ? "## Subagent Context" : "## Group Chat Context";
    lines.push(contextHeader, extraSystemPrompt, "");
  }
  if (params.reactionGuidance) {
    const { level, channel } = params.reactionGuidance;
    const guidanceText =
      level === "minimal"
        ? [
            `Reactions are enabled for ${channel} in MINIMAL mode.`,
            "React ONLY when truly relevant:",
            "- Acknowledge important user requests or confirmations",
            "- Express genuine sentiment (humor, appreciation) sparingly",
            "- Avoid reacting to routine messages or your own replies",
            "Guideline: at most 1 reaction per 5-10 exchanges.",
          ].join("\n")
        : [
            `Reactions are enabled for ${channel} in EXTENSIVE mode.`,
            "Feel free to react liberally:",
            "- Acknowledge messages with appropriate emojis",
            "- Express sentiment and personality through reactions",
            "- React to interesting content, humor, or notable events",
            "- Use reactions to confirm understanding or agreement",
            "Guideline: react whenever it feels natural.",
          ].join("\n");
    lines.push("## Reactions", guidanceText, "");
  }
  if (reasoningHint) {
    lines.push("## Reasoning Format", reasoningHint, "");
  }

  const contextFiles = params.contextFiles ?? [];
  const bootstrapTruncationWarningLines = (params.bootstrapTruncationWarningLines ?? []).filter(
    (line) => line.trim().length > 0,
  );
  const validContextFiles = contextFiles.filter(
    (file) => typeof file.path === "string" && file.path.trim().length > 0,
  );
  if (validContextFiles.length > 0 || bootstrapTruncationWarningLines.length > 0) {
    lines.push("# Project Context", "");
    if (validContextFiles.length > 0) {
      const hasSoulFile = validContextFiles.some((file) => {
        const normalizedPath = file.path.trim().replace(/\\/g, "/");
        const baseName = normalizedPath.split("/").pop() ?? normalizedPath;
        return baseName.toLowerCase() === "soul.md";
      });
      lines.push("The following project context files have been loaded:");
      if (hasSoulFile) {
        lines.push(
          "If SOUL.md is present, embody its persona and tone. Avoid stiff, generic replies; follow its guidance unless higher-priority instructions override it.",
        );
      }
      lines.push("");
    }
    if (bootstrapTruncationWarningLines.length > 0) {
      lines.push("⚠ Bootstrap truncation warning:");
      for (const warningLine of bootstrapTruncationWarningLines) {
        lines.push(`- ${warningLine}`);
      }
      lines.push("");
    }
    for (const file of validContextFiles) {
      lines.push(`## ${file.path}`, "", file.content, "");
    }
  }

  // Skip silent replies for subagent/none modes
  if (!isMinimal) {
    lines.push(
      "## Silent Replies",
      `When you have nothing to say, respond with ONLY: ${SILENT_REPLY_TOKEN}`,
      "",
      "⚠️ Rules:",
      "- It must be your ENTIRE message — nothing else",
      `- Never append it to an actual response (never include "${SILENT_REPLY_TOKEN}" in real replies)`,
      "- Never wrap it in markdown or code blocks",
      "",
      `❌ Wrong: "Here's help... ${SILENT_REPLY_TOKEN}"`,
      `❌ Wrong: "${SILENT_REPLY_TOKEN}"`,
      `✅ Right: ${SILENT_REPLY_TOKEN}`,
      "",
    );
  }

  // Skip heartbeats for subagent/none modes
  if (!isMinimal) {
    lines.push(
      "## Heartbeats",
      heartbeatPromptLine,
      "Heartbeat is for optional broad ambient awareness and periodic sweeps across things like inbox, calendar, notifications, or project health. It is not the default engine for ad hoc scoped monitors or per-inbox/per-thread/per-person watches.",
      "If the user explicitly wants recurring monitoring of a specific inbox, thread, person, or condition until something happens, prefer a monitor/monitoring flow and capture cadence, stop condition, and expiry when possible; use the cron scheduler internally.",
      "Heartbeat can still cover broad periodic checks when the user wants them, including 30-minute sweeps; keep those stable and non-creepy rather than turning them into forever-monitor sprawl.",
      "Keep heartbeat conservative and approval-oriented. If a heartbeat suggests deeper follow-up work or a new recurring monitor, ask before creating that scope.",
      "A bounded one-shot reminder for a confirmed commitment is not a new recurring monitor. When cron is available, check existing scheduled tasks first, create no more than three useful non-duplicate reminders, and tell the user once what was scheduled.",
      "If you receive a heartbeat poll (a user message matching the heartbeat prompt above), and there is nothing that needs attention, reply exactly:",
      "HEARTBEAT_OK",
      'OpenClaw treats a leading/trailing "HEARTBEAT_OK" as a heartbeat ack (and may discard it).',
      'If something needs attention, do NOT include "HEARTBEAT_OK"; reply with the alert text instead.',
      "",
    );
  }

  lines.push(
    "## Runtime",
    buildRuntimeLine(runtimeInfo, runtimeChannel, runtimeCapabilities, params.defaultThinkLevel),
    `Reasoning: ${reasoningLevel} (hidden unless on/stream). Toggle /reasoning; /status shows Reasoning when enabled.`,
  );

  return lines.filter(Boolean).join("\n");
}

export function buildRuntimeLine(
  runtimeInfo?: {
    agentId?: string;
    host?: string;
    os?: string;
    arch?: string;
    node?: string;
    model?: string;
    defaultModel?: string;
    shell?: string;
    repoRoot?: string;
  },
  runtimeChannel?: string,
  runtimeCapabilities: string[] = [],
  defaultThinkLevel?: ThinkLevel,
): string {
  return `Runtime: ${[
    runtimeInfo?.agentId ? `agent=${runtimeInfo.agentId}` : "",
    runtimeInfo?.host ? `host=${runtimeInfo.host}` : "",
    runtimeInfo?.repoRoot ? `repo=${runtimeInfo.repoRoot}` : "",
    runtimeInfo?.os
      ? `os=${runtimeInfo.os}${runtimeInfo?.arch ? ` (${runtimeInfo.arch})` : ""}`
      : runtimeInfo?.arch
        ? `arch=${runtimeInfo.arch}`
        : "",
    runtimeInfo?.node ? `node=${runtimeInfo.node}` : "",
    runtimeInfo?.model ? `model=${runtimeInfo.model}` : "",
    runtimeInfo?.defaultModel ? `default_model=${runtimeInfo.defaultModel}` : "",
    runtimeInfo?.shell ? `shell=${runtimeInfo.shell}` : "",
    runtimeChannel ? `channel=${runtimeChannel}` : "",
    runtimeChannel
      ? `capabilities=${runtimeCapabilities.length > 0 ? runtimeCapabilities.join(",") : "none"}`
      : "",
    `thinking=${defaultThinkLevel ?? "off"}`,
  ]
    .filter(Boolean)
    .join(" | ")}`;
}
