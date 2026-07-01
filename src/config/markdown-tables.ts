import { normalizeChannelId as normalizePluginChannelId } from "../channels/plugins/index.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import { normalizeAccountId } from "../routing/session-key.js";
import type { OpenClawConfig } from "./config.js";
import type { MarkdownTableMode } from "./types.base.js";

type MarkdownConfigEntry = {
  markdown?: {
    tables?: MarkdownTableMode;
  };
};

type MarkdownConfigSection = MarkdownConfigEntry & {
  accounts?: Record<string, MarkdownConfigEntry>;
};

export const DEFAULT_TABLE_MODES = new Map<string, MarkdownTableMode>([
  // Telegram rich-message senders can render native table blocks; legacy callers
  // are normalized back to "code" below unless they opt into block support.
  ["telegram", "block"],
  ["signal", "bullets"],
  ["whatsapp", "bullets"],
  ["mattermost", "off"],
]);

const isMarkdownTableMode = (value: unknown): value is MarkdownTableMode =>
  value === "off" || value === "bullets" || value === "code" || value === "block";

function normalizeMarkdownChannelId(raw?: string | null): string | null {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  // Prefer plugin aliases when the channel registry is initialized, but keep
  // config defaults usable in lightweight render/test processes too.
  return normalizePluginChannelId(raw) ?? normalized;
}

function resolveMarkdownModeFromSection(
  section: MarkdownConfigSection | undefined,
  accountId?: string | null,
): MarkdownTableMode | undefined {
  if (!section) {
    return undefined;
  }
  const normalizedAccountId = normalizeAccountId(accountId);
  const accounts = section.accounts;
  if (accounts && typeof accounts === "object") {
    const match = resolveAccountEntry(accounts, normalizedAccountId);
    const matchMode = match?.markdown?.tables;
    if (isMarkdownTableMode(matchMode)) {
      return matchMode;
    }
  }
  const sectionMode = section.markdown?.tables;
  return isMarkdownTableMode(sectionMode) ? sectionMode : undefined;
}

export function resolveMarkdownTableMode(params: {
  cfg?: Partial<OpenClawConfig>;
  channel?: string | null;
  accountId?: string | null;
  supportsBlockTables?: boolean;
}): MarkdownTableMode {
  const channel = normalizeMarkdownChannelId(params.channel);
  const defaultMode = channel ? (DEFAULT_TABLE_MODES.get(channel) ?? "code") : "code";
  const normalizeForRenderer = (mode: MarkdownTableMode): MarkdownTableMode =>
    mode === "block" && params.supportsBlockTables !== true ? "code" : mode;
  if (!channel || !params.cfg) {
    return normalizeForRenderer(defaultMode);
  }
  const channelsConfig = params.cfg.channels as Record<string, unknown> | undefined;
  const section = (channelsConfig?.[channel] ??
    (params.cfg as Record<string, unknown> | undefined)?.[channel]) as
    | MarkdownConfigSection
    | undefined;
  const resolved = resolveMarkdownModeFromSection(section, params.accountId) ?? defaultMode;
  return normalizeForRenderer(resolved);
}
