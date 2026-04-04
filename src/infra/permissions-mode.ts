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

export function resolveDefaultPermissionMode(params?: { channel?: string | null }): PermissionMode {
  const channel = params?.channel?.trim().toLowerCase();
  // Telegram is the consumer product surface, so default to the safer normal
  // mode there. Other runtimes keep the existing broader local-operator default
  // unless a chat/session explicitly overrides it.
  return channel === "telegram" ? "normal" : "full";
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
  channel?: string | null;
}): { updated: boolean } {
  const security = normalizeExecSecurity(params.entry.execSecurity);
  const ask = normalizeExecAsk(params.entry.execAsk);
  if (security || ask) {
    return { updated: false };
  }
  return applyPermissionModeToSessionEntry(params.entry, resolveDefaultPermissionMode(params));
}

export function resolvePermissionMode(params: {
  channel?: string | null;
  execSecurity?: string | null;
  execAsk?: string | null;
}): ResolvedPermissionMode {
  const security = normalizeExecSecurity(params.execSecurity);
  const ask = normalizeExecAsk(params.execAsk);
  const defaultMode = resolveDefaultPermissionMode({ channel: params.channel });

  if (!security && !ask) {
    return modeToResolved(defaultMode);
  }
  if (security === "allowlist" && (ask === "off" || ask === null)) {
    return modeToResolved("normal");
  }
  if (security === "full" && (ask === "off" || ask === null)) {
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
  channel?: string | null;
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
