import type { SessionEntry } from "../config/sessions.js";
import { normalizeProviderId } from "./model-selection.js";

export function getCliSessionId(
  entry: SessionEntry | undefined,
  provider: string,
): string | undefined {
  if (!entry) {
    return undefined;
  }
  const normalized = normalizeProviderId(provider);
  // Bridge sessions stay process-local on purpose so we never resume hidden
  // Claude state from a prior persisted CLI session id.
  if (normalized === "claude-bridge") {
    return undefined;
  }
  const fromMap = entry.cliSessionIds?.[normalized];
  if (fromMap?.trim()) {
    return fromMap.trim();
  }
  if (normalized === "claude-cli") {
    const legacy = entry.claudeCliSessionId?.trim();
    if (legacy) {
      return legacy;
    }
  }
  if (normalized === "claude-bridge") {
    const legacy = entry.claudeCliSessionId?.trim();
    if (legacy) {
      return legacy;
    }
  }
  return undefined;
}

export function setCliSessionId(entry: SessionEntry, provider: string, sessionId: string): void {
  const normalized = normalizeProviderId(provider);
  // Keep claude-bridge fresh across runs by refusing to persist CLI session ids.
  if (normalized === "claude-bridge") {
    return;
  }
  const trimmed = sessionId.trim();
  if (!trimmed) {
    return;
  }
  const existing = entry.cliSessionIds ?? {};
  entry.cliSessionIds = { ...existing };
  entry.cliSessionIds[normalized] = trimmed;
  if (normalized === "claude-cli") {
    entry.claudeCliSessionId = trimmed;
  }
}
