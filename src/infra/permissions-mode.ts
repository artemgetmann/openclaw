import { resolveAgentConfig } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  normalizeExecAsk,
  normalizeExecSecurity,
  type ExecAsk,
  type ExecSecurity,
} from "./exec-approvals.js";

export type PermissionMode = "normal" | "full";

export type ResolvedPermissionMode =
  | {
      kind: PermissionMode;
      label: "Normal" | "Full Permissions";
      summary: string;
      execSecurity: ExecSecurity;
      execAsk: ExecAsk;
    }
  | {
      kind: "custom";
      label: "Custom";
      summary: string;
      execSecurity: ExecSecurity | null;
      execAsk: ExecAsk | null;
    };

export type ResolvedPermissionDefaults = {
  execSecurity: ExecSecurity;
  execAsk: ExecAsk;
};

export function resolvePermissionDefaults(params?: {
  config?: OpenClawConfig;
  agentId?: string | null;
}): ResolvedPermissionDefaults {
  const cfg = params?.config;
  const agentExec =
    cfg && params?.agentId ? resolveAgentConfig(cfg, params.agentId)?.tools?.exec : undefined;
  const globalExec = cfg?.tools?.exec;
  // Product default is broad local-operator execution unless the deployment
  // explicitly narrows it via global or per-agent exec settings.
  return {
    execSecurity: normalizeExecSecurity(agentExec?.security ?? globalExec?.security) ?? "full",
    execAsk: normalizeExecAsk(agentExec?.ask ?? globalExec?.ask) ?? "off",
  };
}

export function resolveDefaultPermissionMode(params?: {
  config?: OpenClawConfig;
  agentId?: string | null;
}): PermissionMode {
  const defaults = resolvePermissionDefaults(params);
  return defaults.execSecurity === "allowlist" ? "normal" : "full";
}

export function applyPermissionModeToSessionEntry(
  entry: SessionEntry,
  mode: PermissionMode,
): { updated: boolean } {
  const nextSecurity: ExecSecurity = mode === "normal" ? "allowlist" : "full";
  const nextAsk: ExecAsk = "off";
  let updated = false;

  if (entry.execSecurity !== nextSecurity) {
    entry.execSecurity = nextSecurity;
    updated = true;
  }
  if (entry.execAsk !== nextAsk) {
    entry.execAsk = nextAsk;
    updated = true;
  }
  if (updated) {
    entry.updatedAt = Date.now();
  }
  return { updated };
}

export function ensureDefaultPermissionModeOnSessionEntry(params: {
  entry: SessionEntry;
  config?: OpenClawConfig;
  agentId?: string | null;
}): { updated: boolean } {
  const security = normalizeExecSecurity(params.entry.execSecurity);
  const ask = normalizeExecAsk(params.entry.execAsk);
  if (security || ask) {
    return { updated: false };
  }
  const defaults = resolvePermissionDefaults({
    config: params.config,
    agentId: params.agentId,
  });
  let updated = false;
  if (params.entry.execSecurity !== defaults.execSecurity) {
    params.entry.execSecurity = defaults.execSecurity;
    updated = true;
  }
  if (params.entry.execAsk !== defaults.execAsk) {
    params.entry.execAsk = defaults.execAsk;
    updated = true;
  }
  if (updated) {
    params.entry.updatedAt = Date.now();
  }
  return { updated };
}

export function resolvePermissionMode(params: {
  config?: OpenClawConfig;
  agentId?: string | null;
  execSecurity?: string | null;
  execAsk?: string | null;
}): ResolvedPermissionMode {
  const defaults = resolvePermissionDefaults({
    config: params.config,
    agentId: params.agentId,
  });
  const security = normalizeExecSecurity(params.execSecurity) ?? defaults.execSecurity;
  const ask = normalizeExecAsk(params.execAsk) ?? defaults.execAsk;

  if (security === "allowlist" && ask === "off") {
    return modeToResolved("normal");
  }
  if (security === "full" && ask === "off") {
    return modeToResolved("full");
  }
  return {
    kind: "custom",
    label: "Custom",
    summary:
      "Custom exec settings are active here. `/permissions normal` restores direct-command mode; `/permissions full` enables full shell access.",
    execSecurity: security,
    execAsk: ask,
  };
}

export function buildPermissionModePromptHint(params: {
  config?: OpenClawConfig;
  agentId?: string | null;
  execSecurity?: string | null;
  execAsk?: string | null;
}): string {
  const mode = resolvePermissionMode(params);
  if (mode.kind === "full") {
    return [
      "Execution permissions for this chat: Full Permissions.",
      "Direct commands are still preferred, but shell wrappers and shell features such as bash -lc, sh -c, pipes, chaining, and redirection are allowed here.",
    ].join(" ");
  }
  if (mode.kind === "normal") {
    return [
      "Execution permissions for this chat: Normal.",
      "Direct commands are allowed when they can run as real tool invocations.",
      "Shell wrappers and shell features such as bash -lc, sh -c, pipes, chaining, and redirection are restricted here.",
      "If a shell wrapper is blocked, try the direct command form instead of telling the user to use Terminal.",
    ].join(" ");
  }
  return [
    "Execution permissions for this chat use a custom exec configuration.",
    "Prefer direct commands first, and do not default to sending the user to Terminal just because a shell wrapper is blocked.",
  ].join(" ");
}

function modeToResolved(
  mode: PermissionMode,
): Extract<ResolvedPermissionMode, { kind: PermissionMode }> {
  if (mode === "normal") {
    return {
      kind: "normal",
      label: "Normal",
      summary:
        "Direct commands are allowed. Shell wrappers, pipes, chaining, and redirection still require Full Permissions.",
      execSecurity: "allowlist",
      execAsk: "off",
    };
  }
  return {
    kind: "full",
    label: "Full Permissions",
    summary: "Shell wrappers and other riskier host commands are allowed in this chat.",
    execSecurity: "full",
    execAsk: "off",
  };
}
