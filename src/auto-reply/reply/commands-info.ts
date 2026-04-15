import { resolveAgentSkillsFilter } from "../../agents/agent-scope.js";
import { buildWorkspaceSkillStatus } from "../../agents/skills-status.js";
import { loadWorkspaceSkillEntries } from "../../agents/skills.js";
import { logVerbose } from "../../globals.js";
import { getRemoteSkillEligibility } from "../../infra/skills-remote.js";
import { listSkillCommandsForAgents, listSkillCommandsForWorkspace } from "../skill-commands.js";
import {
  buildCommandsMessage,
  buildCommandsMessagePaginated,
  buildHelpMessage,
} from "../status.js";
import { buildContextReply } from "./commands-context-report.js";
import { buildExportSessionReply } from "./commands-export-session.js";
import { buildStatusReply } from "./commands-status.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";

function mergeSkillFilters(existing?: string[], incoming?: string[]): string[] | undefined {
  if (existing === undefined || incoming === undefined) {
    return existing ?? incoming;
  }
  if (existing.length === 0 || incoming.length === 0) {
    return [];
  }
  const incomingSet = new Set(incoming);
  return existing.filter((name) => incomingSet.has(name));
}

function isCapabilitiesQuestion(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return false;
  }
  return [
    /^what can (?:you|this bot) do(?: here| right now| for me)?$/,
    /^how can (?:you|this bot) help(?: me)?(?: here| right now)?$/,
    /^what can i use (?:you|this bot) for$/,
    /^what are you capable of$/,
    /^what do you do(?: here)?$/,
  ].some((pattern) => pattern.test(normalized));
}

function summarizeSkillDescription(description: string): string {
  const compact = description.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "Ready to use.";
  }
  const withoutLimitations = compact.split(/\bNOT for:\b/i)[0]?.trim() ?? compact;
  if (withoutLimitations.length <= 110) {
    return withoutLimitations;
  }
  return `${withoutLimitations.slice(0, 109).trimEnd()}…`;
}

