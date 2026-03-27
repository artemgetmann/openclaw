import type { MsgContext } from "../../auto-reply/templating.js";
import type { SessionEntry, SessionMemoryScope } from "./types.js";

function normalizeScopeEntries(values?: Array<string | number>): {
  entries: string[];
  hasWildcard: boolean;
} {
  const entries = (values ?? [])
    .map((value) =>
      String(value ?? "")
        .trim()
        .replace(/^(telegram|tg):/i, ""),
    )
    .filter(Boolean);
  return {
    entries: entries.filter((value) => value !== "*"),
    hasWildcard: entries.includes("*"),
  };
}

function isDirectChat(chatType?: string): boolean {
  return (chatType ?? "").trim().toLowerCase() === "direct";
}

export function resolveSessionMemoryScope(ctx: MsgContext): SessionMemoryScope {
  const ownerAllow = normalizeScopeEntries(ctx.OwnerAllowFrom);
  const contextAllow = normalizeScopeEntries(ctx.ContextAllowFrom);
  const gatewayScopes = ctx.GatewayClientScopes ?? [];

  // Operator-admin internal traffic is explicitly trusted and should keep the
  // same memory affordances as the owner's local CLI/TUI surfaces.
  if (gatewayScopes.includes("operator.admin")) {
    return "personal";
  }

  // Wildcard or multi-party conversation allowlists cannot safely see personal
  // memory. The point of this helper is to prove trust, not to assume it.
  if (contextAllow.hasWildcard) {
    return "shared";
  }
  if (contextAllow.entries.length > 0) {
    if (ownerAllow.hasWildcard || ownerAllow.entries.length === 0) {
      return "shared";
    }
    const ownerSet = new Set(ownerAllow.entries);
    return contextAllow.entries.every((entry) => ownerSet.has(entry)) ? "personal" : "shared";
  }

  // Local/CLI/TUI and legacy direct sessions often have no allowlist metadata.
  // In that case we keep the historic behavior: direct chats are personal.
  return isDirectChat(ctx.ChatType) ? "personal" : "shared";
}

export function resolveStoredSessionMemoryScope(
  entry?: Pick<SessionEntry, "memoryScope" | "chatType">,
): SessionMemoryScope {
  if (entry?.memoryScope) {
    return entry.memoryScope;
  }
  return entry?.chatType === "direct" ? "personal" : "shared";
}