function buildCapabilitiesMessage(params: HandleCommandsParams): string {
  const agentSkillFilter = params.agentId
    ? resolveAgentSkillsFilter(params.cfg, params.agentId)
    : undefined;
  const skillFilter = mergeSkillFilters(params.opts?.skillFilter, agentSkillFilter);
  const entries = loadWorkspaceSkillEntries(params.workspaceDir, {
    config: params.cfg,
  });
  const filteredEntries =
    skillFilter === undefined
      ? entries
      : entries.filter((entry) => skillFilter.includes(entry.skill.name));
  const report = buildWorkspaceSkillStatus(params.workspaceDir, {
    config: params.cfg,
    entries: filteredEntries,
    eligibility: { remote: getRemoteSkillEligibility() },
  });
  const skillCommands =
    params.skillCommands ??
    listSkillCommandsForWorkspace({
      workspaceDir: params.workspaceDir,
      cfg: params.cfg,
      skillFilter,
    });
  const commandBySkillName = new Map(skillCommands.map((command) => [command.skillName, command]));
  const readySkills = report.skills
    .filter((skill) => skill.eligible && commandBySkillName.has(skill.name))
    .toSorted((left, right) => {
      if (left.always !== right.always) {
        return left.always ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
  const unavailableCount = report.skills.filter((skill) => !skill.eligible).length;
  const lines = [
    "🤖 What I can do here",
    readySkills.length > 0
      ? `Right now I have ${readySkills.length} ready skill${readySkills.length === 1 ? "" : "s"} in this runtime${unavailableCount > 0 ? `, plus ${unavailableCount} installed but unavailable until they are enabled or set up` : ""}.`
      : `I do not have any user-invocable skills ready in this runtime right now${unavailableCount > 0 ? `, and ${unavailableCount} installed skill${unavailableCount === 1 ? "" : "s"} still need setup or enabling` : ""}.`,
    "Ask normally if you're unsure, or use `/skill <name> ...` when you want something specific.",
    "Useful controls: `/commands`, `/status`, `/context`, `/whoami`, `/new`.",
  ];

  if (readySkills.length > 0) {
    lines.push("", "Good fits right now");
    for (const skill of readySkills.slice(0, 6)) {
      const command = commandBySkillName.get(skill.name);
      const commandLabel = command ? `/${command.name}` : `/skill ${skill.name}`;
      lines.push(`- ${commandLabel} - ${summarizeSkillDescription(skill.description)}`);
    }
    if (readySkills.length > 6) {
      lines.push(`- Plus ${readySkills.length - 6} more. Use \`/commands\` for the full list.`);
    }
  }

  return lines.join("\n");
}

export const handleCapabilitiesCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  const requested =
    normalized === "/capabilities" || isCapabilitiesQuestion(params.command.rawBodyNormalized);
  if (!requested) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring capabilities request from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  return {
    shouldContinue: false,
    reply: { text: buildCapabilitiesMessage(params) },
  };
};

export const handleHelpCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  if (params.command.commandBodyNormalized !== "/help") {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /help from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  return {
    shouldContinue: false,
    reply: { text: buildHelpMessage(params.cfg) },
  };
};

export const handleCommandsListCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  if (params.command.commandBodyNormalized !== "/commands") {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /commands from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  const skillCommands =
    params.skillCommands ??
    listSkillCommandsForAgents({
      cfg: params.cfg,
      agentIds: params.agentId ? [params.agentId] : undefined,
    });
  const surface = params.ctx.Surface;

  if (surface === "telegram") {
    const result = buildCommandsMessagePaginated(params.cfg, skillCommands, {
      page: 1,
      surface,
    });

    if (result.totalPages > 1) {
      return {
        shouldContinue: false,
        reply: {
          text: result.text,
          channelData: {
            telegram: {
              buttons: buildCommandsPaginationKeyboard(
                result.currentPage,
                result.totalPages,
                params.agentId,
              ),
            },
          },
        },
      };
    }

    return {
      shouldContinue: false,
      reply: { text: result.text },
    };
  }

  return {
    shouldContinue: false,
    reply: { text: buildCommandsMessage(params.cfg, skillCommands, { surface }) },
  };
};

export function buildCommandsPaginationKeyboard(
  currentPage: number,
  totalPages: number,
  agentId?: string,
): Array<Array<{ text: string; callback_data: string }>> {
  const buttons: Array<{ text: string; callback_data: string }> = [];
  const suffix = agentId ? `:${agentId}` : "";

  if (currentPage > 1) {
    buttons.push({
      text: "◀ Prev",
      callback_data: `commands_page_${currentPage - 1}${suffix}`,
    });
  }

  buttons.push({
    text: `${currentPage}/${totalPages}`,
    callback_data: `commands_page_noop${suffix}`,
  });

  if (currentPage < totalPages) {
    buttons.push({
      text: "Next ▶",
      callback_data: `commands_page_${currentPage + 1}${suffix}`,
    });
  }

  return [buttons];
}

export const handleStatusCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const statusRequested =
    params.directives.hasStatusDirective || params.command.commandBodyNormalized === "/status";
  if (!statusRequested) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /status from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  const reply = await buildStatusReply({
    cfg: params.cfg,
    command: params.command,
    sessionEntry: params.sessionEntry,
    sessionKey: params.sessionKey,
    parentSessionKey: params.ctx.ParentSessionKey,
    sessionScope: params.sessionScope,
    provider: params.provider,
    model: params.model,
    contextTokens: params.contextTokens,
    resolvedThinkLevel: params.resolvedThinkLevel,
    resolvedVerboseLevel: params.resolvedVerboseLevel,
    resolvedReasoningLevel: params.resolvedReasoningLevel,
    resolvedElevatedLevel: params.resolvedElevatedLevel,
    resolveDefaultThinkingLevel: params.resolveDefaultThinkingLevel,
    isGroup: params.isGroup,
    defaultGroupActivation: params.defaultGroupActivation,
    mediaDecisions: params.ctx.MediaUnderstandingDecisions,
  });
  return { shouldContinue: false, reply };
};

export const handleContextCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  if (normalized !== "/context" && !normalized.startsWith("/context ")) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /context from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  return { shouldContinue: false, reply: await buildContextReply(params) };
};

export const handleExportSessionCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  if (
    normalized !== "/export-session" &&
    !normalized.startsWith("/export-session ") &&
    normalized !== "/export" &&
    !normalized.startsWith("/export ")
  ) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /export-session from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  return { shouldContinue: false, reply: await buildExportSessionReply(params) };
};

export const handleWhoamiCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  if (params.command.commandBodyNormalized !== "/whoami") {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /whoami from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  const senderId = params.ctx.SenderId ?? "";
  const senderUsername = params.ctx.SenderUsername ?? "";
  const lines = ["🧭 Identity", `Channel: ${params.command.channel}`];
  if (senderId) {
    lines.push(`User id: ${senderId}`);
  }
  if (senderUsername) {
    const handle = senderUsername.startsWith("@") ? senderUsername : `@${senderUsername}`;
    lines.push(`Username: ${handle}`);
  }
  if (params.ctx.ChatType === "group" && params.ctx.From) {
    lines.push(`Chat: ${params.ctx.From}`);
  }
  if (params.ctx.MessageThreadId != null) {
    lines.push(`Thread: ${params.ctx.MessageThreadId}`);
  }
  if (senderId) {
    lines.push(`AllowFrom: ${senderId}`);
  }
  return { shouldContinue: false, reply: { text: lines.join("\n") } };
};
